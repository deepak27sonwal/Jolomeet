// Chat page: conversation list, open conversation, random text matching.
import { initApp, toast } from './app.js';
import * as api from './api.js';
import { icon, esc, avatarHtml, timeAgo, setLoading, friendlyError } from './ui.js';
import { confirmAction, openReportDialog } from './dialogs.js';
import { askAboutYou } from './quick-start.js';
import { randomQuestion } from './icebreakers.js';
import { canRecordVoice, startRecording, voicePlayerHtml, hydrateVoicePlayers, stopVoicePlayback, formatSeconds, MAX_VOICE_SECONDS } from './voice-note.js';
import { interestPickerHtml, mountInterestPicker, savedInterests } from './interest-picker.js';

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const PRESENCE_REFRESH_MS = 60_000;
const MATCH_POLL_MS = 4000;
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 4000;
const PAGE_SIZE = 40;
const MAX_LENGTH = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMOJI = ['😀', '😂', '😊', '😍', '🥰', '😘', '😎', '😉',
  '🤔', '😅', '😭', '😴', '🤗', '🙌', '👍', '👏',
  '🙏', '🔥', '❤️', '💜', '✨', '🎉', '😜', '😮'];

const app = document.getElementById('chat-app');
const main = document.getElementById('chat-main');
const list = document.getElementById('chat-list');
const panel = document.getElementById('chat-panel');
const backdrop = document.getElementById('chat-panel-backdrop');
const searchInput = document.getElementById('chat-search');
const requestsBadge = document.getElementById('requests-count');
const fileInput = document.getElementById('chat-attachment');
const wideScreen = window.matchMedia('(min-width: 1180px)');

const state = {
  me: null,
  filter: 'all',
  search: '',
  conversations: [],
  requests: [],
  listLoaded: false,
  listError: null,
  presence: new Map(),   // user id -> last_seen_at
  labels: {},            // interest slug -> label
  active: null,          // the open conversation (see openConversation)
  matching: null,        // random-match search in progress
  panelOpen: false,
  openSeq: 0,
};

const imageUrls = new Map(); // storage path -> Promise<signed url>

initApp();
init();

async function init() {
  let session;
  try {
    session = await api.getSession();
  } catch {
    session = null;
  }
  if (!session) {
    // random chat needs no account: ask for a name, gender and age, then go straight in.
    // The chat list itself (saved conversations) needs a log in.
    if (new URLSearchParams(window.location.search).get('mode') !== 'random') {
      window.location.replace(`login.html?next=${encodeURIComponent(`chat.html${window.location.search}`)}`);
      return;
    }
    document.body.classList.add('chat-about');
    main.innerHTML = '<div class="chat-about-you"></div>';
    session = await askAboutYou(main.firstElementChild, { action: 'Continue', next: 'chat.html?mode=random' });
    document.body.classList.remove('chat-about');
  }
  state.me = session.user;
  if (state.me.is_anonymous) showGuestNotice();

  bindSidebar();
  bindMain();
  bindPanel();
  window.addEventListener('popstate', routeFromUrl);
  window.addEventListener('pagehide', () => {
    if (state.matching) api.leaveMatchQueue().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markActiveRead();
  });

  api.fetchInterests()
    .then((rows) => { state.labels = Object.fromEntries(rows.map((r) => [r.slug, r.label])); })
    .catch(() => {});

  subscribeRealtime();
  await refreshList();
  setInterval(refreshPresence, PRESENCE_REFRESH_MS);
  routeFromUrl();
}

/* =========================================================================
   Routing (?c=<conversation id> or ?mode=random)
   ========================================================================= */

function routeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('c');
  if (id && UUID_RE.test(id)) {
    if (state.active?.id !== id) openConversation(id, { push: false });
    return;
  }
  if (id) toast("That conversation link isn't valid.", { type: 'error' });
  if (params.get('mode') === 'random') {
    if (!state.matching && !main.querySelector('.chat-setup')) renderMatchSetup({ push: false });
    return;
  }
  if (state.matching) {
    stopMatching();
    api.leaveMatchQueue().catch(() => {});
  }
  closeConversation({ push: false });
}

function setUrl(search, push) {
  const url = `chat.html${search}`;
  if (`${window.location.pathname.split('/').pop()}${window.location.search}` === url) return;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

/** On phones the open conversation (or matching screen) replaces the list. */
function setMobileOpen(open) {
  document.body.classList.toggle('chat-open', open);
}

/* =========================================================================
   Sidebar
   ========================================================================= */

function bindSidebar() {
  document.querySelectorAll('.chat-filter').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll('.chat-filter').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      renderList();
    });
  });
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value.trim().toLowerCase();
    renderList();
  });
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-conversation]');
    if (item) {
      openConversation(item.dataset.conversation, { push: true });
      return;
    }
    if (event.target.closest('[data-action="new-chat"]')) renderMatchSetup({ push: true });
    if (event.target.closest('[data-action="retry-list"]')) refreshList();
  });
  document.getElementById('new-chat').addEventListener('click', () => renderMatchSetup({ push: true }));
}

async function refreshList() {
  try {
    const [all, requests] = await Promise.all([api.listConversations('all'), api.listConversations('requests')]);
    state.conversations = all;
    state.requests = requests;
    state.listError = null;
  } catch (error) {
    state.listError = error;
  }
  state.listLoaded = true;
  syncActiveFromList();
  renderList();
  refreshPresence();
}

let listTimer;
function refreshListSoon() {
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 400);
}

/** Read receipts come from the list query, which honours the partner's "show read receipts" setting. */
function syncActiveFromList() {
  const active = state.active;
  if (!active) return;
  const row = findListRow(active.id);
  if (!row) return;
  const before = active.partnerLastRead;
  active.partnerLastRead = row.partner_last_read_at;
  if (before !== active.partnerLastRead) renderMessages();
}

function findListRow(id) {
  return state.conversations.find((c) => c.conversation_id === id)
    || state.requests.find((c) => c.conversation_id === id);
}

async function refreshPresence() {
  const ids = new Set([...state.conversations, ...state.requests].map((c) => c.partner_id).filter(Boolean));
  if (state.active?.partner.id) ids.add(state.active.partner.id);
  if (!ids.size) return;
  try {
    const rows = await api.getPresence([...ids]);
    state.presence = new Map(rows.map((r) => [r.user_id, r.last_seen_at]));
  } catch {
    return; // presence is a nice-to-have; keep the last known values
  }
  renderList();
  if (state.active) renderHeadStatus();
}

function isOnline(userId) {
  const seen = state.presence.get(userId);
  return Boolean(seen) && Date.now() - new Date(seen).getTime() < ONLINE_WINDOW_MS;
}

function visibleRows() {
  let rows;
  if (state.filter === 'requests') rows = state.requests;
  else if (state.filter === 'favorites') rows = state.conversations.filter((c) => c.is_favorite);
  else if (state.filter === 'online') rows = state.conversations.filter((c) => isOnline(c.partner_id));
  else rows = state.conversations;
  if (state.search) rows = rows.filter((c) => (c.partner_name || '').toLowerCase().includes(state.search));
  return rows;
}

