'use strict';

/**
 * Flavour text for the fun commands.
 *
 * Everything here is deliberately mild. A bot that ships genuinely cutting
 * "roasts" becomes a harassment tool the moment someone points it at a person,
 * so the roast list is self-deprecating and absurd rather than personal, and
 * there is no insult command that targets appearance, identity or anything a
 * moderator would have to clean up after.
 */

const EIGHTBALL = {
  positive: [
    'It is certain.',
    'Without a doubt.',
    'Yes, definitely.',
    'You may rely on it.',
    'As I see it, yes.',
    'Most likely.',
    'Outlook good.',
    'Signs point to yes.',
    'Yes.',
  ],
  neutral: [
    'Reply hazy, try again.',
    'Ask again later.',
    'Better not tell you now.',
    'Cannot predict now.',
    'Concentrate and ask again.',
    'The answer is somewhere in the middle.',
  ],
  negative: [
    'Do not count on it.',
    'My reply is no.',
    'My sources say no.',
    'Outlook not so good.',
    'Very doubtful.',
    'Absolutely not.',
    'That is a no from me.',
  ],
};

/** Gentle, non-personal roasts. */
const ROASTS = [
  'Your commit messages are just "fix" seventeen times in a row.',
  'You have 47 browser tabs open and none of them are the one you need.',
  'You reply "haha" to messages you did not read.',
  'You still have not read the pinned message.',
  'You type "k" and then feel bad about it for an hour.',
  'You have a folder called "new folder (3)" on your desktop.',
  'You said "one more game" four games ago.',
  'Your phone battery is at 4% and you are still not charging it.',
  'You have watched the same series six times because choosing is hard.',
  'You start every sentence with "so basically" and it is never basic.',
  'You have a to-do list from 2019 that you refuse to delete.',
  'You use the search bar to navigate to a site you visit daily.',
  'You have never once closed a Discord server tab.',
  'Your idea of cleaning is moving things to a different pile.',
];

const COMPLIMENTS = [
  'You explain things in a way that makes people feel smarter, not smaller.',
  'You notice when someone goes quiet, and you check in.',
  'You are the person who actually reads the documentation.',
  'You make hard things look manageable.',
  'Your taste in music is better than you give yourself credit for.',
  'You ask good questions, which is rarer than good answers.',
  'You keep going after the interesting part is over. That is the hard bit.',
  'People relax when you join the call.',
  'You give credit that other people would quietly keep.',
  'You are remarkably good at admitting when you are wrong.',
  'You do the boring maintenance work nobody thanks anyone for.',
  'Your patience with beginners is a genuine talent.',
];

const FACTS = [
  'Honey never spoils. Edible pots have been found in 3,000-year-old tombs.',
  'Octopuses have three hearts, and two of them stop when they swim.',
  'Bananas are berries. Strawberries are not.',
  'A day on Venus is longer than a year on Venus.',
  'The Eiffel Tower can be about 15cm taller in summer as the iron expands.',
  'Wombat droppings are cube-shaped.',
  'The shortest war in recorded history lasted about 38 minutes.',
  'There are more possible chess games than atoms in the observable universe.',
  'Sharks existed before trees did.',
  'The inventor of the Pringles can is buried in one.',
  'A group of flamingos is called a flamboyance.',
  'Sea otters hold hands while sleeping so they do not drift apart.',
  'Scotland has 421 words for snow, according to one academic study.',
  'The dot over a lowercase i is called a tittle.',
  'Cows have best friends and get stressed when separated.',
  'The Great Wall of China is not visible from space with the naked eye.',
  'A bolt of lightning is roughly five times hotter than the surface of the Sun.',
  'Venus is the only planet in our solar system that rotates clockwise.',
  'The unicorn is the national animal of Scotland.',
  'Nintendo was founded in 1889, originally making playing cards.',
  'Oxford University is older than the Aztec Empire.',
  'A single strand of spaghetti is called a spaghetto.',
  'Butterflies taste with their feet.',
  'The longest recorded flight of a chicken is 13 seconds.',
];

