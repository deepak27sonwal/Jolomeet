// Homepage: live online count and the parts that depend on who is visiting.
// Interests are picked on the matching screens (js/interest-picker.js).
import { initApp } from './app.js';
import { fetchOnlineCount, getSession } from './api.js';

initApp();
adaptToVisitor();
showOnlineCount();

/**
 * Signed-out visitors see the no-sign-up link and the sign-up buttons; people
 * chatting without an account are
 * offered the upgrade that keeps their chats; members get shortcuts instead.
 */
async function adaptToVisitor() {
  let session = null;
  try {
    session = await getSession();
  } catch {
    return; // keep the signed-out version
  }
  if (!session) return;
  document.getElementById('hero-guest').hidden = true;

  const actions = document.getElementById('account-actions');
  const note = document.getElementById('account-note');
  if (session.user.is_anonymous) {
    actions.innerHTML = '<a class="btn btn--video btn--gloss" href="register.html">Create Account &amp; Keep My Chats</a>';
    note.textContent = "You're chatting without an account. Sign up and your chats come with you.";
  } else {
    actions.innerHTML = '<a class="btn btn--video btn--gloss" href="chat.html">Open My Chats</a>'
      + '<a class="btn btn--secondary" href="profile.html">My Profile</a>';
    note.textContent = "You're signed in, so all of this is already yours.";
  }
}

async function showOnlineCount() {
  try {
    const count = Number(await fetchOnlineCount());
    if (!Number.isInteger(count) || count <= 0) return; // never show "0 online" or a made-up number
    const el = document.getElementById('online-count');
    el.querySelector('[data-online-number]').textContent = count.toLocaleString();
    el.hidden = false;
  } catch (error) {
    console.warn('Online count unavailable', error);
  }
}
