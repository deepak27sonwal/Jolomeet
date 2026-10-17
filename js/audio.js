// Random audio call page: microphone → matchmaking → peer-to-peer voice call.
import { initApp, toast, storage } from './app.js';
import { STORAGE_KEYS } from './config.js';
import * as api from './api.js';
import { CallPeer, watchAudioLevel } from './rtc.js';
import { icon, esc, avatarHtml, friendlyError } from './ui.js';
import { confirmAction, openReportDialog } from './dialogs.js';

const MATCH_POLL_MS = 4000;
const READY_RESEND_MS = 2000;
const CONNECT_TIMEOUT_MS = 25_000;
const DISCONNECT_GRACE_MS = 8000;

const stage = document.getElementById('call-stage');
const remoteAudio = document.getElementById('remote-audio');

const state = {
  me: null,
  labels: {},
  mic: null,         // local MediaStream, kept between calls
  muted: false,
  search: null,      // { startedAt, timers, busy }
  call: null,        // the current match (see connect)
  screen: 'loading',
};

initApp();
init();

async function init() {
  let session = null;
  try {
    session = await api.getSession();
  } catch {
    /* treated as signed out */
  }
  if (!session) {
    window.location.replace(`login.html?next=${encodeURIComponent('audio.html')}`);
    return;
  }
  state.me = session.user;

  api.fetchInterests()
    .then((rows) => {
      state.labels = Object.fromEntries(rows.map((r) => [r.slug, r.label]));
      if (state.screen === 'start') renderStart();
    })
    .catch(() => {});

  stage.addEventListener('click', onStageClick);
  window.addEventListener('pagehide', leaveEverything);
  api.subscribeToInbox(state.me.id, {
    onMatched: () => { if (state.search) pollMatch(); },
    onSession: (session) => {
      if (state.call?.sessionId === session.id && session.status === 'ended' && session.ended_by !== state.me.id) {
        endCall('partner');
      }
    },
  }).catch(() => {});

  renderStart();
}

/* =========================================================================
   Screens
   ========================================================================= */

function setScreen(name, html) {
  state.screen = name;
  stage.dataset.screen = name;
  stage.setAttribute('aria-busy', 'false');
  stage.innerHTML = html;
}

function interests() {
  const saved = storage.get(STORAGE_KEYS.interests, []);
  return Array.isArray(saved) ? saved.filter((s) => typeof s === 'string').slice(0, 10) : [];
}

function chipsHtml(slugs, shared = []) {
  if (!slugs.length) return '';
  const sharedSet = new Set(shared);
  return `<ul class="chip-list" role="list">${slugs.map((s) =>
    `<li class="chip chip--static${sharedSet.has(s) ? ' chip--shared' : ''}">${esc(state.labels[s] || s)}</li>`).join('')}</ul>`;
}

function renderStart() {
  const mine = interests();
  setScreen('start', `
    <div class="call-orb" aria-hidden="true"><span class="call-orb__core">${icon('mic')}</span></div>
    <h1>Random Audio Call</h1>
    <p class="call-lead">Talk to someone new, voice only. No camera, no profile needed to start.</p>
    ${mine.length
      ? `<div class="call-interests"><p class="text-muted">Matching on your interests</p>${chipsHtml(mine)}</div>`
      : '<p class="text-muted call-tip">Tip: pick interests on the <a href="index.html#vibe-title">homepage</a> to talk with people who like the same things.</p>'}
    <button class="btn btn--primary btn--lg call-start" type="button" data-action="start">${icon('phone')}Start Audio Call</button>
    <p class="call-note">${icon('mic', 'icon icon--sm')}Your browser will ask to use your microphone.</p>`);
}

function renderSearching() {
  setScreen('searching', `
    <div class="call-orb call-orb--searching" aria-hidden="true"><span class="call-orb__core">${icon('phone')}</span></div>
    <h1>Finding someone to talk to…</h1>
    <p class="call-timer" id="search-timer">0:00</p>
    ${chipsHtml(interests())}
    <div class="call-actions">
      ${muteButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="cancel">Cancel</button>
    </div>`);
}

function renderConnecting() {
  const c = state.call;
  setScreen('connecting', `
    ${partnerHtml(c)}
    <p class="call-status">${icon('phone', 'icon icon--sm')}Connecting…</p>
    <div class="call-actions">
      ${muteButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="next">${icon('skip', 'icon icon--sm')}Next</button>
      <button class="call-hangup" type="button" data-action="end" aria-label="End call">${icon('phone-off')}</button>
    </div>`);
}

