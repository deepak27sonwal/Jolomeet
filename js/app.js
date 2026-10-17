// Shared bootstrapping and small utilities used by every page.
import { initNavigation } from './navigation.js';

export function initApp() {
  initNavigation();
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
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
