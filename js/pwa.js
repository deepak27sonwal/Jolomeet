// Installable app support: registers the service worker (sw.js) and lets the
// Settings page offer "Install" when the browser says the site can be installed.
let installEvent = null;
const listeners = new Set();

function changed() {
  listeners.forEach((listener) => listener());
}

// Chrome fires this only when the site meets the install rules and isn't installed yet.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); // keep it, so our own Install button can show the prompt
  installEvent = event;
  changed();
});

window.addEventListener('appinstalled', () => {
  installEvent = null;
  changed();
});

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the site works fine without it */ });
  });
}

/** Running as an installed app (opened from the home screen). */
export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function canInstall() {
  return Boolean(installEvent);
}

/** Shows the browser's install prompt. Resolves to 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  if (!installEvent) return 'unavailable';
  const event = installEvent;
  installEvent = null;
  event.prompt();
  const { outcome } = await event.userChoice;
  changed();
  return outcome;
}

export function onInstallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