function renderList() {
  requestsBadge.hidden = !state.requests.length;
  requestsBadge.textContent = String(state.requests.length);
  if (!state.listLoaded) return;
  list.setAttribute('aria-busy', 'false');

  if (state.listError) {
    list.innerHTML = `<li class="chat-list-empty">
      <p>${esc(friendlyError(state.listError))}</p>
      <button class="btn btn--secondary btn--sm" type="button" data-action="retry-list">${icon('refresh', 'icon icon--sm')}Try again</button>
    </li>`;
    return;
  }

  const rows = visibleRows();
  if (!rows.length) {
    list.innerHTML = `<li class="chat-list-empty">${emptyListMessage()}</li>`;
    return;
  }
  list.innerHTML = rows.map(listItemHtml).join('');
}

function emptyListMessage() {
  if (state.search) return `<p>No chats match “${esc(state.search)}”.</p>`;
  const messages = {
    all: ['No conversations yet.', true],
    online: ['None of your chats are online right now.', false],
    favorites: ['Star a chat to keep it here.', false],
    requests: ['No message requests.', false],
  };
  const [text, cta] = messages[state.filter];
  return `<p>${text}</p>${cta
    ? `<button class="btn btn--primary btn--sm" type="button" data-action="new-chat">${icon('shuffle', 'icon icon--sm')}Meet someone new</button>`
    : ''}`;
}

