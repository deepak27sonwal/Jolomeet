// Profile page: your own profile (with editing) or someone else's (with
// chat, video, connect, report and block). profile.html?id=<user id>
import { initApp, toast } from './app.js';
import * as api from './api.js';
import { validateDisplayName } from './validation.js';

const SPRITE = 'assets/icons/sprite.svg';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INTERESTS = 10;
const MAX_LANGUAGES = 5;
const LANGUAGES = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', ur: 'Urdu',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ar: 'Arabic',
  ru: 'Russian', tr: 'Turkish', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};

const root = document.getElementById('profile-root');
let me = null;          // signed-in auth user
let profile = null;     // row from get_profile
let allInterests = [];  // interest catalogue

initApp();
initDialogs();
init();

async function init() {
  const requested = new URLSearchParams(window.location.search).get('id');
  if (requested && !UUID_RE.test(requested)) return renderState('not-found');

  let session = null;
  try {
    session = await api.getSession();
  } catch {
    /* treated as signed out */
  }
  if (!session) {
    const next = encodeURIComponent(`profile.html${window.location.search}`);
    window.location.replace(`login.html?next=${next}`);
    return;
  }
  me = session.user;
  const userId = requested || me.id;
  if (userId === me.id && me.is_anonymous) return renderState('guest');
  await load(userId);
}

