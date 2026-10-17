// Small rendering helpers shared by the app pages.

export const SPRITE = 'assets/icons/sprite.svg';

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#${name}"/></svg>`;
}

/** Escapes text for safe use inside HTML strings. Use for every user-provided value. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Avatar markup: the photo if there is one, otherwise initials. */
export function avatarHtml(name, url, extraClass = '') {
  const inner = url ? `<img src="${esc(url)}" alt="">` : esc(initials(name));
  return `<span class="avatar ${extraClass}" role="img" aria-label="${esc(name)}">${inner}</span>`;
}

export function timeAgo(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function setLoading(button, loading) {
  button.classList.toggle('is-loading', loading);
  button.disabled = loading;
  button.setAttribute('aria-busy', String(loading));
}

/** Turns Supabase / network errors into a sentence people can act on. */
export function friendlyError(error) {
  const message = error?.message || '';
  if (error instanceof TypeError || /failed to fetch|network/i.test(message)) {
    return "We can't reach JoloMeet right now. Check your connection and try again.";
  }
  // messages raised by our database functions are written for people
  if (['JM400', 'JM403', 'JM404', 'JM409', 'JM429'].includes(error?.code)) return message;
  if (error?.code === 'PGRST202') return "This feature isn't set up on the server yet.";
  if (error?.code === '23505') return 'That was already done.';
  if (/payload too large|exceeded the maximum/i.test(message)) return 'That file is too large.';
  return 'Something went wrong. Please try again.';
}