function listItemHtml(c) {
  const name = c.partner_name || 'JoloMeet user';
  const unread = c.unread_count > 0 && c.conversation_id !== state.active?.id;
  const current = c.conversation_id === state.active?.id;
  const avatarUrl = api.publicImageUrl('avatars', c.partner_avatar_path);
  const dot = isOnline(c.partner_id) ? '<span class="status-dot" aria-hidden="true"></span>' : '';
  const label = [name, isOnline(c.partner_id) ? 'online' : '', unread ? `${c.unread_count} unread` : '']
    .filter(Boolean).join(', ');
  return `<li>
    <button class="chat-item${unread ? ' is-unread' : ''}" type="button" data-conversation="${esc(c.conversation_id)}"
      aria-label="${esc(label)}"${current ? ' aria-current="true"' : ''}>
      <span class="avatar-wrap">${avatarHtml(name, avatarUrl)}${dot}</span>
      <span class="chat-item__body">
        <span class="chat-item__name">${esc(name)}</span>
        <span class="chat-item__preview">${esc(previewText(c))}</span>
      </span>
      <span class="chat-item__meta">
        <span>${esc(shortTime(c.sort_at))}</span>
        ${unread ? `<span class="badge">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
        ${c.is_favorite ? icon('star', 'icon chat-item__fav is-filled') : ''}
      </span>
    </button>
  </li>`;
}

function previewText(c) {
  if (!c.last_message_kind) return c.session_live ? 'Chat started. Say hi!' : 'No messages yet';
  const mine = c.last_message_sender === state.me.id ? 'You: ' : '';
  if (c.last_message_kind === 'image') return `${mine}📷 Photo`;
  if (c.last_message_kind === 'voice') return `${mine}🎤 Voice message`;
  if (c.last_message_body == null) return 'Message deleted';
  return mine + c.last_message_body.replace(/\s+/g, ' ');
}

function shortTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const days = (now - date) / 86_400_000;
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/* =========================================================================
   Opening a conversation
   ========================================================================= */

async function openConversation(id, { push = false, intro = null } = {}) {
  if (state.matching) stopMatching();
  const seq = ++state.openSeq;
  leaveActive();
  setUrl(`?c=${id}`, push);
  setMobileOpen(true);
  main.innerHTML = `<div class="chat-empty" aria-busy="true"><span class="spinner" aria-hidden="true"></span><p>Loading conversation…</p></div>`;
  renderList();

  let meta;
  let messages;
  try {
    [meta, messages] = await Promise.all([api.getConversationMeta(id), api.getMessages(id, { limit: PAGE_SIZE })]);
  } catch (error) {
    if (seq !== state.openSeq) return;
    renderMainMessage('Couldn’t open this chat', friendlyError(error), { retry: () => openConversation(id) });
    return;
  }
  if (seq !== state.openSeq) return;
  if (!meta) {
    renderMainMessage('Chat not found', 'This conversation doesn’t exist or you’re no longer part of it.');
    return;
  }

  const mine = meta.participants.find((p) => p.user_id === state.me.id);
  const theirs = meta.participants.find((p) => p.user_id !== state.me.id) || {};
  const row = findListRow(id);
  let profile = null;
  let gender = '';
  if (theirs.user_id) {
    [profile, gender] = await Promise.all([
      api.getProfile(theirs.user_id).catch(() => null),
      api.getGenderLabel(theirs.user_id).catch(() => ''),
    ]);
  }
  if (seq !== state.openSeq) return;

  const name = profile?.display_name || row?.partner_name || 'JoloMeet user';
  state.active = {
    id,
    kind: meta.conversation.kind,
    session: meta.session,
    myStatus: mine?.status,
    partnerStatus: theirs.status,
    isFavorite: Boolean(mine?.is_favorite),
    partner: {
      id: theirs.user_id,
      name,
      avatarUrl: api.publicImageUrl('avatars', profile?.avatar_path ?? row?.partner_avatar_path),
      profile,
      gender,
    },
    blocked: Boolean(profile?.is_blocked_by_me),
    partnerLastRead: row?.partner_last_read_at ?? null,
    messages: messages.map((m) => ({ ...m, status: 'sent' })),
    hasMore: messages.length === PAGE_SIZE,
    loadingOlder: false,
    intro,
    typingChannel: null,
    liked: false,          // you tapped "Stay in touch" (only you can see this)
    mutual: null,          // 'mutual' | 'mutual_needs_account' once both tapped
    recorder: null,
    typingUntil: 0,
    lastTypingSent: 0,
    stickToBottom: true,
  };

  renderConversation();
  markActiveRead();
  if (meta.session && theirs.user_id) loadStayInTouch(state.active);
  if (theirs.user_id) {
    api.joinConversationChannel(id, { onTyping, onSignal })
      .then((channel) => {
        if (state.active?.id === id) state.active.typingChannel = channel;
        else channel.leave();
      })
      .catch(() => {});
  }
  refreshPresence();
}

function leaveActive() {
  const active = state.active;
  if (!active) return;
  active.typingChannel?.leave();
  clearInterval(active.recTimer);
  active.recorder?.cancel();
  stopVoicePlayback();
  clearTimeout(active.typingTimer);
  state.active = null;
}

function closeConversation({ push = false } = {}) {
  leaveActive();
  setUrl('', push);
  setMobileOpen(false);
  setPanelOpen(false);
  panel.innerHTML = '';
  renderWelcome();
  renderList();
}

function renderWelcome() {
  main.innerHTML = `<div class="chat-empty">
    <span class="icon-badge">${icon('chat')}</span>
    <h2>Your conversations</h2>
    <p>Pick a chat on the left, or meet someone new.</p>
    <div class="chat-empty__actions">
      <button class="btn btn--primary" type="button" data-action="start-match">${icon('shuffle')}Start Random Chat</button>
      <a class="btn btn--secondary" href="explore.html">${icon('compass')}Explore People</a>
    </div>
  </div>`;
}

function renderMainMessage(title, message, { retry, action } = {}) {
  main.innerHTML = `<div class="chat-empty">
    <span class="icon-badge">${icon('alert')}</span>
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="chat-empty__actions">
      <button class="btn btn--secondary chat-back-to-list" type="button" data-action="back">${icon('arrow-left')}Back to chats</button>
      ${retry ? `<button class="btn btn--primary" type="button" data-action="retry">${icon('refresh')}Try again</button>` : ''}
      ${action ? `<button class="btn btn--primary" type="button" data-action="custom">${esc(action.label)}</button>` : ''}
    </div>
  </div>`;
  main.querySelector('[data-action="retry"]')?.addEventListener('click', retry);
  main.querySelector('[data-action="custom"]')?.addEventListener('click', action?.run);
}

/* =========================================================================
   Conversation view
   ========================================================================= */

function renderConversation() {
  const a = state.active;
  main.innerHTML = `
    <header class="chat-head">
      <button class="icon-button chat-back" type="button" data-action="back" aria-label="Back to chats">${icon('arrow-left')}</button>
      <span class="avatar-wrap" id="chat-head-avatar">${avatarHtml(a.partner.name, a.partner.avatarUrl)}</span>
      <button class="chat-head__who" type="button" data-action="panel" aria-controls="chat-panel">
        <span class="chat-head__name">${esc(a.partner.name)}</span>
        <span class="chat-head__status" id="chat-head-status" aria-live="polite"></span>
      </button>
      <div class="chat-head__actions" id="chat-head-actions"></div>
    </header>
    <div id="chat-banners"></div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-older" id="chat-older"></div>
      <div id="msg-list" role="log" aria-label="Messages" aria-live="polite"></div>
      <div class="typing" id="typing" hidden aria-label="${esc(a.partner.name)} is typing"><span></span><span></span><span></span></div>
    </div>
    <button class="btn btn--primary btn--sm chat-jump" type="button" data-action="jump" hidden>New messages ↓</button>
    <div id="chat-composer-slot"></div>`;

  const scroller = document.getElementById('chat-messages');
  scroller.addEventListener('scroll', onMessagesScroll, { passive: true });

  state.panelOpen = wideScreen.matches;
  renderHead();
  renderBanners();
  renderMessages();
  renderComposer();
  renderPanel();
  setPanelOpen(state.panelOpen);
  scrollToBottom();
}

function isLiveRandom(a = state.active) {
  return a.kind === 'random' && a.session?.status === 'active';
}

function canSend(a = state.active) {
  if (a.blocked || !a.partner.id) return false;
  if (a.myStatus !== 'active') return false;
  if (a.kind === 'random') return isLiveRandom(a);
  return true;
}

function renderHead() {
  const a = state.active;
  const actions = document.getElementById('chat-head-actions');
  if (!actions) return;
  let html = '';
  if (a.kind === 'random' && a.session && a.partner.id && !a.blocked) html += stayButtonHtml(a);
  if (isLiveRandom(a) && !a.blocked) {
    html += `<button class="btn btn--secondary" type="button" data-action="next" title="Next person">${icon('skip', 'icon icon--sm')}<span class="btn-label">Next</span></button>`;
    html += `<button class="btn btn--danger" type="button" data-action="end" title="End chat">${icon('close', 'icon icon--sm')}<span class="btn-label">End</span></button>`;
  } else if (a.kind === 'direct' && a.myStatus === 'active') {
    html += `<button class="icon-button" type="button" data-action="favorite" aria-pressed="${a.isFavorite}"
      aria-label="${a.isFavorite ? 'Remove from favorites' : 'Add to favorites'}" title="Favorite">${icon('star', `icon${a.isFavorite ? ' is-filled' : ''}`)}</button>`;
  }
  html += `<button class="icon-button" type="button" data-action="panel" aria-controls="chat-panel"
    aria-expanded="${state.panelOpen}" aria-label="Profile details" title="Profile details">${icon('info')}</button>`;
  actions.innerHTML = html;
  renderHeadStatus();
}

function renderHeadStatus() {
  const a = state.active;
  const el = document.getElementById('chat-head-status');
  const avatar = document.getElementById('chat-head-avatar');
  if (!el || !a) return;
  const typing = Date.now() < a.typingUntil;
  const online = isOnline(a.partner.id);
  const seen = state.presence.get(a.partner.id);
  el.className = 'chat-head__status';
  if (typing) {
    el.textContent = 'typing…';
    el.classList.add('is-typing');
  } else if (online) {
    el.textContent = 'Online now';
    el.classList.add('is-online');
  } else if (seen) {
    el.textContent = `Active ${timeAgo(seen)}`;
  } else {
    el.textContent = a.kind === 'random' ? 'Random chat' : '';
  }
  avatar.querySelector('.status-dot')?.remove();
  if (online) avatar.insertAdjacentHTML('beforeend', '<span class="status-dot" aria-hidden="true"></span>');
  const typingEl = document.getElementById('typing');
  if (typingEl && typingEl.hidden === typing) {
    typingEl.hidden = !typing;
    if (typing && a.stickToBottom) scrollToBottom();
  }
}

function renderBanners() {
  const a = state.active;
  const slot = document.getElementById('chat-banners');
  if (!slot) return;
  const name = esc(a.partner.name);
  let html = a.mutual && !a.blocked ? mutualBannerHtml(a) : '';
  if (a.blocked) {
    html += `<div class="chat-banner chat-banner--warn">${icon('ban')}<p>You blocked ${name}. You won’t receive messages from them.</p>
      <button class="btn btn--secondary" type="button" data-action="unblock">Unblock</button></div>`;
  } else if (a.myStatus === 'request') {
    html += `<div class="chat-banner"><p><strong>${name}</strong> wants to chat with you.</p>
      <button class="btn btn--primary" type="button" data-action="accept">${icon('check', 'icon icon--sm')}Accept</button>
      <button class="btn btn--secondary" type="button" data-action="decline">Decline</button>
      <button class="btn btn--ghost" type="button" data-action="block">Block</button></div>`;
  } else if (a.kind === 'random' && !isLiveRandom(a)) {
    const who = a.session?.ended_by === state.me.id ? 'You ended this chat.' : `${name} left the chat.`;
    html += `<div class="chat-banner"><p>${a.session ? who : 'This chat has ended.'}</p>
      <button class="btn btn--primary" type="button" data-action="start-match">${icon('shuffle', 'icon icon--sm')}Find New Match</button></div>`;
  } else if (a.kind === 'direct' && a.partnerStatus === 'request') {
    html += `<div class="chat-banner"><p>Message request sent. You can send up to 3 messages until ${name} accepts.</p></div>`;
  }
  slot.innerHTML = html;
}

function renderComposer() {
  const a = state.active;
  const slot = document.getElementById('chat-composer-slot');
  if (!slot) return;
  if (!canSend(a)) {
    if (a.recorder) cancelVoiceNote();
    let text = 'You can’t send messages in this chat.';
    if (a.blocked) text = 'Unblock to send messages.';
    else if (a.myStatus === 'request') text = 'Accept the request to reply.';
    else if (a.kind === 'random') text = 'This chat has ended.';
    slot.innerHTML = `<div class="chat-composer chat-composer--disabled"><p>${esc(text)}</p></div>`;
    return;
  }
  if (slot.querySelector('form')) return; // keep the draft
  slot.innerHTML = `
    <form class="chat-composer" id="composer" autocomplete="off">
      <button class="icon-button" type="button" data-action="emoji" aria-label="Add emoji" aria-expanded="false" aria-controls="emoji-pop">${icon('smile')}</button>
      <button class="icon-button" type="button" data-action="attach" aria-label="Send a photo">${icon('image')}</button>
      <button class="icon-button" type="button" data-action="icebreaker" aria-label="Add an icebreaker question" title="Icebreaker">${icon('dice')}</button>
      <label class="sr-only" for="chat-input">Message ${esc(a.partner.name)}</label>
      <textarea class="chat-input" id="chat-input" rows="1" maxlength="${MAX_LENGTH}" placeholder="Message…" enterkeyhint="send"></textarea>
      <button class="chat-send" type="submit" aria-label="Send message" disabled hidden>${icon('send')}</button>
      ${canRecordVoice() ? `<button class="chat-send chat-mic" type="button" data-action="record" aria-label="Record a voice message" title="Voice message">${icon('mic')}</button>` : ''}
      <div class="emoji-pop" id="emoji-pop" role="group" aria-label="Emoji" hidden>
        ${EMOJI.map((e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}
      </div>
    </form>`;
  const form = slot.querySelector('form');
  const input = form.querySelector('textarea');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendText();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText();
    }
  });
  input.addEventListener('input', () => {
    autosize(input);
    updateSendButton();
    sendTypingSignal();
  });
  updateSendButton();
}

function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 3, 140)}px`;
}

/** Empty input: the mic button (voice note). Something typed: the send button. */
function updateSendButton() {
  const input = document.getElementById('chat-input');
  const send = document.querySelector('.chat-send[type="submit"]');
  const mic = document.querySelector('.chat-mic');
  if (!input || !send) return;
  const hasText = Boolean(input.value.trim());
  send.disabled = !hasText;
  send.hidden = Boolean(mic) && !hasText;
  if (mic) mic.hidden = hasText;
}

/* ---------- messages ---------- */

function renderMessages({ keepOffset = false } = {}) {
  const a = state.active;
  const listEl = document.getElementById('msg-list');
  const scroller = document.getElementById('chat-messages');
  if (!listEl || !a) return;
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;

  const older = document.getElementById('chat-older');
  older.innerHTML = a.hasMore
    ? `<button class="btn btn--ghost btn--sm" type="button" data-action="older"${a.loadingOlder ? ' disabled' : ''}>${a.loadingOlder ? 'Loading…' : 'Load older messages'}</button>`
    : '';

  const lastOwn = [...a.messages].reverse().find((m) => m.sender_id === state.me.id && m.kind !== 'system');
  let html = '';
  if (!a.hasMore) html += `<p class="msg msg--system">${esc(introText(a))}</p>`;
  let lastDay = '';
  for (const m of a.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      html += `<div class="chat-day"><span>${esc(dayLabel(m.created_at))}</span></div>`;
      lastDay = day;
    }
    html += messageHtml(m, m === lastOwn);
  }
  listEl.innerHTML = html;
  hydrateImages(listEl);
  hydrateVoicePlayers(listEl, attachmentUrl);

  if (keepOffset) scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  else if (a.stickToBottom) scrollToBottom();
}

function introText(a) {
  if (a.intro?.length) {
    return `You matched on ${a.intro.map((s) => state.labels[s] || s).join(', ')}. Say hi!`;
  }
  if (a.kind === 'random') return 'You’re chatting with a random person. Be kind and stay safe.';
  return `This is the start of your conversation with ${a.partner.name}.`;
}

function messageHtml(m, isLastOwn) {
  const out = m.sender_id === state.me.id;
  if (m.kind === 'system') return `<p class="msg msg--system">${esc(m.body)}</p>`;
  const classes = ['msg', out ? 'msg--out' : 'msg--in'];
  if (m.deleted_at) classes.push('msg--deleted');
  if (m.status === 'sending') classes.push('msg--sending');
  if (m.status === 'failed') classes.push('msg--failed');
  if (m.kind === 'text' && String(m.body).startsWith('🎲 ')) classes.push('msg--icebreaker');

  let content;
  if (m.deleted_at) {
    content = '<div class="msg__bubble">Message deleted</div>';
  } else if (m.kind === 'voice') {
    content = `<div class="msg__bubble msg__bubble--voice">${voicePlayerHtml({
      path: m.localUrl ? '' : m.attachment_path, src: m.localUrl || '', seconds: m.body,
    })}</div>`;
  } else if (m.kind === 'image') {
    const src = m.localUrl ? ` src="${esc(m.localUrl)}"` : '';
    const path = m.attachment_path && !m.localUrl ? ` data-path="${esc(m.attachment_path)}"` : '';
    content = `<a class="msg__image" href="${m.localUrl ? esc(m.localUrl) : '#'}" target="_blank" rel="noopener"${path}>
      <img alt="Photo from ${out ? 'you' : esc(state.active.partner.name)}" loading="lazy"${src}></a>`;
  } else {
    content = `<div class="msg__bubble">${esc(m.body)}</div>`;
  }

  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let meta = `<time datetime="${esc(m.created_at)}">${esc(time)}</time>`;
  if (out && m.status === 'sending') meta += ' · Sending…';
  else if (out && m.status === 'failed') {
    meta += ` · <span class="is-failed">Not sent</span> <button class="msg__retry" type="button" data-retry="${esc(m.client_id)}">Retry</button>`;
  } else if (out && isLastOwn) {
    const read = state.active.partnerLastRead && new Date(state.active.partnerLastRead) >= new Date(m.created_at);
    meta += read ? ' · Seen' : ' · Sent';
  }
  return `<div class="${classes.join(' ')}" data-id="${esc(m.id || '')}">${content}<div class="msg__meta">${meta}</div></div>`;
}

function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Signed link for a photo or voice note, cached for the page. */
function attachmentUrl(path) {
  if (!imageUrls.has(path)) {
    imageUrls.set(path, api.chatAttachmentUrl(path).catch((error) => { imageUrls.delete(path); throw error; }));
  }
  return imageUrls.get(path);
}

/** Chat photos are private, so each one is shown through a short-lived signed link. */
function hydrateImages(root) {
  root.querySelectorAll('[data-path]').forEach((link) => {
    const path = link.dataset.path;
    if (!imageUrls.has(path)) imageUrls.set(path, api.chatImageUrl(path));
    imageUrls.get(path)
      .then((url) => {
        link.href = url;
        const img = link.querySelector('img');
        img.addEventListener('load', () => { if (state.active?.stickToBottom) scrollToBottom(); }, { once: true });
        img.src = url;
      })
      .catch(() => {
        imageUrls.delete(path);
        link.replaceWith(Object.assign(document.createElement('div'), { className: 'msg__bubble', textContent: 'Photo unavailable' }));
      });
  });
}

function isNearBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}