const QUOTES = [
  { text: 'Premature optimization is the root of all evil.', by: 'Donald Knuth' },
  { text: 'There are only two hard things in computer science: cache invalidation and naming things.', by: 'Phil Karlton' },
  { text: 'Simplicity is prerequisite for reliability.', by: 'Edsger Dijkstra' },
  { text: 'Weeks of coding can save you hours of planning.', by: 'Unknown' },
  { text: 'It works on my machine.', by: 'Every developer, once' },
  { text: 'The best error message is the one that never shows up.', by: 'Thomas Fuchs' },
  { text: 'Programs must be written for people to read, and only incidentally for machines to execute.', by: 'Harold Abelson' },
  { text: 'Make it work, make it right, make it fast.', by: 'Kent Beck' },
  { text: 'Any fool can write code that a computer can understand. Good programmers write code that humans can understand.', by: 'Martin Fowler' },
  { text: 'Deleted code is debugged code.', by: 'Jeff Sickel' },
  { text: 'Talk is cheap. Show me the code.', by: 'Linus Torvalds' },
  { text: 'First, solve the problem. Then write the code.', by: 'John Johnson' },
];

const WOULD_YOU_RATHER = [
  ['Always have to say everything on your mind', 'Never speak again'],
  ['Have unlimited money but no friends', 'Have great friends but always be broke'],
  ['Be able to fly but only at walking speed', 'Be able to teleport but only to places you have been'],
  ['Never use a search engine again', 'Never use a messaging app again'],
  ['Live without music', 'Live without films and television'],
  ['Always be 10 minutes late', 'Always be 20 minutes early'],
  ['Have every bug in your code be a typo', 'Have every bug be a race condition'],
  ['Work four days a week for 80% pay', 'Work five days for full pay'],
  ['Know when you will die', 'Know how you will die'],
  ['Have perfect memory but forget one person you love', 'Keep your memory as it is'],
  ['Be famous for something you did not do', 'Be unknown for something great you did'],
  ['Only be able to whisper', 'Only be able to shout'],
  ['Have a rewind button for your life', 'Have a pause button'],
  ['Never feel physical pain', 'Never feel embarrassment'],
];

const TRUTHS = [
  'What is the most useless skill you are weirdly proud of?',
  'What is a widely loved thing you genuinely dislike?',
  'What is the last thing you searched for that you would not want read aloud?',
  'What is a compliment you received that you still think about?',
  'What is the pettiest reason you have stopped talking to someone?',
  'What is something you pretend to understand?',
  'What is the worst advice you have ever given confidently?',
  'What is a small lie you tell regularly?',
  'What is your most irrational fear?',
  'What is something you have never told anyone in this server?',
];

const DARES = [
  'Change your nickname to something the server picks for the next hour.',
  'Send the last photo in your camera roll that is not a screenshot.',
  'Type your next three messages entirely in lowercase with no punctuation.',
  'Post the most recent song you listened to, no explanation allowed.',
  'Give a genuine compliment to the last three people who spoke.',
  'Explain your job or studies using only words a five year old knows.',
  'Send a voice message reading the server rules dramatically.',
  'Set your status to something chosen by the person to your left in the member list.',
  'Recommend a film you love and defend it against all criticism for five minutes.',
  'Post your screen time for today with no commentary.',
];

/** Rating bands used by /ship and /rate. */
const SHIP_BANDS = [
  { max: 10, text: 'This should probably not happen.', emoji: '💔' },
  { max: 25, text: 'There is a spark, but it is a static shock.', emoji: '🧊' },
  { max: 45, text: 'Could work with effort and a shared hobby.', emoji: '🤝' },
  { max: 65, text: 'Genuinely promising.', emoji: '💗' },
  { max: 85, text: 'Very strong compatibility.', emoji: '💞' },
  { max: 99, text: 'Practically inevitable.', emoji: '💘' },
  { max: 100, text: 'A perfect match. Suspiciously perfect.', emoji: '💍' },
];

/** Response text for /rps depending on the outcome. */
const RPS_TAUNTS = {
  win: ['Not even close.', 'Read you like a book.', 'Better luck next round.'],
  lose: ['Well played.', 'You had me there.', 'Fair and square.'],
  draw: ['Great minds.', 'Again?', 'A stalemate of equals.'],
};

/** Encouragements shown when a game is lost, to keep the tone light. */
const CONSOLATIONS = [
  'Close one.',
  'That was a tough board.',
  'Rematch?',
  'The dice were not on your side.',
  'Statistically, you were due a loss.',
];

module.exports = {
  EIGHTBALL,
  ROASTS,
  COMPLIMENTS,
  FACTS,
  QUOTES,
  WOULD_YOU_RATHER,
  TRUTHS,
  DARES,
  SHIP_BANDS,
  RPS_TAUNTS,
  CONSOLATIONS,
};