async function load(userId) {
  root.setAttribute('aria-busy', 'true');
  try {
    const [row, interests] = await Promise.all([api.getProfile(userId), api.fetchInterests()]);
    allInterests = interests;
    if (!row) return renderState('not-found');
    profile = row;
    render();
  } catch (error) {
    console.error('Could not load profile', error);
    renderState('error', () => load(userId));
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
}

/* ================= Rendering ================= */

function render() {
  const p = profile;
  const isOwner = p.is_owner;
  const coverUrl = api.publicImageUrl('covers', p.cover_path);
  document.title = `${p.display_name} · JoloMeet`;

  root.innerHTML = `
    <section class="card profile-hero" aria-labelledby="profile-name">
      <div class="profile-cover">${coverUrl ? `<img src="${esc(coverUrl)}" alt="">` : ''}</div>
      <div class="profile-head">
        ${avatarHtml(p, 'profile-avatar')}
        <div class="profile-identity">
          <h1 id="profile-name">${esc(p.display_name)}${p.age ? `, ${p.age}` : ''}</h1>
          ${p.username ? `<p class="profile-username">@${esc(p.username)}</p>` : ''}
          <p class="profile-meta">${presenceHtml(p)}<span>${icon('clock')}Joined ${esc(formatJoined(p.joined_at))}</span></p>
        </div>
        <div class="profile-actions" id="profile-actions">${isOwner ? ownerActionsHtml() : visitorActionsHtml(p)}</div>
      </div>
      <div class="profile-stats">${statsHtml(p)}</div>
    </section>

    <div class="profile-grid">
      <section class="card profile-section" aria-labelledby="about-title">
        <h2 id="about-title">About</h2>
        ${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>`
                : `<p class="profile-muted">${isOwner ? 'Add a short bio so people know what you\'re about.' : 'No bio yet.'}</p>`}
        ${p.languages?.length ? `
          <h2>Languages</h2>
          <div class="chip-list">${p.languages.map((code) => `<span class="chip chip--static">${icon('languages', 'icon chip__icon')}${esc(LANGUAGES[code] || code)}</span>`).join('')}</div>` : ''}
      </section>

      <section class="card profile-section" aria-labelledby="interests-title">
        <h2 id="interests-title">Interests</h2>
        ${interestsHtml(p, isOwner)}
      </section>
    </div>

    ${isOwner ? '' : `
      <section class="card profile-section" aria-labelledby="safety-title">
        <h2 id="safety-title">Safety</h2>
        <p class="profile-muted">Something not right? Reports are confidential, and blocking stops all contact.</p>
        <div class="profile-safety">
          <button class="btn btn--secondary btn--sm" type="button" data-action="report">${icon('flag', 'icon icon--sm')}Report</button>
          <button class="btn btn--secondary btn--sm" type="button" data-action="block">${icon('ban', 'icon icon--sm')}Block</button>
        </div>
      </section>`}
  `;
  bindActions();
}

function ownerActionsHtml() {
  return `<button class="btn btn--primary" type="button" data-action="edit">${icon('edit', 'icon icon--sm')}Edit Profile</button>`;
}

function visitorActionsHtml(p) {
  if (me.is_anonymous) {
    return `<a class="btn btn--primary" href="register.html">${icon('user-plus', 'icon icon--sm')}Create Account to Connect</a>`;
  }
  const chat = p.can_message
    ? `<button class="btn btn--primary" type="button" data-action="chat">${icon('chat', 'icon icon--sm')}Start Chat</button>`
    : `<button class="btn btn--primary" type="button" disabled title="${esc(p.display_name)} only accepts messages from connections">${icon('chat', 'icon icon--sm')}Start Chat</button>`;
  const video = p.can_video
    ? `<button class="btn btn--video" type="button" data-action="video">${icon('video', 'icon icon--sm')}Start Video</button>`
    : '';
  return chat + video + connectionButtonHtml(p);
}

function connectionButtonHtml(p) {
  if (p.is_guest) return '';
  switch (p.connection_status) {
    case 'none':
      return `<button class="btn btn--secondary" type="button" data-action="connect">${icon('user-plus', 'icon icon--sm')}Connect</button>`;
    case 'outgoing':
      return `<button class="btn btn--secondary" type="button" data-action="cancel-request" aria-label="Request sent. Cancel request">${icon('clock', 'icon icon--sm')}Request Sent</button>`;
    case 'incoming':
      return `<button class="btn btn--secondary" type="button" data-action="accept">${icon('user-check', 'icon icon--sm')}Accept</button>
              <button class="btn btn--secondary" type="button" data-action="decline">Decline</button>`;
    case 'connected':
      return `<button class="btn btn--secondary" type="button" data-action="remove-connection" aria-label="Connected. Remove connection">${icon('user-check', 'icon icon--sm')}Connected</button>`;
    default:
      return '';
  }
}

function statsHtml(p) {
  const stat = (value, label) => `<div class="profile-stat"><strong>${value}</strong><span>${label}</span></div>`;
  if (p.is_owner) {
    return stat(p.connection_count, plural(p.connection_count, 'Connection'))
      + stat(p.interests.length, plural(p.interests.length, 'Interest'))
      + stat(p.languages.length, plural(p.languages.length, 'Language'));
  }
  return stat(p.connection_count, plural(p.connection_count, 'Connection'))
    + stat(p.mutual_connections, 'Mutual')
    + stat(p.shared_interests.length, 'Shared Interests');
}

function interestsHtml(p, isOwner) {
  if (!p.interests.length) {
    return `<p class="profile-muted">${isOwner ? 'Pick a few interests to get better matches.' : 'No interests added yet.'}</p>`;
  }
  const shared = new Set(p.shared_interests);
  const labels = Object.fromEntries(allInterests.map((i) => [i.slug, i.label]));
  const chips = p.interests.map((slug) => {
    const isShared = !isOwner && shared.has(slug);
    return `<span class="chip chip--static${isShared ? ' chip--shared' : ''}">${esc(labels[slug] || slug)}</span>`;
  }).join('');
  const legend = !isOwner && shared.size ? '<span class="chip-legend">Shared with you</span>' : '';
  return `<div class="chip-list">${chips}</div>${legend}`;
}

function presenceHtml(p) {
  if (p.is_online) return '<span class="is-online"><span class="status-dot" aria-hidden="true"></span>Online now</span>';
  if (p.last_seen_at) return `<span>Active ${esc(timeAgo(p.last_seen_at))}</span>`;
  return ''; // they hide their status, or it's unknown
}

function avatarHtml(p, extraClass = '') {
  const url = api.publicImageUrl('avatars', p.avatar_path);
  const inner = url ? `<img src="${esc(url)}" alt="">` : esc(initials(p.display_name));
  return `<span class="avatar ${extraClass}" role="img" aria-label="${esc(p.display_name)}">${inner}</span>`;
}

function renderState(kind, retry) {
  const states = {
    'not-found': ['user', "This profile isn't available",
      'It may be private, or the account may no longer exist.',
      '<a class="btn btn--primary" href="explore.html">Explore People</a>'],
    guest: ['user-plus', "You're browsing as a guest",
      'Create a free account to get your own profile, make connections and keep your chats.',
      '<a class="btn btn--primary" href="register.html">Create Account</a>'],
    blocked: ['ban', `You blocked ${esc(profile?.display_name || 'this person')}`,
      "They can't see your profile, message you or be matched with you.",
      '<button class="btn btn--secondary" type="button" data-action="unblock">Unblock</button>'],
    error: ['alert', "We couldn't load this profile",
      'Check your connection and try again.',
      '<button class="btn btn--primary" type="button" data-action="retry">Try Again</button>'],
  };
  const [ic, title, text, action] = states[kind];
  root.innerHTML = `
    <section class="card profile-state" aria-labelledby="state-title">
      <span class="icon-badge">${icon(ic)}</span>
      <h1 id="state-title">${title}</h1>
      <p>${text}</p>
      ${action}
    </section>`;
  root.setAttribute('aria-busy', 'false');
  root.querySelector('[data-action="retry"]')?.addEventListener('click', retry);
  root.querySelector('[data-action="unblock"]')?.addEventListener('click', handleUnblock);
}

/* ================= Actions ================= */

function bindActions() {
  const handlers = {
    edit: openEditDialog,
    chat: handleStartChat,
    video: handleStartVideo,
    connect: handleConnect,
    'cancel-request': () => handleRemoveConnection('Cancel request?', `Cancel your connection request to ${profile.display_name}?`, 'Cancel Request'),
    'remove-connection': () => handleRemoveConnection('Remove connection?', `You and ${profile.display_name} will no longer be connected.`, 'Remove'),
    accept: () => handleRespond(true),
    decline: () => handleRespond(false),
    report: openReportDialog,
    block: handleBlock,
  };
  root.querySelectorAll('[data-action]').forEach((btn) => {
    const handler = handlers[btn.dataset.action];
    if (handler) btn.addEventListener('click', (event) => handler(event.currentTarget));
  });
}

async function handleStartChat(button) {
  await withLoading(button, async () => {
    const conversationId = await api.startDirectConversation(profile.id);
    window.location.assign(`chat.html?c=${encodeURIComponent(conversationId)}`);
  });
}

async function handleStartVideo(button) {
  await withLoading(button, async () => {
    const sessionId = await api.startDirectCall(profile.id);
    window.location.assign(`video.html?session=${encodeURIComponent(sessionId)}`);
  });
}

async function handleConnect(button) {
  await withLoading(button, async () => {
    await api.sendConnectionRequest(me.id, profile.id);
    profile.connection_status = 'outgoing';
    render();
    toast(`Connection request sent to ${profile.display_name}.`, { type: 'success' });
  });
}

async function handleRemoveConnection(title, message, confirmLabel) {
  if (!(await confirmAction({ title, message, confirmLabel }))) return;
  try {
    const connection = await api.getConnectionWith(me.id, profile.id);
    if (connection) await api.removeConnection(connection.id);
    if (profile.connection_status === 'connected') profile.connection_count -= 1;
    profile.connection_status = 'none';
    render();
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  }
}

async function handleRespond(accept) {
  try {
    const connection = await api.getConnectionWith(me.id, profile.id);
    if (!connection) throw new Error('missing');
    await api.respondToConnection(connection.id, accept);
    profile.connection_status = accept ? 'connected' : 'declined';
    if (accept) profile.connection_count += 1;
    render();
    toast(accept ? `You're now connected with ${profile.display_name}!` : 'Request declined.', { type: 'success' });
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  }
}

