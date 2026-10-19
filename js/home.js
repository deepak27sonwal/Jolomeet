// Homepage: interest picker. Selected interests are remembered locally and
// sent with the match request by the chat and video pages.
import { initApp, storage } from './app.js';
import { fetchInterests, fetchOnlineCount, getSession } from './api.js';
import { STORAGE_KEYS } from './config.js';

const MAX_INTERESTS = 10;
// interests with a matching icon in the sprite; others fall back to a sparkle
const INTEREST_ICONS = new Set([
  'music', 'gaming', 'movies', 'travel', 'fitness', 'memes', 'food', 'photography', 'anime', 'sports',
]);
const SPRITE = 'assets/icons/sprite.svg';

const chipList = document.getElementById('interest-chips');
const countLabel = document.getElementById('interest-count');

let selected = new Set(storage.get(STORAGE_KEYS.interests, []));

initApp();
loadInterests();
adaptToVisitor();
showOnlineCount();

/**
 * Signed-out visitors see the guest link and the sign-up buttons; guests are
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
    actions.innerHTML = '<a class="btn btn--light" href="register.html">Create Account &amp; Keep My Chats</a>';
    note.textContent = "You're using JoloMeet as a guest. Sign up and your chats come with you.";
  } else {
    actions.innerHTML = '<a class="btn btn--light" href="chat.html">Open My Chats</a>'
      + '<a class="btn btn--outline-light" href="profile.html">My Profile</a>';
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

async function loadInterests() {
  chipList.setAttribute('aria-busy', 'true');
  try {
    const interests = await fetchInterests();
    renderChips(interests);
  } catch (error) {
    console.error('Could not load interests', error);
    renderError();
  } finally {
    chipList.setAttribute('aria-busy', 'false');
  }
}

function renderChips(interests) {
  // drop saved interests that no longer exist
  const known = new Set(interests.map((i) => i.slug));
  selected = new Set([...selected].filter((slug) => known.has(slug)));

  const featured = interests.filter((i) => i.is_featured);
  // keep any selected non-featured interest visible without opening "More"
  const extra = interests.filter((i) => !i.is_featured);
  const visibleExtra = extra.filter((i) => selected.has(i.slug));
  const hiddenExtra = extra.filter((i) => !selected.has(i.slug));

  chipList.replaceChildren(...[...featured, ...visibleExtra].map(createChip));

  if (hiddenExtra.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chip chip--more';
    more.innerHTML = `<svg class="icon icon--sm" aria-hidden="true"><use href="${SPRITE}#more"/></svg>More`;
    more.addEventListener('click', () => {
      const chips = hiddenExtra.map(createChip);
      more.replaceWith(...chips);
      chips[0]?.focus();
    });
    chipList.append(more);
  }

  updateCount();
}

function createChip({ slug, label }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.slug = slug;
  chip.setAttribute('aria-pressed', String(selected.has(slug)));
  const icon = INTEREST_ICONS.has(slug) ? `i-${slug}` : 'sparkles';
  chip.innerHTML = `<svg class="icon chip__icon" aria-hidden="true"><use href="${SPRITE}#${icon}"/></svg>`;
  chip.append(label);
  chip.addEventListener('click', () => toggleInterest(chip));
  return chip;
}

function toggleInterest(chip) {
  const { slug } = chip.dataset;
  if (selected.has(slug)) {
    selected.delete(slug);
  } else if (selected.size >= MAX_INTERESTS) {
    countLabel.textContent = `You can pick up to ${MAX_INTERESTS} interests`;
    return;
  } else {
    selected.add(slug);
  }
  chip.setAttribute('aria-pressed', String(selected.has(slug)));
  storage.set(STORAGE_KEYS.interests, [...selected]);
  updateCount();
}

function updateCount() {
  const n = selected.size;
  countLabel.innerHTML = n
    ? `<strong>${n}</strong> interest${n === 1 ? '' : 's'} selected`
    : 'No interests selected yet';
}

function renderError() {
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.innerHTML = `<span>We couldn't load interests right now.</span>`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn--secondary btn--sm';
  retry.innerHTML = `<svg class="icon icon--sm" aria-hidden="true"><use href="${SPRITE}#refresh"/></svg>Try again`;
  retry.addEventListener('click', () => {
    chipList.replaceChildren(...Array.from({ length: 6 }, () => {
      const s = document.createElement('span');
      s.className = 'skeleton skeleton--chip';
      return s;
    }));
    loadInterests();
  });
  notice.append(retry);
  chipList.replaceChildren(notice);
}
