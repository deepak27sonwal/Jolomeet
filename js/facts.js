// "Did you know?" card shown while looking for a match, so the wait isn't dull.
// Every fact is a general, true one (or a tip for using JoloMeet): nothing here
// is about other users or how many people are online.
import { icon, esc } from './ui.js';

const ROTATE_MS = 7000;

const D = 'Did you know?';
const T = 'Conversation tip';
const S = 'Stay safe';

const FACTS = [
  [D, 'An octopus has three hearts and blue blood.'],
  [D, 'Sea otters hold hands while they sleep so they don’t drift apart.'],
  [D, 'Butterflies taste with their feet.'],
  [D, 'Honeybees dance to tell the rest of the hive where the flowers are.'],
  [D, 'A group of flamingos is called a “flamboyance”, and a group of owls is a “parliament”.'],
  [D, 'Wombats produce cube-shaped poop.'],
  [D, 'Hummingbirds can hover in mid-air and even fly backwards.'],
  [D, 'Giraffes have the same number of neck bones as you do: seven.'],
  [D, 'Dolphins call each other by name, using signature whistles.'],
  [D, 'Crows can recognise individual human faces and remember them.'],
  [D, 'Elephants can recognise themselves in a mirror.'],
  [D, 'Cats can sleep up to 16 hours a day.'],
  [D, 'A dog’s nose print is unique, just like a human fingerprint.'],
  [D, 'Starfish have no brain, and a shrimp’s heart is in its head.'],
  [D, 'Jellyfish are about 95% water.'],
  [D, 'Sloths can hold their breath for up to 40 minutes.'],
  [D, 'Sharks are older than trees: they’ve been around for over 400 million years.'],
  [D, 'Some penguins offer their partner a pebble as a gift.'],
  [D, 'Bananas are berries, but strawberries are not.'],
  [D, 'Some bamboo grows up to 90 cm in a single day.'],
  [D, 'Honey never spoils. Edible honey has been found in ancient Egyptian tombs.'],
  [D, 'Lightning is about five times hotter than the surface of the Sun.'],
  [D, 'A fluffy cloud can weigh as much as 500 tonnes. It floats because the air beneath it is heavier.'],
  [D, 'The Pacific Ocean is bigger than all of Earth’s land put together.'],
  [D, 'Russia spans 11 time zones.'],
  [D, 'Canada has more lakes than any other country.'],
  [D, 'Australia is wider than the Moon.'],
  [D, 'The Sahara desert was green and full of lakes only a few thousand years ago.'],
  [D, 'Vatican City is the smallest country in the world, smaller than most city parks.'],
  [D, 'The oldest known living tree is a bristlecone pine that’s nearly 5,000 years old.'],
  [D, 'Rainbows are really full circles. From the ground you only see the top half.'],
  [D, 'Apples float because about a quarter of their volume is air.'],
  [D, 'Peanuts aren’t nuts. They’re legumes, like peas and lentils.'],
  [D, 'Carrots were originally purple or yellow. Orange ones came later.'],
  [D, 'The Aztecs used cacao beans, the source of chocolate, as money.'],
  [D, 'A pineapple takes around two years to grow.'],
  [D, 'A day on Venus is longer than its year.'],
  [D, 'Venus spins backwards compared with most planets, so the Sun rises in the west there.'],
  [D, 'Sunsets on Mars look blue.'],
  [D, 'Saturn is light enough that it would float in water, if you had a bath big enough.'],
  [D, 'Light from the Sun takes about eight minutes to reach Earth.'],
  [D, 'More than a million Earths could fit inside the Sun.'],
  [D, 'Jupiter’s Great Red Spot is a storm that has been raging for hundreds of years.'],
  [D, 'A teaspoon of neutron star would weigh about a billion tonnes.'],
  [D, 'Footprints on the Moon will last for millions of years: there is no wind to blow them away.'],
  [D, 'Your heart beats around 100,000 times a day.'],
  [D, 'Your brain uses about 20% of your body’s energy.'],
  [D, 'Babies are born with around 300 bones. Adults have 206.'],
  [D, 'Even identical twins have different fingerprints.'],
  [D, 'The lining of your stomach is replaced every few days.'],
  [D, 'Any two people are about 99.9% genetically identical.'],
  [D, 'Listening to music you love releases dopamine, a “feel-good” chemical.'],
  [D, 'Laughing together is linked with feeling closer to someone.'],
  [D, 'India’s constitution recognises 22 languages, and people speak hundreds more.'],
  [D, 'The game of chess is believed to have started in India.'],
  [D, 'Mathematicians in ancient India were the first to treat zero as a number in its own right.'],
  [D, 'The Eiffel Tower can grow about 15 cm taller in summer, when the iron expands in the heat.'],
  [D, 'The shortest war in history, between Britain and Zanzibar in 1896, lasted under an hour.'],
  [D, 'The first email was sent in 1971, and the first text message, “Merry Christmas”, in 1992.'],
  [D, 'The first computer mouse, built in the 1960s, was made of wood.'],
  [D, 'The QWERTY keyboard layout dates from the 1870s.'],
  [T, 'Studies of first conversations found that people who ask follow-up questions are liked more.'],
  [T, 'Stuck for words? Tap the dice button for an icebreaker question.'],
  [T, 'Open with a question about something you both picked, like a shared interest.'],
  [T, 'The “liking gap”: after a first chat, people usually like you more than you think they do.'],
  [T, 'Ask about the story behind something, not just the answer. “How did you get into that?” goes a long way.'],
  [T, 'A simple opener like “What made you smile today?” beats “hi” every time.'],
  [T, 'Listening well matters as much as talking. Remember a detail and bring it up later.'],
  [T, 'Be yourself. People can tell when you’re trying too hard.'],
  [S, 'Never share your phone number, address or passwords with someone you’ve just met.'],
  [S, 'Not feeling the vibe? Skip to the next person, or report and block anyone, any time.'],
  [S, 'Tap the heart to stay in touch. It only becomes mutual if you both tap it.'],
  [S, 'Trust your gut: if something feels off, leave the chat and report it.'],
  [S, 'Be careful with links from people you’ve just met. They may not lead where they say.'],
  [S, 'Remember there’s a real person on the other side. A little kindness goes a long way.'],
  [S, 'Picking a few interests helps you meet people you actually have something in common with.'],
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
    card.dataset.kind = label === D ? 'fact' : label === S ? 'safe' : 'tip';
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