function renderLive() {
  const c = state.call;
  setScreen('live', `
    ${partnerHtml(c)}
    <p class="call-timer" id="call-timer" aria-label="Call duration">0:00</p>
    <div class="call-actions">
      ${muteButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="next">${icon('skip', 'icon icon--sm')}Next</button>
      <button class="call-hangup" type="button" data-action="end" aria-label="End call">${icon('phone-off')}</button>
    </div>
    <div class="call-more">
      <button class="btn btn--ghost btn--sm" type="button" data-action="report">${icon('flag', 'icon icon--sm')}Report</button>
      <button class="btn btn--ghost btn--sm" type="button" data-action="block">${icon('ban', 'icon icon--sm')}Block</button>
    </div>`);
  tickCallTimer();
}

function renderEnded(reason, { duration = 0, call = null } = {}) {
  const titles = {
    me: 'Call ended',
    partner: `${call?.name || 'They'} left the call`,
    lost: 'The connection dropped',
    failed: 'We couldn’t connect you',
    blocked: 'Call ended',
  };
  const notes = {
    failed: 'This can happen on strict work or school networks. Try someone else, or switch between Wi-Fi and mobile data.',
    lost: 'One of you may have lost your connection.',
    blocked: `${call?.name || 'This person'} is blocked. You won’t be matched with them again.`,
  };
  setScreen('ended', `
    <div class="call-orb call-orb--ended" aria-hidden="true"><span class="call-orb__core">${icon('phone-off')}</span></div>
    <h1>${esc(titles[reason] || titles.me)}</h1>
    ${duration >= 1 ? `<p class="call-timer">${formatDuration(duration)}</p>` : ''}
    ${notes[reason] ? `<p class="call-lead">${esc(notes[reason])}</p>` : ''}
    <div class="call-actions">
      <button class="btn btn--primary btn--lg" type="button" data-action="start">${icon('shuffle')}Find Someone New</button>
      <a class="btn btn--secondary btn--lg" href="index.html">Back Home</a>
    </div>
    ${call && reason !== 'blocked' ? `<button class="btn btn--ghost btn--sm" type="button" data-action="report-ended">${icon('flag', 'icon icon--sm')}Report ${esc(call.name)}</button>` : ''}`);
  state.lastCall = call;
}

function renderError(title, message, { retry = true } = {}) {
  setScreen('error', `
    <div class="call-orb call-orb--ended" aria-hidden="true"><span class="call-orb__core">${icon('alert')}</span></div>
    <h1>${esc(title)}</h1>
    <p class="call-lead">${esc(message)}</p>
    <div class="call-actions">
      ${retry ? `<button class="btn btn--primary btn--lg" type="button" data-action="start">${icon('refresh')}Try Again</button>` : ''}
      <a class="btn btn--secondary btn--lg" href="index.html">Back Home</a>
    </div>`);
}

function partnerHtml(c) {
  const age = c.age ? `<span class="text-muted">, ${esc(c.age)}</span>` : '';
  return `
    <div class="call-partner">
      <div class="call-voice" id="call-voice" aria-hidden="true">${avatarHtml(c.name, c.avatarUrl, 'call-avatar')}</div>
      <h1>${esc(c.name)}${age}</h1>
      ${c.shared.length ? `<p class="text-muted">You both like</p>${chipsHtml(c.shared, c.shared)}` : ''}
    </div>`;
}

function muteButtonHtml() {
  return `<button class="call-mute" type="button" data-action="mute" aria-pressed="${state.muted}"
    aria-label="${state.muted ? 'Unmute microphone' : 'Mute microphone'}">${icon(state.muted ? 'mic-off' : 'mic')}</button>`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/* =========================================================================
   Actions
   ========================================================================= */

function onStageClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const actions = {
    start: startSearch,
    cancel: cancelSearch,
    mute: toggleMute,
    next: () => endCall('me', { next: true }),
    end: () => endCall('me'),
    report: () => report(state.call),
    'report-ended': () => report(state.lastCall),
    block: block,
  };
  actions[button.dataset.action]?.();
}

