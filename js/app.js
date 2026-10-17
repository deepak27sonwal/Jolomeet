// Shared bootstrapping and small utilities used by every page.
import { initNavigation } from './navigation.js';
import { getSession, signOut, touchPresence } from './api.js';
import { initReveal } from './motion.js';

export function initApp() {
  initNavigation();
  initAuthHeader();
  initReveal();
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
}

/** Swaps the Login / Get Started buttons for account actions once signed in. */
async function initAuthHeader() {
  let session;
  try {
    session = await getSession();
  } catch {
    return; // keep the signed-out header
  }
  if (!session) return;
  startPresenceHeartbeat();

  const guest = session.user.is_anonymous;
  const primary = guest
    ? { label: 'Create Account', href: 'register.html' }
    : { label: 'My Profile', href: 'profile.html' };

  const build = (extraClass = '') => {
    const link = document.createElement('a');
    link.className = `btn btn--secondary ${extraClass}`;
    link.href = primary.href;
    link.textContent = primary.label;
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = `btn btn--primary ${extraClass}`;
    logout.textContent = 'Log Out';
    logout.addEventListener('click', handleLogout);
    return [link, logout];
  };

  const desktop = document.querySelector('.site-header__actions');
  desktop?.querySelectorAll('.btn').forEach((el) => el.remove());
  desktop?.append(...build());
  document.querySelector('.mobile-menu__actions')?.replaceChildren(...build('btn--lg btn--block'));
}

const HEARTBEAT_MS = 30_000;

/** Keeps last_seen_at fresh while the tab is visible. */
function startPresenceHeartbeat() {
  const beat = () => {
    if (document.visibilityState === 'visible') touchPresence().catch(() => {});
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', beat);
}

async function handleLogout(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await signOut();
    window.location.assign('index.html');
  } catch {
    button.disabled = false;
    toast("Couldn't log you out. Please try again.", { type: 'error' });
  }
}

/** Shows a short message. type: 'info' | 'success' | 'error'. */
export function toast(message, { type = 'info', duration = 4000 } = {}) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  region.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

/** localStorage can be unavailable (private mode, blocked storage), so never let it throw. */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* selection simply isn't remembered */
    }
  },
};
