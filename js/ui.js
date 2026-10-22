// Small rendering helpers shared by the app pages.

export const SPRITE = 'assets/icons/sprite.svg';

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#${name}"/></svg>`;
}

// Blip positions on the matching radar (percent of its size). Each one pings as
// the beam passes it: the beam starts at 12 o'clock and turns once every RADAR_TURN_S.
const RADAR_BLIPS = [[72, 24], [24, 34], [80, 66], [36, 78], [58, 12]];
const RADAR_TURN_S = 4; // keep in step with the radar-spin animation in components.css

/**
 * The "looking for someone" radar: rings, a sweeping beam and pinging person
 * icons around a beating heart with `iconName` inside. Decorative only; the
 * blips are not real people. Styles: .radar in components.css.
 */
export function radarHtml(iconName, { small = false } = {}) {
  const blips = RADAR_BLIPS.map(([x, y]) => {
    const angle = (Math.atan2(x - 50, 50 - y) * 180 / Math.PI + 360) % 360; // clockwise from 12 o'clock
    const delay = (angle / 360 * RADAR_TURN_S).toFixed(2);
    return `<span class="radar__blip" style="--x:${x}%;--y:${y}%;--d:${delay}s">${icon('user')}</span>`;
  }).join('');
  return `<div class="radar${small ? ' radar--sm' : ''}" aria-hidden="true">
    <span class="radar__ring"></span><span class="radar__ring"></span><span class="radar__ring"></span>
    <span class="radar__sweep"></span>
    ${blips}
    <span class="radar__core heart-beat__heart">${icon(iconName)}</span>
  </div>`;
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
