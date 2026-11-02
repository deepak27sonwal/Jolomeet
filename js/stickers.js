// Stickers: big animated emoji, sent as a normal text message whose whole body is
// ":sticker:<id>:". The server stores it like any other text, and the chat draws it
// large with no bubble. Anywhere that only shows plain text uses stickerText().
import { esc } from './ui.js';

export const WAVE = 'wave';

// anim: how the sticker moves when it arrives (see .msg__sticker in css/chat.css)
export const PACKS = [
  {
    id: 'love', label: 'Love', anim: 'beat',
    stickers: [['smitten', '🥰'], ['heart-eyes', '😍'], ['kiss', '😘'], ['hug', '🤗'],
      ['hearts', '💕'], ['cupid', '💘'], ['rose', '🌹'], ['love-letter', '💌']],
  },
  {
    id: 'fun', label: 'Fun', anim: 'wiggle',
    stickers: [['dying', '😂'], ['rofl', '🤣'], ['silly', '😜'], ['wild', '🤪'],
      ['shy', '🙈'], ['smirk', '😏'], ['oops', '🤭'], ['haha', '😆']],
  },
  {
    id: 'chill', label: 'Chill', anim: 'float',
    stickers: [['cool', '😎'], ['sleepy', '😴'], ['coffee', '☕'], ['pizza', '🍕'],
      ['vibes', '🎧'], ['goodnight', '🌙'], ['morning', '🌞'], ['movie-night', '🍿']],
  },
  {
    id: 'hype', label: 'Hype', anim: 'bounce',
    stickers: [['fire', '🔥'], ['party', '🎉'], ['yay', '🙌'], ['hundred', '💯'],
      ['clap', '👏'], ['celebrate', '🥳'], ['omg', '😱'], [WAVE, '👋']],
  },
];

const LABELS = {
  smitten: 'Smitten', 'heart-eyes': 'Heart eyes', kiss: 'Kiss', hug: 'Hug', hearts: 'Hearts', cupid: 'Cupid',
  rose: 'Rose', 'love-letter': 'Love letter', dying: 'Dying', rofl: 'Rolling', silly: 'Silly', wild: 'Wild',
  shy: 'Shy', smirk: 'Smirk', oops: 'Oops', haha: 'Haha', cool: 'Cool', sleepy: 'Sleepy', coffee: 'Coffee',
  pizza: 'Pizza', vibes: 'Vibes', goodnight: 'Good night', morning: 'Good morning', 'movie-night': 'Movie night',
  fire: 'On fire', party: 'Party', yay: 'Yay', hundred: 'Hundred', clap: 'Clap', celebrate: 'Celebrate',
  omg: 'OMG', [WAVE]: 'Wave',
};

const BY_ID = new Map(PACKS.flatMap((p) => p.stickers.map(([id, glyph]) => [id, { id, glyph, label: LABELS[id], anim: p.anim }])));
const BODY_RE = /^:sticker:([a-z0-9-]{1,24}):$/;

export function stickerBody(id) {
  return `:sticker:${id}:`;
}

/** The sticker a message body stands for, or null for ordinary text (and for unknown ids). */
export function parseSticker(body) {
  const match = BODY_RE.exec(String(body ?? ''));
  return match ? BY_ID.get(match[1]) || null : null;
}

/** Plain-text stand-in, for previews, notifications and the in-call chat. */
export function stickerText(body) {
  const sticker = parseSticker(body);
  return sticker ? sticker.glyph : body;
}

/** The big sticker inside a chat message. */
export function stickerHtml(sticker) {
  return `<div class="msg__sticker msg__sticker--${sticker.anim}" role="img" aria-label="Sticker: ${esc(sticker.label)}">${sticker.glyph}</div>`;
}

/** The picker panel: tabs for the packs and a grid of stickers. */
export function stickerPanelHtml() {
  return `<div class="sticker-pop" id="sticker-pop" role="group" aria-label="Stickers" hidden>
    <div class="sticker-pop__tabs" role="tablist">
      ${PACKS.map((p, i) => `<button type="button" role="tab" data-sticker-tab="${p.id}" aria-selected="${i === 0}">${esc(p.label)}</button>`).join('')}
    </div>
    ${PACKS.map((p, i) => `<div class="sticker-pop__grid" role="tabpanel" data-sticker-pack="${p.id}"${i ? ' hidden' : ''}>
      ${p.stickers.map(([id, glyph]) => `<button type="button" data-sticker="${id}" aria-label="${esc(LABELS[id])}" title="${esc(LABELS[id])}">${glyph}</button>`).join('')}
    </div>`).join('')}
  </div>`;
}
