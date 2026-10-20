// Icebreaker questions. Calls show the same card to both people by picking
// from the session id (so no messages are needed to agree on the first card);
// "New question" moves both forward together.

export const ICEBREAKERS = [
  'If you could live in any city for a year, where would it be?',
  "What's the best trip you've ever taken?",
  'What song have you had on repeat lately?',
  "What's a small thing that always makes your day better?",
  'Coffee, tea, or something else entirely?',
  "What's a skill you'd love to learn this year?",
  'Beach holiday or mountain adventure?',
  "What's the last show you binge-watched?",
  "What's your go-to comfort food?",
  "If you could have dinner with anyone, who would it be?",
  "What's something you're looking forward to this month?",
  "What's the most underrated movie you've seen?",
  'Morning person or night owl?',
  "What's a hobby you'd recommend to everyone?",
  'If you could instantly speak any language, which one?',
  "What's the best piece of advice you've ever been given?",
  'Cats, dogs, or neither?',
  "What's a place near you that visitors shouldn't miss?",
  'What did you want to be when you were a kid?',
  "What's your favourite way to spend a lazy Sunday?",
  "What's one app you couldn't live without?",
  "What's the best concert or live event you've been to?",
  'If you won a free trip tomorrow, where would you go?',
  "What's a food you'll never try again?",
  "What's your favourite game, on a screen or on a table?",
  "What's something that made you laugh this week?",
  'Book, podcast, or video: how do you learn new things?',
  "What's a tradition from your culture you love?",
  'If you could time-travel once, past or future?',
  "What's the most beautiful place you've seen?",
  "What's a movie you can watch again and again?",
  'Sweet or savoury breakfast?',
  "What's a goal you're quietly proud of reaching?",
  'If you started a small business, what would it be?',
  "What's your favourite season and why?",
  "What's a song that instantly takes you back in time?",
  'Would you rather explore space or the deep ocean?',
  "What's a word or phrase you use way too much?",
  "What's the nicest thing a stranger has done for you?",
  'If your life had a theme song, what would it be?',
  "What's something you're really good at cooking?",
  'Which fictional world would you most like to visit?',
  "What's a sport you enjoy watching or playing?",
  'Text or voice notes: which do you prefer?',
  "What's the best gift you've ever received?",
  'If you could master one instrument, which one?',
  "What's your dream job, if money didn't matter?",
  "What's a festival or holiday you look forward to most?",
  'Road trip playlist: what goes on first?',
  "What's a small habit that changed your life?",
  'Would you rather be able to fly or be invisible?',
  "What's the weirdest food combination you secretly love?",
  "What's a place on your bucket list?",
  "What's one thing people usually get wrong about where you're from?",
  "What's the last thing you learned that surprised you?",
  'Mountains, city, or countryside for your perfect weekend?',
  "What's a talent you have that most people don't know about?",
  "What's your favourite photo you've ever taken?",
  'If you had a free afternoon right now, what would you do?',
  "What's something you'd like to try at least once?",
];

/** Turns a session id into a stable starting point. */
function seedNumber(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** The question both people see, for a shared seed (e.g. the session id) and how many times they asked for a new one. */
export function questionFor(seed, offset = 0) {
  return ICEBREAKERS[(seedNumber(seed) + offset) % ICEBREAKERS.length];
}

/** Any question (for text chats, where the question is sent as a normal message). */
export function randomQuestion() {
  return ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
}
