// Random audio and video calls (audio.html, video.html):
// camera/microphone → matchmaking → peer-to-peer call.
// The page picks the mode with <body data-mode="audio|video">.
import { initApp, toast } from './app.js';
import * as api from './api.js';
import { CallPeer, watchAudioLevel } from './rtc.js';
import { icon, esc, avatarHtml, friendlyError } from './ui.js';
import { confirmAction, openReportDialog } from './dialogs.js';
import { askAboutYou } from './quick-start.js';
import { questionFor } from './icebreakers.js';
import { interestPickerHtml, mountInterestPicker, savedInterests } from './interest-picker.js';

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
const chatPanel = document.getElementById('call-chat');      // video only
const chatList = document.getElementById('call-chat-list');
const chatForm = document.getElementById('call-chat-form');
const chatInput = document.getElementById('call-chat-input');

const state = {
  me: null,
  labels: {},
  media: null,       // local MediaStream, kept between calls while searching
  muted: false,
  cameraOff: false,
  facing: 'user',
  canSwitchCamera: false,
  switchingCamera: false,
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
  // random calls need no account: ask for a name, gender and age, then go straight in
  if (!session) {
    stage.dataset.screen = 'about-you';
    stage.setAttribute('aria-busy', 'false');
    session = await askAboutYou(stage, { action: 'Continue', next: `${MODE}.html` });
  }
  state.me = session.user;

  api.fetchInterests()
    .then((rows) => {
      state.labels = Object.fromEntries(rows.map((r) => [r.slug, r.label]));
    })
    .catch(() => {});

  stage.addEventListener('click', onStageClick);
  if (chatPanel) bindCallChat();
  window.addEventListener('pagehide', leaveEverything);
  api.subscribeToInbox(state.me.id, {
    onMatched: () => { if (state.search) pollMatch(); },
    onMessage: (message) => onCallMessage(message),
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
  return savedInterests();
}

function chipsHtml(slugs, shared = []) {
  if (!slugs.length) return '';
  const sharedSet = new Set(shared);
  return `<ul class="chip-list" role="list">${slugs.map((s) =>
    `<li class="chip chip--static${sharedSet.has(s) ? ' chip--shared' : ''}">${esc(state.labels[s] || s)}</li>`).join('')}</ul>`;
}

function renderStart() {
  setScreen('start', `
    <div class="call-orb" aria-hidden="true"><span class="call-orb__core">${icon(COPY.orb)}</span></div>
    <h1>${COPY.title}</h1>
    <p class="call-lead">${COPY.lead}</p>
    ${interestPickerHtml()}
    <button class="btn btn--primary btn--lg call-start" type="button" data-action="start">${icon(COPY.startIcon)}${COPY.start}</button>
    <p class="call-note">${icon(COPY.orb, 'icon icon--sm')}${COPY.note}</p>`);
  mountInterestPicker(stage);
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
    setScreen('live', `${hudHtml(state.call, true)}${revealCardHtml(state.call)}${icebreakerHtml(state.call)}${videoControlsHtml(true)}`);
    tickCallTimer();
    return;
  }
  setScreen('live', `
    ${partnerHtml(state.call)}
    <p class="call-timer" id="call-timer" aria-label="Call duration">0:00</p>
    ${icebreakerHtml(state.call)}
    <div class="call-actions">
      ${muteButtonHtml()}${stayButtonHtml(state.call)}
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
  const age = (c.age ? `, ${esc(c.age)}` : '') + (c.gender ? ` · ${esc(c.gender)}` : '');
  return `
    <div class="call-hud">
      <div class="call-hud__who">
        ${avatarHtml(c.name, c.avatarUrl)}
        <div>
          <strong>${esc(c.name)}${age}</strong>
          <span>${live ? '<span id="call-timer" aria-label="Call duration">0:00</span>' : 'Connecting…'}${c.remoteMuted ? ` · ${icon('mic-off', 'icon icon--sm')} Muted` : ''}${c.mutual ? ` · ${icon('heart', 'icon icon--sm is-filled')} Mutual` : ''}</span>
        </div>
      </div>
      <div class="call-hud__safety">
        <button class="call-icon-btn" type="button" data-action="report" aria-label="Report ${esc(c.name)}" title="Report">${icon('flag')}</button>
        <button class="call-icon-btn" type="button" data-action="block" aria-label="Block ${esc(c.name)}" title="Block">${icon('ban')}</button>
      </div>
    </div>
    ${c.shared.length ? `<div class="call-hud__shared"><span>You both like</span>${chipsHtml(c.shared, c.shared)}</div>` : ''}`;
}

function videoControlsHtml(live = false) {
  const c = state.call;
  const extra = live && c ? `${chatButtonHtml(c)}${stayButtonHtml(c)}${c.icebreakerClosed
    ? `<button class="call-mute" type="button" data-action="icebreaker-open" aria-label="Show an icebreaker question" title="Icebreaker">${icon('dice')}</button>` : ''}` : '';
  return `
    <div class="call-controls">
      ${muteButtonHtml()}${cameraButtonHtml()}${switchButtonHtml()}${extra}
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
    ${call && reason !== 'blocked' ? endedStayHtml(call) : ''}
    ${call?.chatted && call.conversationId ? `<a class="call-note call-saved-chat" href="chat.html?c=${encodeURIComponent(call.conversationId)}">${icon('chat', 'icon icon--sm')}Your chat with ${esc(call.name)} is saved in Chats</a>` : ''}
    ${call && reason !== 'blocked' ? `<button class="btn btn--ghost btn--sm" type="button" data-action="report-ended">${icon('flag', 'icon icon--sm')}Report ${esc(call.name)}</button>` : ''}`);
  state.lastCall = call;
}

/* ---------- signature features: icebreakers, stay in touch, reveal together ---------- */

/** Shared question card: both people see the same one; "New question" changes it for both. */
function icebreakerHtml(c) {
  if (!c?.startedAt || c.icebreakerClosed) return '';
  return `
    <div class="call-icebreaker" role="note" aria-label="Icebreaker question">
      <p class="call-icebreaker__label">${icon('dice', 'icon icon--sm')}Icebreaker</p>
      <p class="call-icebreaker__q" id="icebreaker-q">${esc(questionFor(c.sessionId, c.icebreaker))}</p>
      <div class="call-icebreaker__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="icebreaker-next">${icon('refresh', 'icon icon--sm')}New question</button>
        ${VIDEO ? '<button class="btn btn--ghost btn--sm" type="button" data-action="icebreaker-close">Hide</button>' : ''}
      </div>
    </div>`;
}

function stayButtonHtml(c) {
  if (!c) return '';
  const on = Boolean(c.liked || c.mutual);
  const label = c.mutual ? 'It’s mutual: you’re staying in touch'
    : c.liked ? 'You’d like to stay in touch (only you can see this)' : 'Stay in touch';
  return `<button class="call-mute call-stay${on ? ' is-on' : ''}" type="button" data-action="stay" aria-pressed="${on}"
    aria-label="${label}" title="${label}">${icon('heart', `icon${on ? ' is-filled' : ''}`)}</button>`;
}

/** End screen: keep in touch with the person you just talked to, or what happened if you both did. */
function endedStayHtml(call) {
  const name = esc(call.name);
  if (call.mutual === 'mutual') {
    return `<div class="call-mutual">${icon('heart', 'icon is-filled')}<p><strong>It’s mutual!</strong> You and ${name} are connected.</p>
      <button class="btn btn--primary" type="button" data-action="open-direct">${icon('chat', 'icon icon--sm')}Open Chat</button></div>`;
  }
  if (call.mutual === 'mutual_needs_account') {
    return state.me.is_anonymous
      ? `<div class="call-mutual">${icon('heart', 'icon is-filled')}<p><strong>It’s mutual!</strong> Create a free account to stay in touch with ${name}.</p>
          <a class="btn btn--primary" href="register.html">Create Free Account</a></div>`
      : `<div class="call-mutual">${icon('heart', 'icon is-filled')}<p><strong>It’s mutual!</strong> You’ll be connected with ${name} as soon as they create an account.</p></div>`;
  }
  if (call.liked) {
    return `<p class="call-note">${icon('heart', 'icon icon--sm is-filled')}You’d like to stay in touch. If ${name} taps the heart too, you’ll be connected.</p>`;
  }
  return `<button class="btn btn--secondary" type="button" data-action="stay-ended">${icon('heart', 'icon icon--sm')}Stay in touch with ${name}</button>`;
}

function bothRevealed(c) {
  return !VIDEO || Boolean(c?.iRevealed && c?.theyRevealed);
}

/** Video: nobody's camera reaches the other person until both have tapped Reveal. */
function revealCardHtml(c) {
  if (!VIDEO || !c || bothRevealed(c)) return '';
  const name = esc(c.name);
  let text;
  if (c.iRevealed) text = `Waiting for ${name} to tap Reveal…`;
  else if (c.theyRevealed) text = `${name} is ready. Tap Reveal to turn on video for both of you.`;
  else text = 'Say hi first 👋 Video turns on when you both tap Reveal. Voice is already on.';
  return `
    <div class="call-reveal" role="note">
      <p>${text}</p>
      ${c.iRevealed ? '' : `<button class="btn btn--primary" type="button" data-action="reveal">${icon('eye', 'icon icon--sm')}Reveal my video</button>`}
    </div>`;
}

/** Sends your camera to the other person only once you have both revealed. */
async function applyReveal(c) {
  if (!VIDEO || !c?.peer) return;
  const track = bothRevealed(c) ? state.media?.getVideoTracks()[0] || null : null;
  await c.peer.replaceTrack('video', track).catch(() => {});
  remoteVideo.classList.toggle('is-veiled', !bothRevealed(c));
}

function reveal() {
  const c = state.call;
  if (!c || c.iRevealed) return;
  c.iRevealed = true;
  c.channel?.send({ kind: 'reveal' });
  applyReveal(c);
  rerenderCall(c);
  if (bothRevealed(c)) toast('Video is on for both of you.');
}

function nextIcebreaker() {
  const c = state.call;
  if (!c) return;
  c.icebreaker += 1;
  c.channel?.send({ kind: 'icebreaker', offset: c.icebreaker });
  showIcebreaker(c);
}

function showIcebreaker(c) {
  const q = document.getElementById('icebreaker-q');
  if (q) q.textContent = questionFor(c.sessionId, c.icebreaker);
  else rerenderCall(c);
}

async function stayInTouch(call) {
  if (!call?.sessionId || call.mutual) return;
  if (call.liked) {
    toast('You’ve said you’d like to stay in touch. If they tap the heart too, you’ll both be connected.');
    return;
  }
  let result;
  try {
    result = await api.stayInTouch(call.sessionId);
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  call.liked = true;
  if (result === 'waiting') {
    toast('Nice! If they tap the heart too, you’ll both be connected. They won’t know unless they do.', { duration: 6000 });
  } else {
    call.mutual = result;
    call.channel?.send({ kind: 'mutual', result });
    toast(`It’s mutual! You and ${call.name} want to stay in touch.`, { type: 'success' });
  }
  if (state.call === call) rerenderCall(call);
  else if (state.screen === 'ended' && state.lastCall === call) renderEnded(state.lastReason, { duration: state.lastDuration, call });
}

/** The other person says it's mutual: believe the database, not the message. */
async function onMutual(call, result) {
  if (!call.liked) return;
  if (result === 'mutual') {
    const profile = await api.getProfile(call.partnerId).catch(() => null);
    if (profile?.connection_status !== 'connected') return;
  } else if (result !== 'mutual_needs_account') {
    return;
  }
  call.mutual = result;
  toast(`It’s mutual! You and ${call.name} want to stay in touch.`, { type: 'success' });
  if (state.call === call) rerenderCall(call);
}

async function openDirectChat(button) {
  const call = state.lastCall;
  if (!call) return;
  button.disabled = true;
  try {
    const id = await api.startDirectConversation(call.partnerId);
    window.location.assign(`chat.html?c=${encodeURIComponent(id)}`);
  } catch (error) {
    button.disabled = false;
    toast(friendlyError(error), { type: 'error' });
  }
}

/* ---------- text chat during a video call ---------- */
// Uses the match's own conversation, so messages follow the same rules as
// Chats (only while the call is live) and stay in Chats afterwards.

const CALL_CHAT_MAX = 2000;

function chatButtonHtml(c) {
  if (!chatPanel) return '';
  const open = !chatPanel.hidden;
  const unread = open ? 0 : c.unread;
  const label = unread ? `Open chat, ${unread} new message${unread === 1 ? '' : 's'}` : open ? 'Close chat' : 'Open chat';
  return `<button class="call-mute call-chat-btn" type="button" data-action="chat" aria-controls="call-chat" aria-pressed="${open}"
    aria-label="${label}" title="Chat">${icon('chat')}${unread ? `<span class="call-chat-badge">${unread > 9 ? '9+' : unread}</span>` : ''}</button>`;
}

function bindCallChat() {
  const send = chatForm.querySelector('.call-chat__send');
  chatPanel.querySelector('[data-chat-close]').addEventListener('click', () => setChatOpen(false));
  chatInput.addEventListener('input', () => { send.disabled = !chatInput.value.trim(); });
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendCallMessage();
  });
  chatList.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry]');
    if (retry) retryCallMessage(retry.dataset.retry);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !chatPanel.hidden && !document.querySelector('dialog[open]')) setChatOpen(false);
  });
}

function setChatOpen(open) {
  if (!chatPanel) return;
  const c = state.call;
  const show = Boolean(open && c && state.screen === 'live');
  chatPanel.hidden = !show;
  screen.classList.toggle('chat-open', show);
  if (show) {
    c.unread = 0;
    document.getElementById('call-chat-title').textContent = `Chat with ${c.name}`;
    renderCallChat();
    chatInput.focus();
    markCallChatRead(c);
  }
  if (c) refreshChatButton(c);
}

function refreshChatButton(c) {
  const button = stage.querySelector('[data-action="chat"]');
  if (button) button.outerHTML = chatButtonHtml(c);
}

function renderCallChat() {
  const c = state.call;
  if (!c || !chatList) return;
  chatList.innerHTML = c.messages.length
    ? c.messages.map((m) => {
      const out = m.sender_id === state.me.id;
      let meta = '';
      if (m.status === 'sending') meta = 'Sending…';
      if (m.status === 'failed') {
        meta = `<span class="is-failed">Not sent</span> <button class="msg__retry" type="button" data-retry="${esc(m.client_id)}">Retry</button>`;
      }
      return `<li class="call-chat__msg call-chat__msg--${out ? 'out' : 'in'}">
        <span class="call-chat__bubble">${esc(m.body)}</span>${meta ? `<span class="call-chat__meta">${meta}</span>` : ''}</li>`;
    }).join('')
    : '<li class="call-chat__empty">Say hi 👋 Your messages are saved in Chats.</li>';
  chatList.scrollTop = chatList.scrollHeight;
}

function upsertCallMessage(c, message) {
  const index = c.messages.findIndex((m) => (message.id && m.id === message.id)
    || (m.client_id === message.client_id && m.sender_id === message.sender_id));
  if (index >= 0) c.messages[index] = { ...c.messages[index], ...message };
  else c.messages.push(message);
}

/** Shows the message straight away, then stores it. Retrying reuses the client id, so it is never duplicated. */
async function sendCallMessage(retrying = null) {
  const c = state.call;
  if (!c) return;
  const body = retrying ? retrying.body : chatInput.value.trim();
  if (!body) return;
  if (body.length > CALL_CHAT_MAX) {
    toast(`Messages can be up to ${CALL_CHAT_MAX} characters.`, { type: 'error' });
    return;
  }
  const message = retrying || { client_id: crypto.randomUUID(), sender_id: state.me.id, kind: 'text', body };
  if (!retrying) {
    chatInput.value = '';
    chatForm.querySelector('.call-chat__send').disabled = true;
  }
  upsertCallMessage(c, { ...message, status: 'sending' });
  renderCallChat();
  try {
    const saved = await api.sendMessage({ conversationId: c.conversationId, clientId: message.client_id, body, kind: 'text' });
    upsertCallMessage(c, { ...saved, status: 'sent' });
  } catch (error) {
    const saved = error?.code === '23505' ? await api.getMessageByClientId(message.client_id).catch(() => null) : null;
    if (saved) {
      upsertCallMessage(c, { ...saved, status: 'sent' });
    } else {
      upsertCallMessage(c, { ...message, status: 'failed' });
      toast(error?.code === '42501' ? 'You can’t send messages in this call right now.' : friendlyError(error), { type: 'error' });
    }
  }
  if (state.call === c) renderCallChat();
}

function retryCallMessage(clientId) {
  const message = state.call?.messages.find((m) => m.client_id === clientId && m.status === 'failed');
  if (message) sendCallMessage(message);
}

/** New message from Realtime: show it, or count it and show a short preview while the chat is closed. */
function onCallMessage(message) {
  const c = state.call;
  if (!c || message.conversation_id !== c.conversationId || message.kind !== 'text' || message.deleted_at) return;
  upsertCallMessage(c, { ...message, status: 'sent' });
  if (!chatPanel || message.sender_id === state.me.id) {
    if (chatPanel && !chatPanel.hidden) renderCallChat();
    return;
  }
  if (!chatPanel.hidden) {
    renderCallChat();
    markCallChatRead(c);
    return;
  }
  c.unread += 1;
  refreshChatButton(c);
  const preview = message.body.length > 80 ? `${message.body.slice(0, 80)}…` : message.body;
  toast(`💬 ${c.name}: ${preview}`);
}

function markCallChatRead(c) {
  api.markConversationRead(c.conversationId, state.me.id).catch(() => {});
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
  const details = [c.age, c.gender].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="call-partner">
      <div class="call-voice" id="call-voice" aria-hidden="true">${avatarHtml(c.name, c.avatarUrl, 'call-avatar')}</div>
      <h1>${esc(c.name)}</h1>
      ${details ? `<p class="call-details">${details}</p>` : ''}
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
  return `<button class="call-mute" type="button" data-action="switch-camera" aria-label="Switch between front and back camera" title="Switch camera">${icon('camera-flip')}</button>`;
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
  const veiled = state.screen === 'live' && c && !bothRevealed(c);
  const show = Boolean(c) && (state.screen === 'connecting' || (state.screen === 'live' && (veiled || c.remoteCameraOff)));
  remoteOff.hidden = !show;
  if (show) {
    // before the reveal the card on top explains it, so the backdrop stays plain
    remoteOff.innerHTML = veiled ? ''
      : `${avatarHtml(c.name, c.avatarUrl, 'call-avatar')}<p>${state.screen === 'connecting' ? 'Connecting…' : `${esc(c.name)} turned their camera off`}</p>`;
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
    reveal,
    stay: () => stayInTouch(state.call),
    'stay-ended': () => stayInTouch(state.lastCall),
    'open-direct': () => openDirectChat(button),
    'icebreaker-next': nextIcebreaker,
    'icebreaker-close': () => { if (state.call) { state.call.icebreakerClosed = true; rerenderCall(state.call); } },
    'icebreaker-open': () => { if (state.call) { state.call.icebreakerClosed = false; rerenderCall(state.call); } },
    chat: () => setChatOpen(chatPanel?.hidden ?? false),
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
    state.canSwitchCamera = (await listCameras()).length > 1 || isTouchDevice();
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

/**
 * Front ↔ back camera. The call keeps going on the new track (no reconnect).
 * Many phones can only have one camera open at a time, so the current one is
 * released first; if the other camera can't be opened, the previous one is
 * put back.
 */
async function switchCamera() {
  if (!state.media || state.switchingCamera) return;
  state.switchingCamera = true;
  const button = stage.querySelector('[data-action="switch-camera"]');
  if (button) button.disabled = true;

  const wanted = state.facing === 'user' ? 'environment' : 'user';
  const [old] = state.media.getVideoTracks();
  const oldDeviceId = old?.getSettings?.().deviceId;
  // detach the call from the old camera before stopping it, so the call picks up the new one cleanly
  await state.call?.peer?.replaceTrack('video', null).catch(() => {});
  if (old) {
    old.stop();
    state.media.removeTrack(old);
  }

  let track = await openCamera({ facingMode: { exact: wanted } });
  if (!track) track = await openCamera(await nextCameraConstraint(oldDeviceId));
  const switched = Boolean(track);
  if (!track) {
    // put the previous camera back (asked loosely, so any camera is better than none)
    track = await openCamera(oldDeviceId ? { deviceId: oldDeviceId } : { facingMode: state.facing })
      || await openCamera({});
  }

  if (track) {
    track.enabled = !state.cameraOff;
    state.media.addTrack(track);
    if (switched) state.facing = facingOf(track, wanted);
    showSelfView(track);
    if (state.call && bothRevealed(state.call)) await state.call.peer?.replaceTrack('video', track).catch(() => {});
  }
  if (!switched) toast('Couldn’t switch camera on this device.', { type: 'error' });

  state.switchingCamera = false;
  const after = stage.querySelector('[data-action="switch-camera"]');
  if (after) after.disabled = false;
}

async function openCamera(video) {
  if (!video) return null; // no alternative to try
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { ...video, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    return stream.getVideoTracks()[0] || null;
  } catch {
    return null;
  }
}

async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** For devices that don't label cameras as front/back: the next camera in the list. */
async function nextCameraConstraint(currentId) {
  const cameras = await listCameras();
  if (cameras.length < 2) return null;
  const index = cameras.findIndex((c) => c.deviceId === currentId);
  return { deviceId: { exact: cameras[(index + 1) % cameras.length].deviceId } };
}

function facingOf(track, fallback) {
  const reported = track.getSettings?.().facingMode;
  if (reported === 'user' || reported === 'environment') return reported;
  if (/back|rear|environment/i.test(track.label)) return 'environment';
  if (/front|user|face/i.test(track.label)) return 'user';
  return fallback;
}

/** Your own picture: mirrored for the front camera, like a mirror; the back camera shows the world as it is. */
function showSelfView(track) {
  localVideo.srcObject = new MediaStream([track]);
  localVideo.classList.toggle('is-mirrored', state.facing === 'user');
  localVideo.play().catch(() => {});
}

function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches
    && Boolean(navigator.mediaDevices.getSupportedConstraints?.().facingMode);
}

/** Lets the other side show "Muted" / "camera off" instead of silence or a black frame. */
function sendMediaState() {
  state.call?.channel?.send({
    kind: 'media', muted: state.muted, cameraOff: state.cameraOff, revealed: Boolean(state.call.iRevealed),
  });
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
    gender: '',
    remoteMuted: false,
    remoteCameraOff: false,
    icebreaker: 0,           // how many times "New question" was pressed (shared)
    icebreakerClosed: false,
    messages: [],            // text chat during the call (kept in the conversation)
    unread: 0,
    liked: false,            // you tapped "Stay in touch" (only you can see this)
    mutual: null,            // 'mutual' | 'mutual_needs_account'
    iRevealed: false,
    theyRevealed: false,
    startedAt: 0,
    timers: [],
    peer: null,
    channel: null,
    stopLevel: null,
    ended: false,
  };
  state.call = call;
  renderConnecting();

  Promise.all([api.getProfile(call.partnerId), api.getGenderLabel(call.partnerId).catch(() => '')]).then(([p, gender]) => {
    if (!p || state.call !== call) return;
    call.name = p.display_name || call.name;
    call.avatarUrl = api.publicImageUrl('avatars', p.avatar_path);
    call.age = p.age;
    call.gender = gender;
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
  if (VIDEO) await applyReveal(call); // camera stays with you until you both tap Reveal

  try {
    call.channel = await api.joinMatchChannel(call.sessionId, (message) => {
      if (state.call !== call) return;
      if (message?.kind === 'bye') {
        endCall('partner');
      } else if (message?.kind === 'media') {
        call.remoteMuted = Boolean(message.muted);
        call.remoteCameraOff = Boolean(message.cameraOff);
        if (message.revealed && !call.theyRevealed) {
          call.theyRevealed = true;
          applyReveal(call);
        }
        rerenderCall(call);
      } else if (message?.kind === 'reveal') {
        call.theyRevealed = true;
        applyReveal(call);
        rerenderCall(call);
        if (bothRevealed(call)) toast('Video is on for both of you.');
      } else if (message?.kind === 'icebreaker') {
        const offset = Number(message.offset);
        if (Number.isInteger(offset) && offset > call.icebreaker && offset < 10_000) {
          call.icebreaker = offset;
          showIcebreaker(call);
        }
      } else if (message?.kind === 'mutual') {
        onMutual(call, message.result);
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
  state.lastReason = reason;
  state.lastDuration = duration;
  renderEnded(reason, {
    duration,
    call: {
      name: call.name, partnerId: call.partnerId, sessionId: call.sessionId, conversationId: call.conversationId,
      liked: call.liked, mutual: call.mutual, chatted: call.messages.some((m) => m.status === 'sent'),
    },
  });
}

function teardown(call) {
  if (chatPanel) {
    setChatOpen(false);
    chatList.innerHTML = '';
  }
  call.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  clearTimeout(call.dropTimer);
  call.stopLevel?.();
  call.peer?.close();
  // let the bye message go out before leaving the channel
  setTimeout(() => call.channel?.leave(), 300);
  if (remoteAudio) remoteAudio.srcObject = null;
  if (remoteVideo) {
    remoteVideo.srcObject = null;
    remoteVideo.classList.remove('is-veiled');
  }
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