function scrollToBottom() {
  const scroller = document.getElementById('chat-messages');
  if (!scroller) return;
  scroller.scrollTop = scroller.scrollHeight;
  if (state.active) state.active.stickToBottom = true;
  const jump = main.querySelector('.chat-jump');
  if (jump) jump.hidden = true;
}

function onMessagesScroll(event) {
  const a = state.active;
  if (!a) return;
  const scroller = event.currentTarget;
  a.stickToBottom = isNearBottom(scroller);
  if (a.stickToBottom) main.querySelector('.chat-jump').hidden = true;
  if (scroller.scrollTop < 60 && a.hasMore && !a.loadingOlder) loadOlder();
}

async function loadOlder() {
  const a = state.active;
  if (!a || a.loadingOlder || !a.hasMore) return;
  const oldest = a.messages.find((m) => m.status === 'sent');
  if (!oldest) return;
  a.loadingOlder = true;
  renderMessages({ keepOffset: true });
  try {
    const page = await api.getMessages(a.id, { before: oldest.created_at, limit: PAGE_SIZE });
    if (state.active !== a) return;
    a.messages = [...page.map((m) => ({ ...m, status: 'sent' })), ...a.messages];
    a.hasMore = page.length === PAGE_SIZE;
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  } finally {
    a.loadingOlder = false;
    if (state.active === a) renderMessages({ keepOffset: true });
  }
}