async function handleBlock() {
  const ok = await confirmAction({
    title: `Block ${profile.display_name}?`,
    message: "They won't be able to see your profile, message you or be matched with you. They won't be notified.",
    confirmLabel: 'Block',
  });
  if (!ok) return;
  try {
    await api.blockUser(me.id, profile.id);
    renderState('blocked');
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  }
}

async function handleUnblock(event) {
  await withLoading(event.currentTarget, async () => {
    await api.unblockUser(me.id, profile.id);
    toast(`${profile.display_name} is unblocked.`, { type: 'success' });
    await load(profile.id);
  });
}

/* ================= Report dialog ================= */

function openReportDialog() {
  const dialog = document.getElementById('report-dialog');
  document.getElementById('report-title').textContent = `Report ${profile.display_name}`;
  document.getElementById('report-form').reset();
  setFieldError('report-reason', '');
  hideAlert('report-alert');
  dialog.showModal();
}

async function submitReport(event) {
  event.preventDefault();
  const reason = document.getElementById('report-reason');
  if (!reason.value) {
    setFieldError('report-reason', 'Choose a reason.');
    reason.focus();
    return;
  }
  setFieldError('report-reason', '');
  const alsoBlock = document.getElementById('report-block').checked;
  const button = event.currentTarget.querySelector('[type="submit"]');
  setLoading(button, true);
  try {
    await api.reportUser({
      reportedUserId: profile.id,
      context: 'profile',
      reason: reason.value,
      details: document.getElementById('report-details').value.trim(),
    });
    if (alsoBlock) await api.blockUser(me.id, profile.id);
    document.getElementById('report-dialog').close();
    toast('Thanks. Your report has been sent to our moderators.', { type: 'success' });
    if (alsoBlock) renderState('blocked');
  } catch (error) {
    showAlert('report-alert', friendlyError(error));
  } finally {
    setLoading(button, false);
  }
}