async function ensureMicrophone() {
  if (state.mic?.getAudioTracks().some((t) => t.readyState === 'live')) return true;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    renderError('Calls aren’t supported here', 'Your browser can’t make voice calls. Try the latest Chrome, Safari, Edge or Firefox.', { retry: false });
    return false;
  }
  // the browser shows its own permission prompt; explain what it's for
  setScreen('permission', `
    <div class="call-orb" aria-hidden="true"><span class="call-orb__core">${icon('mic')}</span></div>
    <h1>Allow microphone access</h1>
    <p class="call-lead">Your browser is asking to use your microphone. Choose <strong>Allow</strong> so the other person can hear you.</p>`);
  try {
    state.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    state.mic.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
    return true;
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      renderError('Microphone access is blocked', 'Allow microphone access for this site in your browser settings, then try again.');
    } else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
      renderError('No microphone found', 'Connect a microphone or headset and try again.');
    } else if (error?.name === 'NotReadableError') {
      renderError('Your microphone is busy', 'Another app is using your microphone. Close it and try again.');
    } else {
      renderError('Couldn’t start your microphone', 'Please try again.');
    }
    return false;
  }
}

function toggleMute() {
  state.muted = !state.muted;
  state.mic?.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  stage.querySelectorAll('[data-action="mute"]').forEach((b) => b.outerHTML = muteButtonHtml());
  toast(state.muted ? 'Microphone muted' : 'Microphone on');
}

/* ---------- matchmaking ---------- */

async function startSearch() {
  if (!(await ensureMicrophone())) return;
  stopSearch();
  renderSearching();
  const search = { startedAt: Date.now(), timers: [], busy: false };
  state.search = search;
  search.timers.push(setInterval(() => {
    const el = document.getElementById('search-timer');
    if (el) el.textContent = formatDuration((Date.now() - search.startedAt) / 1000);
  }, 1000));
  search.timers.push(setInterval(pollMatch, MATCH_POLL_MS));
  pollMatch();
}

async function pollMatch() {
  const search = state.search;
  if (!search || search.busy) return;
  search.busy = true;
  let result;
  try {
    result = await api.requestMatch('audio', interests());
  } catch (error) {
    if (state.search !== search) return;
    stopSearch();
    if (error?.code === 'PGRST202') {
      renderError('Audio calls aren’t available yet', 'Matching hasn’t been switched on for JoloMeet yet. Please check back soon.', { retry: false });
    } else {
      renderError('Couldn’t start searching', friendlyError(error));
    }
    return;
  } finally {
    search.busy = false;
  }
  if (state.search !== search || result?.status !== 'matched' || !result.session_id) return;
  stopSearch();
  connect(result);
}

function stopSearch() {
  state.search?.timers.forEach(clearInterval);
  state.search = null;
}

function cancelSearch() {
  stopSearch();
  api.leaveMatchQueue().catch(() => {});
  releaseMicrophone();
  renderStart();
}

/* ---------- the call ---------- */

async function connect(match) {
  const call = {
    sessionId: match.session_id,
    conversationId: match.conversation_id,
    partnerId: match.partner_id,
    initiator: Boolean(match.is_initiator),
    shared: match.shared_interests || [],
    name: 'Someone new',
    avatarUrl: null,
    age: null,
    startedAt: 0,
    timers: [],
    peer: null,
    channel: null,
    stopLevel: null,
    ended: false,
  };
  state.call = call;
  renderConnecting();

  api.getProfile(call.partnerId).then((p) => {
    if (!p || state.call !== call) return;
    call.name = p.display_name || call.name;
    call.avatarUrl = api.publicImageUrl('avatars', p.avatar_path);
    call.age = p.age;
    if (state.screen === 'connecting') renderConnecting();
    if (state.screen === 'live') renderLive();
  }).catch(() => {});

  call.peer = new CallPeer({
    stream: state.mic,
    initiator: call.initiator,
    send: (payload) => call.channel?.send(payload),
    onRemoteStream: (stream) => {
      remoteAudio.srcObject = stream;
      remoteAudio.play().catch(() => {});
      call.stopLevel?.();
      call.stopLevel = watchAudioLevel(stream, (level) => {
        document.getElementById('call-voice')?.style.setProperty('--level', level.toFixed(3));
      });
    },
    onState: (pcState) => onPeerState(call, pcState),
  });

  try {
    call.channel = await api.joinMatchChannel(call.sessionId, (message) => {
      if (state.call !== call) return;
      if (message?.kind === 'bye') {
        endCall('partner');
        return;
      }
      call.peer.handle(message).catch(() => {});
    }, (status) => {
      if (state.call !== call) return;
      if (status === 'SUBSCRIBED') {
        call.peer.announce();
        // keep saying hello until the other side answers (they may join a moment later)
        call.timers.push(setInterval(() => { if (!call.peer.negotiating) call.peer.announce(); }, READY_RESEND_MS));
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        endCall('failed');
      }
    });
  } catch {
    endCall('failed');
    return;
  }

  call.timers.push(setTimeout(() => {
    if (state.call === call && !call.startedAt) endCall('failed');
  }, CONNECT_TIMEOUT_MS));
}