/** Adds or replaces a message (matched by id or client id), keeping time order. */
function upsertMessage(message) {
  const a = state.active;
  const index = a.messages.findIndex((m) => (message.id && m.id === message.id)
    || (message.client_id && m.client_id === message.client_id && m.sender_id === message.sender_id));
  if (index >= 0) {
    const previous = a.messages[index];
    if (previous.localUrl && message.status === 'sent') URL.revokeObjectURL(previous.localUrl);
    a.messages[index] = { ...previous, ...message, localUrl: message.status === 'sent' ? null : previous.localUrl };
  } else {
    a.messages.push(message);
  }
  a.messages.sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
}

function onIncomingMessage(message) {
  const a = state.active;
  if (!a || message.conversation_id !== a.id) return;
  const scroller = document.getElementById('chat-messages');
  const wasNearBottom = scroller ? isNearBottom(scroller) : true;
  upsertMessage({ ...message, status: 'sent' });
  if (message.sender_id !== state.me.id) a.typingUntil = 0;
  a.stickToBottom = wasNearBottom || message.sender_id === state.me.id;
  renderMessages();
  renderHeadStatus();
  if (!a.stickToBottom) main.querySelector('.chat-jump').hidden = false;
  if (message.sender_id !== state.me.id) markActiveRead();
}

let readTimer;
function markActiveRead() {
  const a = state.active;
  if (!a || document.visibilityState !== 'visible') return;
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (state.active !== a) return;
    api.markConversationRead(a.id, state.me.id).catch(() => {});
    const row = findListRow(a.id);
    if (row) row.unread_count = 0;
    renderList();
  }, 300);
}

/* ---------- sending ---------- */

function sendText() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  if (body.length > MAX_LENGTH) {
    toast(`Messages can be up to ${MAX_LENGTH} characters.`, { type: 'error' });
    return;
  }
  input.value = '';
  autosize(input);
  updateSendButton();
  input.focus();
  deliver({ client_id: crypto.randomUUID(), kind: 'text', body });
}

async function sendImage(file) {
  if (!api.CHAT_IMAGE_RULES.types.includes(file.type)) {
    toast('Photos must be JPG, PNG, WebP or GIF.', { type: 'error' });
    return;
  }
  if (file.size > api.CHAT_IMAGE_RULES.maxBytes) {
    toast('Photos must be 5 MB or smaller.', { type: 'error' });
    return;
  }
  deliver({ client_id: crypto.randomUUID(), kind: 'image', file, localUrl: URL.createObjectURL(file) });
}

/** Shows the message straight away, then stores it. Retrying reuses the client id, so it is never duplicated. */
async function deliver(draft) {
  const a = state.active;
  if (!a) return;
  const message = {
    id: null,
    conversation_id: a.id,
    sender_id: state.me.id,
    body: null,
    attachment_path: null,
    deleted_at: null,
    ...draft,
    created_at: new Date().toISOString(),
    status: 'sending',
  };
  upsertMessage(message);
  a.stickToBottom = true;
  renderMessages();

  try {
    if ((message.kind === 'image' || message.kind === 'voice') && !message.attachment_path) {
      message.attachment_path = await api.uploadChatAttachment(a.id, state.me.id, message.file, message.mime);
    }
    const saved = await api.sendMessage({
      conversationId: a.id,
      clientId: message.client_id,
      body: message.body,
      kind: message.kind,
      attachmentPath: message.attachment_path,
    });
    if (state.active !== a) return;
    upsertMessage({ ...saved, status: 'sent' });
  } catch (error) {
    let saved = null;
    if (error?.code === '23505') saved = await api.getMessageByClientId(message.client_id).catch(() => null);
    if (state.active !== a) return;
    if (saved) {
      upsertMessage({ ...saved, status: 'sent' });
    } else {
      upsertMessage({ ...message, status: 'failed' });
      toast(sendErrorText(error), { type: 'error' });
    }
  }
  renderMessages();
  refreshListSoon();
}

function sendErrorText(error) {
  // row-level security refused the insert: the request limit, a block, or an ended chat
  if (error?.code === '42501') {
    return state.active?.partnerStatus === 'request'
      ? 'You can send up to 3 messages until they accept your request.'
      : 'You can’t send messages in this chat right now.';
  }
  return friendlyError(error);
}

function retryMessage(clientId) {
  const m = state.active?.messages.find((x) => x.client_id === clientId && x.status === 'failed');
  if (m) deliver(m);
}

/* ---------- voice notes ---------- */