/* ================= Edit dialog ================= */

const edit = { row: null, interests: [], languages: [], files: { avatars: null, covers: null }, previews: [] };

async function openEditDialog(button) {
  await withLoading(button, async () => {
    edit.row = await api.getMyProfileRow(me.id);
  });
  if (!edit.row) return;
  const row = edit.row;
  edit.interests = [...profile.interests];
  edit.languages = [...(row.languages || [])];
  edit.files = { avatars: null, covers: null };

  document.getElementById('edit-name').value = row.display_name;
  document.getElementById('edit-username').value = row.username || '';
  document.getElementById('edit-bio').value = row.bio || '';
  document.getElementById('edit-visibility').value = row.visibility;
  document.getElementById('edit-show-age').checked = row.show_age;
  document.getElementById('edit-show-online').checked = row.show_online_status;
  updateBioCounter();
  setAvatarPreview(api.publicImageUrl('avatars', row.avatar_path));
  setCoverPreview(api.publicImageUrl('covers', row.cover_path));
  ['edit-name', 'edit-username', 'edit-bio', 'edit-avatar', 'edit-cover'].forEach((id) => setFieldError(id, ''));
  document.getElementById('edit-avatar').value = '';
  document.getElementById('edit-cover').value = '';
  hideAlert('edit-alert');

  renderChoiceChips('edit-interests', allInterests.map((i) => [i.slug, i.label]), edit.interests, MAX_INTERESTS, 'interests');
  renderChoiceChips('edit-languages', Object.entries(LANGUAGES), edit.languages, MAX_LANGUAGES, 'languages');
  document.getElementById('edit-dialog').showModal();
}

function renderChoiceChips(containerId, options, selected, max, noun) {
  const container = document.getElementById(containerId);
  container.replaceChildren(...options.map(([value, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(selected.includes(value)));
    chip.addEventListener('click', () => {
      const index = selected.indexOf(value);
      if (index >= 0) {
        selected.splice(index, 1);
      } else if (selected.length >= max) {
        toast(`You can pick up to ${max} ${noun}.`);
        return;
      } else {
        selected.push(value);
      }
      chip.setAttribute('aria-pressed', String(selected.includes(value)));
    });
    return chip;
  }));
}

function onImagePicked(event, bucket) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  const rules = api.IMAGE_RULES[bucket];
  setFieldError(input.id, '');
  if (!file) return;
  if (!rules.types.includes(file.type)) {
    setFieldError(input.id, 'Please choose a JPG, PNG or WebP image.');
    input.value = '';
    return;
  }
  if (file.size > rules.maxBytes) {
    setFieldError(input.id, `That image is too large. The limit is ${rules.maxBytes / (1024 * 1024)} MB.`);
    input.value = '';
    return;
  }
  edit.files[bucket] = file;
  const url = URL.createObjectURL(file);
  edit.previews.push(url);
  if (bucket === 'avatars') setAvatarPreview(url);
  else setCoverPreview(url);
}

function setAvatarPreview(url) {
  const el = document.getElementById('edit-avatar-preview');
  el.replaceChildren();
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.append(img);
  } else {
    el.textContent = initials(document.getElementById('edit-name').value || profile.display_name);
  }
}

function setCoverPreview(url) {
  const el = document.getElementById('edit-cover-preview');
  el.replaceChildren();
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.append(img);
  }
}

function updateBioCounter() {
  const bio = document.getElementById('edit-bio');
  document.getElementById('edit-bio-counter').textContent = `${bio.value.length}/300`;
}

