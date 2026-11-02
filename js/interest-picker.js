// Interest chips shown just before matching (random chat, audio and video).
// The choice is remembered on this device and sent with the match request.
import { storage } from './app.js';
import { fetchInterests } from './api.js';
import { STORAGE_KEYS } from './config.js';
import { icon, esc } from './ui.js';

export const MAX_INTERESTS = 10;
// interests with a matching icon in the sprite; others fall back to a sparkle
const INTEREST_ICONS = new Set([
  'music', 'gaming', 'movies', 'travel', 'fitness', 'memes', 'food', 'photography', 'anime', 'sports',
]);

// One-tap presets: each picks one interest, and matching puts you with people who picked it first.
// Shown only when the interest exists in the catalogue.
const VIBES = [
  { slug: 'music', emoji: '🎵', label: 'Music lounge' },
  { slug: 'gaming', emoji: '🎮', label: 'Gamers' },
  { slug: 'movies', emoji: '🎬', label: 'Movie night' },
  { slug: 'travel', emoji: '✈️', label: 'Travel talk' },
  { slug: 'food', emoji: '🍕', label: 'Foodies' },
  { slug: 'memes', emoji: '😂', label: 'Meme zone' },
  { slug: 'fitness', emoji: '💪', label: 'Gym buddies' },
  { slug: 'anime', emoji: '🌸', label: 'Anime club' },
];

let catalogue = null; // fetched once per page

/** Saved interest slugs, at most MAX_INTERESTS. */
export function savedInterests() {
  const saved = storage.get(STORAGE_KEYS.interests, []);
  return Array.isArray(saved) ? saved.filter((s) => typeof s === 'string').slice(0, MAX_INTERESTS) : [];
}

/** slug → label for everything in the catalogue (empty until loaded). */
export async function interestLabels() {
  try {
    catalogue ??= await fetchInterests();
  } catch {
    return {};
  }
  return Object.fromEntries(catalogue.map((i) => [i.slug, i.label]));
}

/** Markup for the picker; call mountInterestPicker(container) after inserting it. */
export function interestPickerHtml() {
  return `
    <section class="interest-picker" aria-labelledby="picker-title">
      <div class="interest-picker__head">
        <h2 id="picker-title">${icon('sparkles', 'icon icon--sm')}What's your vibe?</h2>
        <p class="interest-picker__count" aria-live="polite"></p>
      </div>
      <p class="interest-picker__hint">Pick interests to meet people who like the same things, or skip to meet anyone.</p>
      <div class="vibes" role="group" aria-label="Pick a vibe" hidden></div>
      <div class="chip-list" role="group" aria-labelledby="picker-title" aria-busy="true">
        ${'<span class="skeleton skeleton--chip"></span>'.repeat(6)}
      </div>
    </section>`;
}

/** Loads the chips into a rendered picker. Selections are saved as they change. */
export async function mountInterestPicker(root) {
  const picker = root.querySelector('.interest-picker');
  if (!picker) return;
  const list = picker.querySelector('.chip-list');
  const count = picker.querySelector('.interest-picker__count');
  let selected = new Set(savedInterests());

  const updateCount = (message) => {
    const n = selected.size;
    count.innerHTML = message || (n ? `<strong>${n}</strong> selected` : 'None selected');
  };

  try {
    catalogue ??= await fetchInterests();
  } catch {
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = `<p class="interest-picker__error">We couldn't load interests. You can still meet anyone.
      <button class="btn btn--ghost btn--sm" type="button">${icon('refresh', 'icon icon--sm')}Try again</button></p>`;
    list.querySelector('button').addEventListener('click', () => {
      list.innerHTML = '<span class="skeleton skeleton--chip"></span>'.repeat(6);
      mountInterestPicker(root);
    });
    return;
  }
  if (!picker.isConnected) return;

  // drop saved interests that no longer exist
  const known = new Set(catalogue.map((i) => i.slug));
  selected = new Set([...selected].filter((slug) => known.has(slug)));
  storage.set(STORAGE_KEYS.interests, [...selected]);

  const chip = ({ slug, label }) => {
    const ic = INTEREST_ICONS.has(slug) ? `i-${slug}` : 'sparkles';
    return `<button class="chip" type="button" data-slug="${esc(slug)}" aria-pressed="${selected.has(slug)}">${icon(ic, 'icon chip__icon')}${esc(label)}</button>`;
  };
  const featured = catalogue.filter((i) => i.is_featured);
  // keep any selected non-featured interest visible without opening "More"
  const extra = catalogue.filter((i) => !i.is_featured);
  const shownExtra = extra.filter((i) => selected.has(i.slug));
  const hiddenExtra = extra.filter((i) => !selected.has(i.slug));

  list.innerHTML = [...featured, ...shownExtra].map(chip).join('')
    + (hiddenExtra.length ? `<button class="chip chip--more" type="button">${icon('more', 'icon icon--sm')}More</button>` : '');
  list.setAttribute('aria-busy', 'false');
  updateCount();

  // quick vibes: one tap picks a single interest (tap it again to clear)
  const vibes = picker.querySelector('.vibes');
  const offered = VIBES.filter((v) => known.has(v.slug));
  const refresh = () => {
    list.querySelectorAll('[data-slug]').forEach((b) => b.setAttribute('aria-pressed', String(selected.has(b.dataset.slug))));
    vibes.querySelectorAll('[data-vibe]').forEach((b) => b.setAttribute('aria-pressed', String(selected.size === 1 && selected.has(b.dataset.vibe))));
    storage.set(STORAGE_KEYS.interests, [...selected]);
    updateCount();
  };
  if (offered.length && vibes) {
    vibes.innerHTML = offered.map((v) => `<button class="vibe" type="button" data-vibe="${esc(v.slug)}"
      aria-pressed="${selected.size === 1 && selected.has(v.slug)}"><span aria-hidden="true">${v.emoji}</span>${esc(v.label)}</button>`).join('');
    vibes.hidden = false;
    vibes.addEventListener('click', (event) => {
      const vibe = event.target.closest('[data-vibe]');
      if (!vibe) return;
      const only = selected.size === 1 && selected.has(vibe.dataset.vibe);
      selected = new Set(only ? [] : [vibe.dataset.vibe]);
      refresh();
    });
  }

  list.addEventListener('click', (event) => {
    const more = event.target.closest('.chip--more');
    if (more) {
      more.insertAdjacentHTML('beforebegin', hiddenExtra.map(chip).join(''));
      const first = more.previousElementSibling && list.querySelector(`[data-slug="${CSS.escape(hiddenExtra[0].slug)}"]`);
      more.remove();
      first?.focus();
      return;
    }
    const button = event.target.closest('[data-slug]');
    if (!button) return;
    const { slug } = button.dataset;
    if (selected.has(slug)) {
      selected.delete(slug);
    } else if (selected.size >= MAX_INTERESTS) {
      updateCount(`Up to ${MAX_INTERESTS}`);
      return;
    } else {
      selected.add(slug);
    }
    button.setAttribute('aria-pressed', String(selected.has(slug)));
    refresh();
  });
}
