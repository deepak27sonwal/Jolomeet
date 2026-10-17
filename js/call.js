// Random audio and video calls (audio.html, video.html):
// camera/microphone → matchmaking → peer-to-peer call.
// The page picks the mode with <body data-mode="audio|video">.
import { initApp, toast, storage } from './app.js';
import { STORAGE_KEYS } from './config.js';
import * as api from './api.js';
import { CallPeer, watchAudioLevel } from './rtc.js';
import { icon, esc, avatarHtml, friendlyError } from './ui.js';
import { confirmAction, openReportDialog } from './dialogs.js';

const MODE = document.body.dataset.mode === 'video' ? 'video' : 'audio';
const VIDEO = MODE === 'video';
const MATCH_POLL_MS = 4000;
const READY_RESEND_MS = 2000;
const CONNECT_TIMEOUT_MS = 25_000;
const DISCONNECT_GRACE_MS = 8000;
const MEDIA_SCREENS = ['searching', 'connecting', 'live'];

const COPY = {
  audio: {
    title: 'Random Audio Call',
    lead: 'Talk to someone new, voice only. No camera, no profile needed to start.',
    start: 'Start Audio Call',
    startIcon: 'phone',
    orb: 'mic',
    note: 'Your browser will ask to use your microphone.',
    permissionTitle: 'Allow microphone access',
    permissionLead: 'Your browser is asking to use your microphone. Choose <strong>Allow</strong> so the other person can hear you.',
    blockedTitle: 'Microphone access is blocked',
    blockedLead: 'Allow microphone access for this site in your browser settings, then try again.',
    searching: 'Finding someone to talk to…',
    reportContext: 'audio_call',
  },
  video: {
    title: 'Random Video Chat',
    lead: 'Meet someone new face to face. You can turn your camera off at any time.',
    start: 'Start Video Chat',
    startIcon: 'video',
    orb: 'video',
    note: 'Your browser will ask to use your camera and microphone.',
    permissionTitle: 'Allow camera and microphone',
    permissionLead: 'Your browser is asking to use your camera and microphone. Choose <strong>Allow</strong> so the other person can see and hear you.',
    blockedTitle: 'Camera and microphone are blocked',
    blockedLead: 'Allow camera and microphone access for this site in your browser settings, then try again.',
    searching: 'Finding someone to meet…',
    reportContext: 'video_call',
  },
}[MODE];

const stage = document.getElementById('call-stage');
const screen = document.getElementById('call-screen');       // video only
const remoteVideo = document.getElementById('remote-video'); // video only
const localVideo = document.getElementById('local-video');   // video only
const selfTile = document.getElementById('self-tile');       // video only
const remoteOff = document.getElementById('remote-off');     // video only
const remoteAudio = document.getElementById('remote-audio'); // audio only