async function startVoiceNote() {
  const a = state.active;
  const form = document.getElementById('composer');
  if (!a || a.recorder || !form) return;
  let recorder;
  try {
    recorder = await startRecording({
      onLimit: () => {
        toast(`Voice messages can be up to ${MAX_VOICE_SECONDS / 60} minutes, so this one was sent.`);
        sendVoiceNote();
      },
    });
  } catch (error) {
    toast(error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      ? 'Allow microphone access for this site to send voice messages.'
      : 'Couldn’t start your microphone.', { type: 'error' });
    return;
  }
  if (state.active !== a) {
    recorder.cancel();
    return;
  }
  a.recorder = recorder;
  form.hidden = true;
  form.insertAdjacentHTML('afterend', `
    <div class="chat-composer chat-recording" id="chat-recording" role="group" aria-label="Recording a voice message">
      <button class="icon-button" type="button" data-action="record-cancel" aria-label="Delete recording" title="Delete">${icon('trash')}</button>
      <span class="chat-recording__dot" aria-hidden="true"></span>
      <span class="chat-recording__time" id="rec-time">0:00</span>
      <span class="chat-recording__hint">Recording… tap send when you’re done</span>
      <button class="chat-send" type="button" data-action="record-send" aria-label="Send voice message">${icon('send')}</button>
    </div>`);
  a.recTimer = setInterval(() => {
    const el = document.getElementById('rec-time');
    if (el) el.textContent = formatSeconds(recorder.elapsed());
  }, 250);
}

function endRecordingUi(a) {
  clearInterval(a.recTimer);
  a.recorder = null;
  document.getElementById('chat-recording')?.remove();
  const form = document.getElementById('composer');
  if (form) form.hidden = false;
}

function cancelVoiceNote() {
  const a = state.active;
  if (!a?.recorder) return;
  const recorder = a.recorder;
  endRecordingUi(a);
  recorder.cancel();
}

async function sendVoiceNote() {
  const a = state.active;
  if (!a?.recorder) return;
  const recorder = a.recorder;
  endRecordingUi(a);
  const note = await recorder.stop();
  if (!note) {
    toast('That was too short to send.');
    return;
  }
  if (state.active !== a) return;
  deliver({
    client_id: crypto.randomUUID(),
    kind: 'voice',
    body: String(note.seconds),
    file: note.blob,
    mime: note.type,
    localUrl: URL.createObjectURL(note.blob),
  });
}

/* ---------- icebreakers ---------- */

/** Puts a conversation-starter question in the box; it can be edited before sending. */
function addIcebreaker() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.value = `🎲 ${randomQuestion()}`;
  autosize(input);
  updateSendButton();
  input.focus();
}

/* ---------- stay in touch ---------- */

function stayButtonHtml(a) {
  const on = Boolean(a.liked || a.mutual);
  const label = a.mutual ? 'You’re staying in touch'
    : a.liked ? 'You’d like to stay in touch (only you can see this)' : 'Stay in touch';
  return `<button class="icon-button chat-stay${on ? ' is-on' : ''}" type="button" data-action="stay" aria-pressed="${on}"
    aria-label="${label}" title="${label}">${icon('heart', `icon${on ? ' is-filled' : ''}`)}</button>`;
}

function mutualBannerHtml(a) {
  const name = esc(a.partner.name);
  const start = `<div class="chat-banner chat-banner--mutual">${icon('heart', 'icon is-filled')}<p><strong>It’s mutual!</strong>`;
  if (a.mutual === 'mutual') {
    return `${start} You and ${name} are now connected.</p>
      <button class="btn btn--primary" type="button" data-action="open-direct">${icon('chat', 'icon icon--sm')}Open Chat</button></div>`;
  }
  if (state.me.is_anonymous) {
    return `${start} Create a free account to stay in touch with ${name}.</p>
      <a class="btn btn--primary" href="register.html">Create Free Account</a></div>`;
  }
  return `${start} ${name} is chatting without an account, so you’ll be connected as soon as they sign up.</p></div>`;
}

/** Restores your own heart (and a connection that came from it) when a chat is reopened. */
async function loadStayInTouch(a) {
  try {
    a.liked = await api.didStayInTouch(a.session.id);
  } catch {
    return;
  }
  if (a.liked && a.partner.profile?.connection_status === 'connected') a.mutual = 'mutual';
  if (state.active === a && a.liked) {
    renderHead();
    renderBanners();
  }
}

async function stayInTouch() {
  const a = state.active;
  if (!a?.session || a.mutual) return;
  if (a.liked) {
    toast('You’ve said you’d like to stay in touch. If they tap the heart too, you’ll both be connected.');
    return;
  }
  let result;
  try {
    result = await api.stayInTouch(a.session.id);
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  if (state.active !== a) return;
  a.liked = true;
  if (result === 'waiting') {
    toast('Nice! If they tap the heart too, you’ll both be connected. They won’t know unless they do.', { duration: 6000 });
  } else {
    a.mutual = result;
    a.typingChannel?.sendSignal({ kind: 'mutual', result, user_id: state.me.id });
    refreshListSoon();
  }
  renderHead();
  renderBanners();
}

/** Signals from the other person in this conversation. */
async function onSignal(payload) {
  const a = state.active;
  if (!a || payload?.user_id !== a.partner.id || payload.kind !== 'mutual' || !a.liked) return;
  if (payload.result === 'mutual') {
    // trust the database, not the message: are you actually connected now?
    const profile = await api.getProfile(a.partner.id).catch(() => null);
    if (state.active !== a || profile?.connection_status !== 'connected') return;
    a.partner.profile = profile;
  } else if (payload.result !== 'mutual_needs_account') {
    return;
  }
  a.mutual = payload.result;
  renderHead();
  renderBanners();
  toast(`It’s mutual! You and ${a.partner.name} want to stay in touch.`, { type: 'success' });
}

async function openDirectChat(button) {
  const a = state.active;
  setLoading(button, true);
  try {
    const id = await api.startDirectConversation(a.partner.id);
    await refreshList();
    openConversation(id, { push: true });
  } catch (error) {
    setLoading(button, false);
    toast(friendlyError(error), { type: 'error' });
  }
}

/* ---------- typing ---------- */

function sendTypingSignal() {
  const a = state.active;
  if (!a?.typingChannel) return;
  const now = Date.now();
  if (now - a.lastTypingSent < TYPING_SEND_MS) return;
  a.lastTypingSent = now;
  a.typingChannel.sendTyping(state.me.id);
}

function onTyping(payload) {
  const a = state.active;
  if (!a || payload?.user_id !== a.partner.id) return;
  a.typingUntil = Date.now() + TYPING_SHOW_MS;
  renderHeadStatus();
  clearTimeout(a.typingTimer);
  a.typingTimer = setTimeout(renderHeadStatus, TYPING_SHOW_MS + 50);
}

/* =========================================================================
   Main column actions
   ========================================================================= */

function bindMain() {
  main.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry]');
    if (retry) {
      retryMessage(retry.dataset.retry);
      return;
    }
    const emoji = event.target.closest('[data-emoji]');
    if (emoji) {
      insertEmoji(emoji.dataset.emoji);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const actions = {
      back: goBackToList,
      panel: () => setPanelOpen(!state.panelOpen),
      favorite: toggleFavorite,
      next: () => endRandom('next'),
      end: () => endRandom('ended'),
      accept: () => respondToRequest(true, button),
      decline: () => respondToRequest(false, button),
      block: handleBlock,
      unblock: () => handleUnblock(button),
      'start-match': () => renderMatchSetup({ push: true }),
      'begin-match': () => startMatching({ push: false }),
      'cancel-match': () => cancelMatching(),
      older: loadOlder,
      jump: scrollToBottom,
      emoji: () => toggleEmoji(),
      attach: () => fileInput.click(),
      icebreaker: addIcebreaker,
      record: startVoiceNote,
      'record-cancel': cancelVoiceNote,
      'record-send': sendVoiceNote,
      stay: stayInTouch,
      'open-direct': () => openDirectChat(button),
    };
    actions[button.dataset.action]?.();
  });

  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (file && state.active && canSend()) sendImage(file);
  });

  document.addEventListener('click', (event) => {
    const pop = document.getElementById('emoji-pop');
    if (pop && !pop.hidden && !event.target.closest('#emoji-pop, [data-action="emoji"]')) toggleEmoji(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const pop = document.getElementById('emoji-pop');
    if (pop && !pop.hidden) {
      toggleEmoji(false);
      document.querySelector('[data-action="emoji"]')?.focus();
    } else if (state.panelOpen && !wideScreen.matches && !document.querySelector('dialog[open]')) {
      setPanelOpen(false);
    }
  });
}

