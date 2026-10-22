// Message notifications: a chime, a pop-up card inside the page, and a system
// notification plus a count in the tab title when the page is in the background.
// Settings: notify_messages and sound_enabled (your account, all devices) and
// "pop-ups on this device" (this browser only). Works while JoloMeet is open.
import * as api from './api.js';
import { icon, esc, avatarHtml } from './ui.js';

const POPUPS_KEY = 'jolomeet:popups';
const BASE_TITLE = document.title;

let settings = null;          // cached { notify_messages, sound_enabled, ... }
let settingsLoad = null;
let viewing = null;           // conversation on screen (no alerts for it while visible)
let unseen = 0;               // messages that arrived while the tab was hidden
const senders = new Map();    // user id -> Promise<{ name, avatarUrl }>
const muted = new Map();      // conversation id -> Promise<boolean>

/* ---------- settings ---------- */

export function loadSettings() {
  settingsLoad ??= api.getMySettings()
    .then((row) => { settings = row || { notify_messages: true, sound_enabled: true }; return settings; })
    .catch(() => { settingsLoad = null; return { notify_messages: true, sound_enabled: true }; });
  return settings ? Promise.resolve(settings) : settingsLoad;
}

/** Called by the settings page after saving, so the change applies straight away. */
export function setCachedSettings(row) {
  settings = row;
  settingsLoad = Promise.resolve(row);
}

/** System pop-ups on this device: on unless switched off here, and only if the browser allows them. */
export function popupsWanted() {
  try { return localStorage.getItem(POPUPS_KEY) !== 'off'; } catch { return true; }
}

export function setPopupsWanted(on) {
  try { localStorage.setItem(POPUPS_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
}

export function popupPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/* ---------- what's on screen ---------- */

/** The chat or call page tells us which conversation is open. */
export function setViewingConversation(id) {
  viewing = id || null;
}

/* ---------- incoming messages ---------- */

/** Decides whether and how to alert about a new message. */
export async function notifyIncoming(message, myId) {
  if (!message || !myId || message.sender_id === myId || message.kind === 'system' || message.deleted_at) return;
  if (!document.hidden && viewing === message.conversation_id) return;
  const prefs = await loadSettings();
  if (!prefs.notify_messages) return;
  if (!muted.has(message.conversation_id)) {
    muted.set(message.conversation_id, api.isConversationMuted(message.conversation_id, myId).catch(() => false));
  }
  if (await muted.get(message.conversation_id)) return;
  if (!senders.has(message.sender_id)) {
    senders.set(message.sender_id, api.getSenderSummary(message.sender_id).catch(() => ({ name: 'Someone', avatarUrl: null })));
  }
  const sender = await senders.get(message.sender_id);
  const text = previewText(message);
  const url = `chat.html?c=${encodeURIComponent(message.conversation_id)}`;

  if (prefs.sound_enabled) playChime();
  if (document.hidden) {
    unseen += 1;
    document.title = `(${unseen}) ${BASE_TITLE}`;
    showSystemNotification(sender, text, url, message.conversation_id);
  } else {
    showCard(sender, text, url);
  }
}

function previewText(message) {
  if (message.kind === 'image') return '📷 Photo';
  if (message.kind === 'voice') return '🎤 Voice message';
  const body = String(message.body || '').replace(/\s+/g, ' ').trim();
  return body.length > 90 ? `${body.slice(0, 90)}…` : body;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unseen) {
    unseen = 0;
    document.title = BASE_TITLE;
  }
});

/* ---------- system notification (page in the background) ---------- */

function showSystemNotification(sender, text, url, tag) {
  if (popupPermission() !== 'granted' || !popupsWanted()) return;
  try {
    const note = new Notification(sender.name, {
      body: text,
      icon: sender.avatarUrl || 'assets/images/logo-192.png',
      badge: 'assets/images/logo-96.png',
      tag: `jolomeet-${tag}`,      // one notification per chat, replaced by the newest
      renotify: true,
    });
    note.onclick = () => {
      window.focus();
      if (!location.pathname.endsWith('/chat.html') || !location.search.includes(tag)) location.href = url;
      note.close();
    };
  } catch {
    /* some phones only allow notifications from a service worker; the chime and title count still work */
  }
}

/* ---------- pop-up card inside the page ---------- */

let cardRegion;

function showCard(sender, text, url) {
  if (!cardRegion) {
    cardRegion = document.createElement('div');
    cardRegion.className = 'notify-region';
    cardRegion.setAttribute('role', 'status');
    cardRegion.setAttribute('aria-live', 'polite');
    document.body.append(cardRegion);
  }
  const card = document.createElement('a');
  card.className = 'notify-card';
  card.href = url;
  card.innerHTML = `${avatarHtml(sender.name, sender.avatarUrl)}
    <span class="notify-card__text"><strong>${esc(sender.name)}</strong><span>${esc(text)}</span></span>
    <span class="notify-card__go">${icon('chat')}</span>`;
  cardRegion.prepend(card);
  while (cardRegion.children.length > 3) cardRegion.lastElementChild.remove();
  setTimeout(() => {
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 300);
  }, 5000);
}

/* ---------- sound ---------- */

let audio;

// Browsers only allow sound after the person has interacted with the page once.
['pointerdown', 'keydown'].forEach((type) => window.addEventListener(type, () => {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no Web Audio */ }
}, { once: true, capture: true }));

/** A short two-note chime, made with Web Audio so there's no file to download. */
export function playChime() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const start = audio.currentTime + 0.01;
    [[880, 0], [1318.5, 0.13]].forEach(([frequency, offset]) => {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.4);
      tone.connect(gain).connect(audio.destination);
      tone.start(start + offset);
      tone.stop(start + offset + 0.45);
    });
  } catch {
    /* sound isn't available: notifications still show */
  }
}