const state = {
  me: null,
  labels: {},
  media: null,       // local MediaStream, kept between calls while searching
  muted: false,
  cameraOff: false,
  facing: 'user',
  canSwitchCamera: false,
  search: null,      // { startedAt, timers, busy }
  call: null,        // the current match (see connect)
  lastCall: null,
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
    const page = window.location.pathname.split('/').pop() || `${MODE}.html`;
    window.location.replace(`login.html?next=${encodeURIComponent(page)}`);
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
  if (VIDEO) {
    const media = MEDIA_SCREENS.includes(name);
    screen.dataset.screen = name;
    screen.classList.toggle('is-media', media);
    document.body.classList.toggle('in-call', media);
    updateRemoteOff();
  }
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
    <div class="call-orb" aria-hidden="true"><span class="call-orb__core">${icon(COPY.orb)}</span></div>
    <h1>${COPY.title}</h1>
    <p class="call-lead">${COPY.lead}</p>
    ${mine.length
      ? `<div class="call-interests"><p class="text-muted">Matching on your interests</p>${chipsHtml(mine)}</div>`
      : '<p class="text-muted call-tip">Tip: pick interests on the <a href="index.html#vibe-title">homepage</a> to meet people who like the same things.</p>'}
    <button class="btn btn--primary btn--lg call-start" type="button" data-action="start">${icon(COPY.startIcon)}${COPY.start}</button>
    <p class="call-note">${icon(COPY.orb, 'icon icon--sm')}${COPY.note}</p>`);
}

function renderSearching() {
  if (VIDEO) {
    setScreen('searching', `
      <div class="call-overlay call-overlay--center">
        <span class="call-searching-dot" aria-hidden="true"></span>
        <h1>${COPY.searching}</h1>
        <p class="call-timer" id="search-timer">0:00</p>
        ${chipsHtml(interests())}
      </div>
      <div class="call-controls">
        ${muteButtonHtml()}${cameraButtonHtml()}${switchButtonHtml()}
        <button class="btn btn--secondary" type="button" data-action="cancel">Cancel</button>
      </div>`);
    return;
  }
  setScreen('searching', `
    <div class="call-orb call-orb--searching" aria-hidden="true"><span class="call-orb__core">${icon('phone')}</span></div>
    <h1>${COPY.searching}</h1>
    <p class="call-timer" id="search-timer">0:00</p>
    ${chipsHtml(interests())}
    <div class="call-actions">
      ${muteButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="cancel">Cancel</button>
    </div>`);
}

function renderConnecting() {
  if (VIDEO) {
    setScreen('connecting', `${hudHtml(state.call, false)}${videoControlsHtml()}`);
    return;
  }
  setScreen('connecting', `
    ${partnerHtml(state.call)}
    <p class="call-status">${icon('phone', 'icon icon--sm')}Connecting…</p>
    <div class="call-actions">
      ${muteButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="next">${icon('skip', 'icon icon--sm')}Next</button>
      <button class="call-hangup" type="button" data-action="end" aria-label="End call">${icon('phone-off')}</button>
    </div>`);
}

function renderLive() {
  if (VIDEO) {
    setScreen('live', `${hudHtml(state.call, true)}${videoControlsHtml()}`);
    tickCallTimer();
    return;
  }
  setScreen('live', `
    ${partnerHtml(state.call)}
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

/** Video: name, timer and safety buttons over the other person's video. */
function hudHtml(c, live) {
  const age = c.age ? `, ${esc(c.age)}` : '';
  return `
    <div class="call-hud">
      <div class="call-hud__who">
        ${avatarHtml(c.name, c.avatarUrl)}
        <div>
          <strong>${esc(c.name)}${age}</strong>
          <span>${live ? '<span id="call-timer" aria-label="Call duration">0:00</span>' : 'Connecting…'}${c.remoteMuted ? ` · ${icon('mic-off', 'icon icon--sm')} Muted` : ''}</span>
        </div>
      </div>
      <div class="call-hud__safety">
        <button class="call-icon-btn" type="button" data-action="report" aria-label="Report ${esc(c.name)}" title="Report">${icon('flag')}</button>
        <button class="call-icon-btn" type="button" data-action="block" aria-label="Block ${esc(c.name)}" title="Block">${icon('ban')}</button>
      </div>
    </div>
    ${c.shared.length ? `<div class="call-hud__shared"><span>You both like</span>${chipsHtml(c.shared, c.shared)}</div>` : ''}`;
}

function videoControlsHtml() {
  return `
    <div class="call-controls">
      ${muteButtonHtml()}${cameraButtonHtml()}${switchButtonHtml()}
      <button class="btn btn--secondary" type="button" data-action="next">${icon('skip', 'icon icon--sm')}Next</button>
      <button class="call-hangup" type="button" data-action="end" aria-label="End call">${icon('phone-off')}</button>
    </div>`;
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
    <div class="call-orb call-orb--ended" aria-hidden="true"><span class="call-orb__core">${icon(VIDEO ? 'video' : 'phone-off')}</span></div>
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

function renderError(title, message, { retry = true, extra = '' } = {}) {
  setScreen('error', `
    <div class="call-orb call-orb--ended" aria-hidden="true"><span class="call-orb__core">${icon('alert')}</span></div>
    <h1>${esc(title)}</h1>
    <p class="call-lead">${esc(message)}</p>
    <div class="call-actions">
      ${retry ? `<button class="btn btn--primary btn--lg" type="button" data-action="start">${icon('refresh')}Try Again</button>` : ''}
      ${extra}
      <a class="btn btn--secondary btn--lg" href="index.html">Back Home</a>
    </div>`);
}

/** Audio: big avatar with a ring that moves with the other person's voice. */
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
    aria-label="${state.muted ? 'Unmute microphone' : 'Mute microphone'}" title="${state.muted ? 'Unmute' : 'Mute'}">${icon(state.muted ? 'mic-off' : 'mic')}</button>`;
}

function cameraButtonHtml() {
  if (!VIDEO) return '';
  return `<button class="call-mute" type="button" data-action="camera" aria-pressed="${state.cameraOff}"
    aria-label="${state.cameraOff ? 'Turn camera on' : 'Turn camera off'}" title="${state.cameraOff ? 'Camera on' : 'Camera off'}">${icon(state.cameraOff ? 'video-off' : 'video')}</button>`;
}

function switchButtonHtml() {
  if (!VIDEO || !state.canSwitchCamera) return '';
  return `<button class="call-mute" type="button" data-action="switch-camera" aria-label="Switch camera" title="Switch camera">${icon('refresh')}</button>`;
}

function refreshControls() {
  stage.querySelectorAll('[data-action="mute"]').forEach((b) => { b.outerHTML = muteButtonHtml(); });
  stage.querySelectorAll('[data-action="camera"]').forEach((b) => { b.outerHTML = cameraButtonHtml(); });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** Video: the other person's tile shows their picture while connecting or when their camera is off. */
function updateRemoteOff() {
  if (!VIDEO) return;
  const c = state.call;
  const show = Boolean(c) && (state.screen === 'connecting' || (state.screen === 'live' && c.remoteCameraOff));
  remoteOff.hidden = !show;
  if (show) {
    remoteOff.innerHTML = `${avatarHtml(c.name, c.avatarUrl, 'call-avatar')}<p>${state.screen === 'connecting' ? 'Connecting…' : `${esc(c.name)} turned their camera off`}</p>`;
  }
  selfTile.classList.toggle('is-off', state.cameraOff);
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
    camera: toggleCamera,
    'switch-camera': switchCamera,
    next: () => endCall('me', { next: true }),
    end: () => endCall('me'),
    report: () => report(state.call),
    'report-ended': () => report(state.lastCall),
    block,
  };
  actions[button.dataset.action]?.();
}

function mediaIsLive() {
  return Boolean(state.media?.getTracks().some((t) => t.readyState === 'live'));
}

async function ensureMedia() {
  if (mediaIsLive()) return true;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    renderError('Calls aren’t supported here', 'Your browser can’t make calls. Try the latest Chrome, Safari, Edge or Firefox.', { retry: false });
    return false;
  }
  // the browser shows its own permission prompt; explain what it's for
  setScreen('permission', `
    <div class="call-orb" aria-hidden="true"><span class="call-orb__core">${icon(COPY.orb)}</span></div>
    <h1>${COPY.permissionTitle}</h1>
    <p class="call-lead">${COPY.permissionLead}</p>`);
  try {
    state.media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: VIDEO ? { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (error) {
    showMediaError(error);
    return false;
  }
  state.media.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  state.media.getVideoTracks().forEach((t) => { t.enabled = !state.cameraOff; });
  if (VIDEO) {
    localVideo.srcObject = state.media;
    localVideo.classList.toggle('is-mirrored', state.facing === 'user');
    localVideo.play().catch(() => {});
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.canSwitchCamera = devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
      state.canSwitchCamera = false;
    }
  }
  return true;
}

function showMediaError(error) {
  const audioInstead = VIDEO ? '<a class="btn btn--secondary btn--lg" href="audio.html">Try an Audio Call</a>' : '';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    renderError(COPY.blockedTitle, COPY.blockedLead);
  } else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
    renderError(VIDEO ? 'No camera found' : 'No microphone found',
      VIDEO ? 'Connect a camera, or have a voice-only call instead.' : 'Connect a microphone or headset and try again.',
      { extra: audioInstead });
  } else if (error?.name === 'NotReadableError') {
    renderError(VIDEO ? 'Your camera is busy' : 'Your microphone is busy',
      `Another app is using your ${VIDEO ? 'camera or microphone' : 'microphone'}. Close it and try again.`);
  } else {
    renderError(`Couldn’t start your ${VIDEO ? 'camera' : 'microphone'}`, 'Please try again.');
  }
}

function toggleMute() {
  state.muted = !state.muted;
  state.media?.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  refreshControls();
  sendMediaState();
  toast(state.muted ? 'Microphone muted' : 'Microphone on');
}

function toggleCamera() {
  state.cameraOff = !state.cameraOff;
  state.media?.getVideoTracks().forEach((t) => { t.enabled = !state.cameraOff; });
  refreshControls();
  updateRemoteOff();
  sendMediaState();
  toast(state.cameraOff ? 'Camera off' : 'Camera on');
}

/** Front ↔ back camera on phones; the call keeps going on the new track. */
async function switchCamera() {
  if (!state.media) return;
  const facing = state.facing === 'user' ? 'environment' : 'user';
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } }, audio: false });
  } catch {
    toast('Couldn’t switch camera.', { type: 'error' });
    return;
  }
  const [track] = fresh.getVideoTracks();
  track.enabled = !state.cameraOff;
  state.media.getVideoTracks().forEach((old) => { old.stop(); state.media.removeTrack(old); });
  state.media.addTrack(track);
  state.facing = facing;
  localVideo.srcObject = state.media;
  localVideo.classList.toggle('is-mirrored', facing === 'user');
  await state.call?.peer?.replaceTrack('video', track).catch(() => {});
}

/** Lets the other side show "Muted" / "camera off" instead of silence or a black frame. */
function sendMediaState() {
  state.call?.channel?.send({ kind: 'media', muted: state.muted, cameraOff: state.cameraOff });
}

/* ---------- matchmaking ---------- */

async function startSearch() {
  if (!(await ensureMedia())) return;
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
    result = await api.requestMatch(MODE, interests());
  } catch (error) {
    if (state.search !== search) return;
    stopSearch();
    releaseMedia();
    if (error?.code === 'PGRST202') {
      renderError(`${VIDEO ? 'Video chat isn’t' : 'Audio calls aren’t'} available yet`,
        'Matching hasn’t been switched on for JoloMeet yet. Please check back soon.', { retry: false });
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
  releaseMedia();
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
    remoteMuted: false,
    remoteCameraOff: false,
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
    rerenderCall(call);
  }).catch(() => {});

  call.peer = new CallPeer({
    stream: state.media,
    initiator: call.initiator,
    send: (payload) => call.channel?.send(payload),
    onRemoteStream: (stream) => {
      if (VIDEO) {
        remoteVideo.srcObject = stream;
        remoteVideo.play().catch(() => {});
        return;
      }
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
      } else if (message?.kind === 'media') {
        call.remoteMuted = Boolean(message.muted);
        call.remoteCameraOff = Boolean(message.cameraOff);
        rerenderCall(call);
      } else {
        call.peer.handle(message).catch(() => {});
      }
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

function rerenderCall(call) {
  if (state.call !== call) return;
  if (state.screen === 'connecting') renderConnecting();
  if (state.screen === 'live') renderLive();
}

function onPeerState(call, pcState) {
  if (state.call !== call) return;
  if (pcState === 'connected') {
    clearTimeout(call.dropTimer);
    if (!call.startedAt) {
      call.startedAt = Date.now();
      renderLive();
      sendMediaState();
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
  releaseMedia(); // don't keep the camera/mic (and the browser's "in use" light) on between calls
  renderEnded(reason, { duration, call: { name: call.name, partnerId: call.partnerId, sessionId: call.sessionId, conversationId: call.conversationId } });
}

function teardown(call) {
  call.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  clearTimeout(call.dropTimer);
  call.stopLevel?.();
  call.peer?.close();
  // let the bye message go out before leaving the channel
  setTimeout(() => call.channel?.leave(), 300);
  if (remoteAudio) remoteAudio.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
}

function releaseMedia() {
  state.media?.getTracks().forEach((t) => t.stop());
  state.media = null;
  if (localVideo) localVideo.srcObject = null;
}

function leaveEverything() {
  if (state.search) api.leaveMatchQueue().catch(() => {});
  if (state.call) {
    const call = state.call;
    call.channel?.send({ kind: 'bye' });
    api.endMatchSession(call.sessionId, 'ended').catch(() => {});
    teardown(call);
  }
  releaseMedia();
}

/* ---------- safety ---------- */

function report(call) {
  if (!call?.partnerId) return;
  openReportDialog({
    name: call.name,
    onSubmit: async ({ reason, details, alsoBlock }) => {
      await api.reportUser({
        reportedUserId: call.partnerId,
        context: COPY.reportContext,
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