function onPeerState(call, pcState) {
  if (state.call !== call) return;
  if (pcState === 'connected') {
    clearTimeout(call.dropTimer);
    if (!call.startedAt) {
      call.startedAt = Date.now();
      renderLive();
      call.timers.push(setInterval(tickCallTimer, 1000));
    }
  } else if (pcState === 'disconnected') {
    // brief network blips recover on their own
    clearTimeout(call.dropTimer);
    call.dropTimer = setTimeout(() => endCall(call.startedAt ? 'lost' : 'failed'), DISCONNECT_GRACE_MS);
  } else if (pcState === 'failed') {
    endCall(call.startedAt ? 'lost' : 'failed');
  }
}

function tickCallTimer() {
  const call = state.call;
  const el = document.getElementById('call-timer');
  if (call?.startedAt && el) el.textContent = formatDuration((Date.now() - call.startedAt) / 1000);
}

/**
 * Hangs up and tells the server. reason: 'me' | 'partner' | 'lost' | 'failed' | 'blocked'.
 * With next: true, goes straight back to searching.
 */
async function endCall(reason, { next = false } = {}) {
  const call = state.call;
  if (!call || call.ended) return;
  call.ended = true;
  state.call = null;
  const duration = call.startedAt ? (Date.now() - call.startedAt) / 1000 : 0;

  if (reason !== 'partner') call.channel?.send({ kind: 'bye' });
  teardown(call);
  const serverReason = { me: next ? 'next' : 'ended', partner: 'ended', lost: 'disconnected', failed: 'disconnected', blocked: 'ended' }[reason];
  if (reason !== 'partner') api.endMatchSession(call.sessionId, serverReason).catch(() => {});

  if (next) {
    startSearch();
    return;
  }
  releaseMicrophone(); // don't keep the mic (and the browser's "in use" light) on between calls
  renderEnded(reason, { duration, call: { name: call.name, partnerId: call.partnerId, sessionId: call.sessionId, conversationId: call.conversationId } });
}

function teardown(call) {
  call.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  clearTimeout(call.dropTimer);
  call.stopLevel?.();
  call.peer?.close();
  // let the bye message go out before leaving the channel
  setTimeout(() => call.channel?.leave(), 300);
  remoteAudio.srcObject = null;
}

function releaseMicrophone() {
  state.mic?.getTracks().forEach((t) => t.stop());
  state.mic = null;
}

function leaveEverything() {
  if (state.search) api.leaveMatchQueue().catch(() => {});
  if (state.call) {
    const call = state.call;
    call.channel?.send({ kind: 'bye' });
    api.endMatchSession(call.sessionId, 'ended').catch(() => {});
    teardown(call);
  }
  releaseMicrophone();
}

/* ---------- safety ---------- */

function report(call) {
  if (!call?.partnerId) return;
  openReportDialog({
    name: call.name,
    onSubmit: async ({ reason, details, alsoBlock }) => {
      await api.reportUser({
        reportedUserId: call.partnerId,
        context: 'audio_call',
        reason,
        details,
        conversationId: call.conversationId,
        sessionId: call.sessionId,
      });
      if (alsoBlock) await blockPartner(call);
      toast('Thanks. Our moderators will review your report.', { type: 'success' });
    },
  });
}

async function block() {
  const call = state.call;
  if (!call) return;
  const ok = await confirmAction({
    title: `Block ${call.name}?`,
    message: 'This ends the call. You won’t be matched with them again, and they can’t message or call you.',
    confirmLabel: 'Block',
  });
  if (!ok) return;
  try {
    await blockPartner(call);
    toast(`${call.name} is blocked.`);
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  }
}

async function blockPartner(call) {
  try {
    await api.blockUser(state.me.id, call.partnerId);
  } catch (error) {
    if (error?.code !== '23505') throw error; // already blocked
  }
  if (state.call === call) endCall('blocked');
  else if (state.screen === 'ended') renderEnded('blocked', { call });
}
