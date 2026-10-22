// "Did you know?" card shown while looking for a match, so the wait isn't dull.
// Every fact is a general, true one (or a tip for using JoloMeet): nothing here
// is about other users or how many people are online.
import { icon, esc } from './ui.js';

const ROTATE_MS = 7000;

const FACTS = [
  ['Did you know?', 'Honey never spoils. Edible honey has been found in ancient Egyptian tombs.'],
  ['Did you know?', 'An octopus has three hearts and blue blood.'],
  ['Did you know?', 'Bananas are berries, but strawberries are not.'],
  ['Did you know?', 'A day on Venus is longer than its year.'],
  ['Did you know?', 'Sea otters hold hands while they sleep so they don’t drift apart.'],
  ['Did you know?', 'Butterflies taste with their feet.'],
  ['Did you know?', 'Sharks are older than trees: they’ve been around for over 400 million years.'],
  ['Did you know?', 'The Eiffel Tower can grow about 15 cm taller in summer, when the iron expands in the heat.'],
  ['Did you know?', 'A group of flamingos is called a “flamboyance”.'],
  ['Did you know?', 'Your heart beats around 100,000 times a day.'],
  ['Did you know?', 'Some bamboo grows up to 90 cm in a single day.'],
  ['Did you know?', 'Honeybees dance to tell the rest of the hive where the flowers are.'],
  ['Did you know?', 'Footprints on the Moon will last for millions of years: there is no wind to blow them away.'],
  ['Did you know?', 'India’s constitution recognises 22 languages, and people speak hundreds more.'],
  ['Did you know?', 'The shortest war in history, between Britain and Zanzibar in 1896, lasted under an hour.'],
  ['Conversation tip', 'Studies of first conversations found that people who ask follow-up questions are liked more.'],
  ['Conversation tip', 'Stuck for words? Tap the dice button for an icebreaker question.'],
  ['Conversation tip', 'Open with a question about something you both picked, like a shared interest.'],
  ['Stay safe', 'Never share your phone number, address or passwords with someone you’ve just met.'],
  ['Stay safe', 'Not feeling the vibe? Skip to the next person, or report and block anyone, any time.'],
  ['Stay safe', 'Tap the heart to stay in touch. It only becomes mutual if you both tap it.'],
];

/** Fisher-Yates, so each wait starts on a different fact and none repeats until all were shown. */
function shuffled() {
  const order = FACTS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Markup for the card; call mountFacts() on the page afterwards to start it. */
export function factsHtml() {
  return `<div class="fact-card" data-facts aria-live="off">
    <span class="fact-card__tag" data-fact-tag>${icon('sparkles', 'icon icon--sm')}<span></span></span>
    <p class="fact-card__text" data-fact-text></p>
  </div>`;
}

/**
 * Fills and rotates the card inside `root`. It stops by itself once the card
 * leaves the page (match found, cancelled, screen changed), so callers have no cleanup.
 */
export function mountFacts(root) {
  const card = root.querySelector('[data-facts]');
  if (!card) return;
  const tag = card.querySelector('[data-fact-tag] span');
  const text = card.querySelector('[data-fact-text]');
  let order = shuffled();
  let at = 0;

  const show = () => {
    const [label, fact] = FACTS[order[at]];
    tag.textContent = label;
    text.textContent = fact;
    card.dataset.kind = label === 'Did you know?' ? 'fact' : label === 'Stay safe' ? 'safe' : 'tip';
    at += 1;
    if (at >= order.length) { order = shuffled(); at = 0; }
  };

  show();
  const timer = setInterval(() => {
    if (!card.isConnected) { clearInterval(timer); return; }
    card.classList.add('is-changing');
    setTimeout(() => {
      show();
      card.classList.remove('is-changing');
    }, 350);
  }, ROTATE_MS);
}
