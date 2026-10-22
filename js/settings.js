// Settings page: message notifications, their sound, and system pop-ups on
// this device. The first two are saved to user_settings (your account); the
// pop-up choice is kept in this browser. See js/notify.js for how alerts work.
import { initApp, toast } from './app.js';
import * as api from './api.js';
import { friendlyError } from './ui.js';
import {
  setCachedSettings, popupsWanted, setPopupsWanted, popupPermission, playChime,
} from './notify.js';

const root = document.getElementById('settings-root');
const alertBox = document.getElementById('settings-alert');
const messagesSwitch = document.getElementById('set-notify-messages');
const soundSwitch = document.getElementById('set-sound');
const popupsSwitch = document.getElementById('set-popups');
const popupStatus = document.getElementById('popup-status');
const allowButton = document.getElementById('allow-popups');

let me = null;

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
    window.location.replace(`login.html?next=${encodeURIComponent('settings.html')}`);
    return;
  }
  me = session.user;

  try {
    const row = await api.getMySettings();
    if (!row) throw new Error('Your settings could not be found. Please refresh the page.');
    show(row);
    messagesSwitch.disabled = false;
    soundSwitch.disabled = false;
  } catch (error) {
    alertBox.textContent = friendlyError(error);
    alertBox.hidden = false;
  }
  renderPopups();
  root.removeAttribute('aria-busy');
}

function show(row) {
  messagesSwitch.checked = !!row.notify_messages;
  soundSwitch.checked = !!row.sound_enabled;
  setCachedSettings(row);
}

async function save(input, field) {
  const wanted = input.checked;
  input.disabled = true;
  try {
    show(await api.updateMySettings(me.id, { [field]: wanted }));
    toast('Settings saved.', { type: 'success', duration: 2000 });
  } catch (error) {
    input.checked = !wanted;
    toast(friendlyError(error), { type: 'error' });
  } finally {
    input.disabled = false;
  }
}

messagesSwitch.addEventListener('change', () => save(messagesSwitch, 'notify_messages'));
soundSwitch.addEventListener('change', () => save(soundSwitch, 'sound_enabled'));

document.getElementById('test-sound').addEventListener('click', playChime);

/* ---------- pop-ups on this device ---------- */

function renderPopups() {
  const permission = popupPermission();
  popupsSwitch.checked = permission === 'granted' && popupsWanted();
  popupsSwitch.disabled = permission === 'unsupported' || permission === 'denied';
  allowButton.hidden = permission !== 'default';
  const [text, tone] = {
    unsupported: ['This browser can\'t show notifications. You\'ll still get the chime and the in-page alert.', 'warn'],
    denied: ['Notifications are blocked for this site. Allow them in your browser\'s site settings, then reload this page.', 'warn'],
    default: ['Your browser hasn\'t been asked yet.', ''],
    granted: [popupsWanted() ? 'Allowed on this device.' : 'Allowed by your browser, switched off here.', 'ok'],
  }[permission];
  popupStatus.textContent = text;
  if (tone) popupStatus.dataset.tone = tone; else delete popupStatus.dataset.tone;
}

async function askPermission() {
  try {
    await Notification.requestPermission();
  } catch {
    /* older browsers: the state below tells the person what happened */
  }
  if (popupPermission() === 'granted') setPopupsWanted(true);
  renderPopups();
}

allowButton.addEventListener('click', askPermission);

popupsSwitch.addEventListener('change', async () => {
  if (popupsSwitch.checked && popupPermission() === 'default') {
    await askPermission();
    return;
  }
  setPopupsWanted(popupsSwitch.checked);
  renderPopups();
});