function goBackToList() {
  if (state.matching) {
    stopMatching();
    api.leaveMatchQueue().catch(() => {});
  }
  closeConversation({ push: false });
}

function toggleEmoji(force) {
  const pop = document.getElementById('emoji-pop');
  const button = document.querySelector('[data-action="emoji"]');
  if (!pop) return;
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  button?.setAttribute('aria-expanded', String(open));
  if (open) pop.querySelector('button')?.focus();
}

function insertEmoji(emoji) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (input.value.length + emoji.length > MAX_LENGTH) return;
  input.setRangeText(emoji, start, end, 'end');
  input.focus();
  autosize(input);
  updateSendButton();
}

async function toggleFavorite() {
  const a = state.active;
  const next = !a.isFavorite;
  a.isFavorite = next;
  renderHead();
  try {
    await api.updateParticipation(a.id, state.me.id, { is_favorite: next });
    const row = findListRow(a.id);
    if (row) row.is_favorite = next;
    renderList();
  } catch (error) {
    a.isFavorite = !next;
    if (state.active === a) renderHead();
    toast(friendlyError(error), { type: 'error' });
  }
}

async function respondToRequest(accept, button) {
  const a = state.active;
  setLoading(button, true);
  try {
    await api.updateParticipation(a.id, state.me.id, { status: accept ? 'active' : 'left' });
  } catch (error) {
    setLoading(button, false);
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  if (accept) {
    a.myStatus = 'active';
    renderHead();
    renderBanners();
    renderComposer();
    markActiveRead();
    toast('Request accepted.', { type: 'success' });
  } else {
    closeConversation({ push: false });
    toast('Request declined.');
  }
  refreshList();
}

async function endRandom(reason) {
  const a = state.active;
  if (!a?.session) return;
  if (reason === 'ended') {
    const ok = await confirmAction({
      title: 'End this chat?',
      message: `You won’t be able to message ${a.partner.name} here again.`,
      confirmLabel: 'End Chat',
    });
    if (!ok || state.active !== a) return;
  }
  try {
    await api.endMatchSession(a.session.id, reason);
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  a.session = { ...a.session, status: 'ended', ended_by: state.me.id, end_reason: reason };
  refreshListSoon();
  if (reason === 'next') {
    startMatching({ push: false });
    return;
  }
  renderConversationState();
}

function renderConversationState() {
  renderHead();
  renderBanners();
  renderComposer();
  renderPanel();
}

/* =========================================================================
   Random matching
   ========================================================================= */

function matchInterests() {
  return savedInterests();
}

/** Before matching: choose interests (remembered for next time), then start. */
function renderMatchSetup({ push = false } = {}) {
  leaveActive();
  state.openSeq++;
  stopMatching();
  setPanelOpen(false);
  panel.innerHTML = '';
  setUrl('?mode=random', push);
  setMobileOpen(true);
  renderList();
  main.innerHTML = `
    <div class="chat-setup">
      <button class="icon-button chat-back chat-setup__back" type="button" data-action="back" aria-label="Back to chats">${icon('arrow-left')}</button>
      <div class="chat-setup__card">
        <span class="icon-badge">${icon('shuffle')}</span>
        <h2>Random Chat</h2>
        <p class="chat-setup__lead">Text with someone new. Skip to the next person any time.</p>
        ${interestPickerHtml()}
        <button class="btn btn--primary btn--lg btn--block" type="button" data-action="begin-match">${icon('shuffle')}Start Matching</button>
      </div>
    </div>`;
  mountInterestPicker(main);
}

function startMatching({ push = false } = {}) {
  leaveActive();
  state.openSeq++;
  stopMatching();
  setPanelOpen(false);
  panel.innerHTML = '';
  setUrl('?mode=random', push);
  setMobileOpen(true);
  renderList();

  const interests = matchInterests();
  state.matching = { startedAt: Date.now(), interests, busy: false, timers: [] };
  const chips = interests.length
    ? `<ul class="chip-list" role="list" aria-label="Matching on">${interests.map((s) => `<li class="chip chip--static">${esc(state.labels[s] || s)}</li>`).join('')}</ul>`
    : '<p>Matching with anyone.</p>';
  main.innerHTML = `<div class="chat-matching" aria-live="polite">
    <div class="match-pulse" aria-hidden="true"><span class="icon-badge">${icon('shuffle')}</span></div>
    <h2>Finding someone for you…</h2>
    <p class="match-timer" id="match-timer">0:00</p>
    ${chips}
    <button class="btn btn--secondary" type="button" data-action="cancel-match">Cancel</button>
  </div>`;
  main.querySelector('.chat-matching').insertAdjacentHTML('afterbegin',
    `<button class="icon-button chat-back chat-setup__back" type="button" data-action="cancel-match" aria-label="Stop matching">${icon('arrow-left')}</button>`);

  const m = state.matching;
  m.timers.push(setInterval(() => {
    const seconds = Math.floor((Date.now() - m.startedAt) / 1000);
    const el = document.getElementById('match-timer');
    if (el) el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000));
  m.timers.push(setInterval(pollMatch, MATCH_POLL_MS));
  pollMatch();
}

async function pollMatch() {
  const m = state.matching;
  if (!m || m.busy) return;
  m.busy = true;
  let result;
  try {
    result = await api.requestMatch('text', m.interests);
  } catch (error) {
    if (state.matching !== m) return;
    stopMatching();
    if (error?.code === 'PGRST202') {
      renderMainMessage('Random chat isn’t available yet', 'Matching hasn’t been switched on for JoloMeet yet. Please check back soon.');
    } else {
      renderMainMessage('Couldn’t start matching', friendlyError(error), { retry: () => startMatching({ push: false }) });
    }
    return;
  } finally {
    m.busy = false;
  }
  if (state.matching !== m) return;
  if (result?.status === 'matched' && result.conversation_id) {
    stopMatching();
    toast('Matched! Say hi 👋', { type: 'success' });
    await refreshList();
    openConversation(result.conversation_id, { push: false, intro: result.shared_interests });
  }
}

function stopMatching() {
  state.matching?.timers.forEach(clearInterval);
  state.matching = null;
}

/** Stops searching and goes back to the setup screen, where interests can be changed. */
function cancelMatching() {
  stopMatching();
  api.leaveMatchQueue().catch(() => {});
  renderMatchSetup({ push: false });
}

/* =========================================================================
   Realtime
   ========================================================================= */

function subscribeRealtime() {
  api.subscribeToInbox(state.me.id, {
    onMessage(message) {
      onIncomingMessage(message);
      refreshListSoon();
    },
    onMessageUpdate(message) {
      if (state.active?.id === message.conversation_id) {
        upsertMessage({ ...message, status: 'sent' });
        renderMessages();
      }
      refreshListSoon();
    },
    onParticipant(row) {
      const a = state.active;
      if (a?.id === row.conversation_id) {
        if (row.user_id === state.me.id) {
          a.myStatus = row.status;
          a.isFavorite = row.is_favorite;
        } else {
          a.partnerStatus = row.status;
        }
        renderConversationState();
      }
      refreshListSoon();
    },
    onSession(session) {
      const a = state.active;
      if (a?.session?.id === session.id) {
        a.session = { ...a.session, ...session };
        renderConversationState();
      }
      refreshListSoon();
    },
    onMatched() {
      if (state.matching) pollMatch();
    },
  }).catch(() => {
    // without realtime the page still works; the list refreshes on actions and matching polls
  });
}

/* =========================================================================
   Profile panel, report and block
   ========================================================================= */

function bindPanel() {
  panel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'close-panel') setPanelOpen(false);
    if (button.dataset.action === 'report') handleReport();
    if (button.dataset.action === 'block') handleBlock();
    if (button.dataset.action === 'unblock') handleUnblock(button);
  });
  backdrop.addEventListener('click', () => setPanelOpen(false));
  wideScreen.addEventListener('change', () => setPanelOpen(state.panelOpen));
}