async function submitEdit(event) {
  event.preventDefault();
  hideAlert('edit-alert');
  const name = document.getElementById('edit-name');
  const username = document.getElementById('edit-username');
  const bio = document.getElementById('edit-bio');
  const usernameValue = username.value.trim().toLowerCase();

  const nameError = validateDisplayName(name.value);
  const usernameError = usernameValue && !/^[a-z0-9_]{3,20}$/.test(usernameValue)
    ? 'Use 3–20 lowercase letters, numbers or underscores.' : '';
  const bioError = bio.value.trim().length > 300 ? 'Keep your bio to 300 characters.' : '';
  setFieldError('edit-name', nameError);
  setFieldError('edit-username', usernameError);
  setFieldError('edit-bio', bioError);
  const firstInvalid = [[name, nameError], [username, usernameError], [bio, bioError]].find(([, e]) => e);
  if (firstInvalid) {
    firstInvalid[0].focus();
    return;
  }

  const button = event.currentTarget.querySelector('[type="submit"]');
  setLoading(button, true);
  const uploaded = {};
  try {
    for (const bucket of ['avatars', 'covers']) {
      if (edit.files[bucket]) uploaded[bucket] = await api.uploadProfileImage(bucket, me.id, edit.files[bucket]);
    }
    const fields = {
      display_name: name.value.trim(),
      username: usernameValue || null,
      bio: bio.value.trim() || null,
      languages: edit.languages,
      visibility: document.getElementById('edit-visibility').value,
      show_age: document.getElementById('edit-show-age').checked,
      show_online_status: document.getElementById('edit-show-online').checked,
    };
    if (uploaded.avatars) fields.avatar_path = uploaded.avatars;
    if (uploaded.covers) fields.cover_path = uploaded.covers;

    await api.updateMyProfile(me.id, fields);
    await api.setMyInterests(me.id, profile.interests, edit.interests);

    // tidy up replaced images now that the profile points at the new ones
    if (uploaded.avatars) api.removeProfileImage('avatars', edit.row.avatar_path);
    if (uploaded.covers) api.removeProfileImage('covers', edit.row.cover_path);

    document.getElementById('edit-dialog').close();
    toast('Your profile is saved.', { type: 'success' });
    await load(me.id);
  } catch (error) {
    // don't leave freshly uploaded files behind if the save failed
    Object.entries(uploaded).forEach(([bucket, path]) => api.removeProfileImage(bucket, path));
    if (error?.code === '23505') {
      setFieldError('edit-username', 'That username is taken. Try another one.');
      username.focus();
    } else {
      showAlert('edit-alert', friendlyError(error));
    }
  } finally {
    setLoading(button, false);
  }
}

/* ================= Dialog plumbing ================= */

function initDialogs() {
  document.querySelectorAll('dialog [data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });
  document.getElementById('edit-form').addEventListener('submit', submitEdit);
  document.getElementById('report-form').addEventListener('submit', submitReport);
  document.getElementById('edit-bio').addEventListener('input', updateBioCounter);
  document.getElementById('edit-avatar').addEventListener('change', (e) => onImagePicked(e, 'avatars'));
  document.getElementById('edit-cover').addEventListener('change', (e) => onImagePicked(e, 'covers'));
  document.getElementById('edit-dialog').addEventListener('close', () => {
    edit.previews.forEach((url) => URL.revokeObjectURL(url));
    edit.previews = [];
  });
}

function confirmAction({ title, message, confirmLabel }) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-yes').textContent = confirmLabel;
  return new Promise((resolve) => {
    const onClick = (event) => {
      const choice = event.target.closest('[data-confirm]');
      if (!choice) return;
      dialog.close(choice.dataset.confirm);
    };
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('click', onClick);
      resolve(dialog.returnValue === 'yes');
    }, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    dialog.querySelector('[data-confirm="no"]').focus();
  });
}

/* ================= Small helpers ================= */

async function withLoading(button, task) {
  setLoading(button, true);
  try {
    await task();
  } catch (error) {
    toast(friendlyError(error), { type: 'error' });
  } finally {
    if (button.isConnected) setLoading(button, false);
  }
}

function setLoading(button, loading) {
  button.classList.toggle('is-loading', loading);
  button.disabled = loading;
  button.setAttribute('aria-busy', String(loading));
}

function setFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  input?.setAttribute('aria-invalid', String(Boolean(message)));
  const el = document.getElementById(`${inputId}-error`);
  if (!el) return;
  el.replaceChildren();
  if (message) {
    el.insertAdjacentHTML('afterbegin', icon('alert'));
    el.append(document.createTextNode(message));
  }
}

function showAlert(id, message) {
  const el = document.getElementById(id);
  el.className = 'alert alert--error';
  el.innerHTML = icon('alert');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  el.hidden = false;
}

function hideAlert(id) {
  document.getElementById(id).hidden = true;
}

function friendlyError(error) {
  const message = error?.message || '';
  if (error instanceof TypeError || /failed to fetch|network/i.test(message)) {
    return "We can't reach JoloMeet right now. Check your connection and try again.";
  }
  // messages raised by our database functions are written for people
  if (['JM400', 'JM403', 'JM404', 'JM409', 'JM429'].includes(error?.code)) return message;
  if (error?.code === '23505') return 'That was already done.';
  if (/payload too large|exceeded the maximum/i.test(message)) return 'That image is too large.';
  return 'Something went wrong. Please try again.';
}

function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#${name}"/></svg>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

function formatJoined(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function timeAgo(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