function setPanelOpen(open) {
  state.panelOpen = open && Boolean(state.active);
  panel.hidden = !state.panelOpen;
  backdrop.hidden = !state.panelOpen || wideScreen.matches;
  app.classList.toggle('has-panel', state.panelOpen);
  main.querySelectorAll('[data-action="panel"]').forEach((b) => b.setAttribute('aria-expanded', String(state.panelOpen)));
  if (state.panelOpen && !wideScreen.matches) panel.querySelector('.chat-panel__close')?.focus();
}

function renderPanel() {
  const a = state.active;
  if (!a) return;
  const p = a.partner.profile;
  const online = isOnline(a.partner.id);
  const seen = state.presence.get(a.partner.id);
  const status = online ? 'Online now' : seen ? `Active ${timeAgo(seen)}` : '';
  const age = p?.age ? `<span class="text-muted">, ${esc(p.age)}</span>` : '';
  const gender = a.partner.gender ? `<p class="text-muted">${esc(a.partner.gender)}</p>` : '';

  let interests = '';
  if (p?.interests?.length) {
    const shared = new Set(p.shared_interests || []);
    interests = `<section class="chat-panel__section">
      <h3>Interests</h3>
      <ul class="chip-list" role="list">${p.interests.map((s) => `<li class="chip chip--static${shared.has(s) ? ' chip--shared' : ''}">${esc(state.labels[s] || s)}</li>`).join('')}</ul>
      ${shared.size ? '<span class="chip-legend">Shared with you</span>' : ''}
    </section>`;
  }
  const bio = p?.bio ? `<section class="chat-panel__section"><h3>About</h3><p>${esc(p.bio)}</p></section>` : '';
  const viewProfile = p && !p.is_guest
    ? `<a class="btn btn--secondary btn--block" href="profile.html?id=${esc(a.partner.id)}">${icon('user', 'icon icon--sm')}View Profile</a>`
    : '';
  const block = a.blocked
    ? `<button class="btn btn--secondary btn--block" type="button" data-action="unblock">${icon('ban', 'icon icon--sm')}Unblock</button>`
    : `<button class="btn btn--ghost btn--block" type="button" data-action="block">${icon('ban', 'icon icon--sm')}Block</button>`;

  panel.innerHTML = `
    <button class="icon-button chat-panel__close" type="button" data-action="close-panel" aria-label="Close profile details">${icon('close')}</button>
    ${avatarHtml(a.partner.name, a.partner.avatarUrl)}
    <div>
      <h2>${esc(a.partner.name)}${age}</h2>
      ${gender}
      ${status ? `<p class="text-muted">${esc(status)}</p>` : ''}
    </div>
    ${bio}
    ${interests}
    ${a.partner.id ? `<div class="chat-panel__actions">
      ${viewProfile}
      <button class="btn btn--ghost btn--block" type="button" data-action="report">${icon('flag', 'icon icon--sm')}Report</button>
      ${block}
    </div>` : ''}`;
}

function handleReport() {
  const a = state.active;
  if (!a?.partner.id) return;
  openReportDialog({
    name: a.partner.name,
    onSubmit: async ({ reason, details, alsoBlock }) => {
      await api.reportUser({
        reportedUserId: a.partner.id,
        context: 'text_chat',
        reason,
        details,
        conversationId: a.id,
        sessionId: a.session?.id,
      });
      if (alsoBlock) await blockPartner(a, 'reported');
      toast('Thanks. Our moderators will review your report.', { type: 'success' });
    },
  });
}

async function handleBlock() {
  const a = state.active;
  if (!a?.partner.id) return;
  const ok = await confirmAction({
    title: `Block ${a.partner.name}?`,
    message: 'They won’t be able to message you, call you or find you. You can unblock them later.',
    confirmLabel: 'Block',
  });
  if (!ok || state.active !== a) return;
  try {
    await blockPartner(a, 'ended');
    toast(`${a.partner.name} is blocked.`);
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  }
}

async function blockPartner(a, endReason) {
  try {
    await api.blockUser(state.me.id, a.partner.id);
  } catch (error) {
    if (error?.code !== '23505') throw error; // already blocked
  }
  if (isLiveRandom(a)) {
    await api.endMatchSession(a.session.id, endReason).catch(() => {});
    a.session = { ...a.session, status: 'ended', ended_by: state.me.id, end_reason: endReason };
  }
  a.blocked = true;
  if (state.active === a) renderConversationState();
  refreshListSoon();
}

async function handleUnblock(button) {
  const a = state.active;
  setLoading(button, true);
  try {
    await api.unblockUser(state.me.id, a.partner.id);
    a.blocked = false;
    if (state.active === a) renderConversationState();
    toast(`${a.partner.name} is unblocked.`);
  } catch (error) {
    setLoading(button, false);
    toast(friendlyError(error), { type: 'error' });
  }
}

/** Guests are reminded (once, quietly) how to keep their chats. */
function showGuestNotice() {
  const note = document.createElement('p');
  note.className = 'chat-guest-note';
  note.innerHTML = `${icon('user-plus', 'icon icon--sm')}<span>You're chatting without an account. <a href="register.html">Create one</a> to keep your chats.</span>`;
  document.querySelector('.chat-sidebar__top').append(note);
}
