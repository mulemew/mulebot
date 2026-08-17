'use strict';

/**
 * Trivia question bank.
 *
 * Bundled rather than fetched from an API on purpose: an outbound HTTP
 * dependency turns a game into a source of downtime, and many hosting panels
 * block egress by default. Every question is stored with its correct answer
 * first; the game shuffles options before display.
 *
 * Shape: { q, a: [correct, wrong, wrong, wrong], c: category, d: difficulty }
 */

const QUESTIONS = [
  // ---------- science ----------
  { q: 'What is the chemical symbol for gold?', a: ['Au', 'Ag', 'Gd', 'Go'], c: 'science', d: 'easy' },
  { q: 'How many bones are in the adult human body?', a: ['206', '198', '212', '187'], c: 'science', d: 'medium' },
  { q: 'What planet is known as the Red Planet?', a: ['Mars', 'Venus', 'Jupiter', 'Mercury'], c: 'science', d: 'easy' },
  { q: 'What gas do plants absorb from the atmosphere?', a: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], c: 'science', d: 'easy' },
  { q: 'What is the hardest natural substance on Earth?', a: ['Diamond', 'Quartz', 'Titanium', 'Obsidian'], c: 'science', d: 'easy' },
  { q: 'How many chambers does a human heart have?', a: ['Four', 'Two', 'Three', 'Six'], c: 'science', d: 'easy' },
  { q: 'What is the speed of light in a vacuum, roughly?', a: ['300,000 km/s', '150,000 km/s', '1,080 km/s', '30,000 km/s'], c: 'science', d: 'medium' },
  { q: 'Which element has the atomic number 1?', a: ['Hydrogen', 'Helium', 'Oxygen', 'Carbon'], c: 'science', d: 'easy' },
  { q: 'What force keeps planets in orbit around the Sun?', a: ['Gravity', 'Magnetism', 'Friction', 'Inertia'], c: 'science', d: 'easy' },
  { q: 'What is the largest organ of the human body?', a: ['Skin', 'Liver', 'Brain', 'Lungs'], c: 'science', d: 'medium' },
  { q: 'Which blood type is the universal donor?', a: ['O negative', 'AB positive', 'A positive', 'B negative'], c: 'science', d: 'medium' },
  { q: 'What does DNA stand for?', a: ['Deoxyribonucleic acid', 'Dinucleic acid', 'Diribonucleic acid', 'Deoxyribose acid'], c: 'science', d: 'medium' },
  { q: 'At what temperature are Celsius and Fahrenheit equal?', a: ['-40', '0', '32', '-273'], c: 'science', d: 'hard' },
  { q: 'What is the most abundant gas in Earth\'s atmosphere?', a: ['Nitrogen', 'Oxygen', 'Argon', 'Carbon dioxide'], c: 'science', d: 'medium' },
  { q: 'Which scientist proposed the three laws of motion?', a: ['Isaac Newton', 'Albert Einstein', 'Galileo Galilei', 'Nikola Tesla'], c: 'science', d: 'easy' },
  { q: 'What particle carries a negative charge?', a: ['Electron', 'Proton', 'Neutron', 'Positron'], c: 'science', d: 'easy' },
  { q: 'How long does light from the Sun take to reach Earth?', a: ['About 8 minutes', 'About 8 seconds', 'About 8 hours', 'Instantly'], c: 'science', d: 'medium' },
  { q: 'What is the study of fungi called?', a: ['Mycology', 'Botany', 'Zoology', 'Ecology'], c: 'science', d: 'hard' },
  { q: 'Which planet has the most moons?', a: ['Saturn', 'Jupiter', 'Uranus', 'Neptune'], c: 'science', d: 'hard' },
  { q: 'What is absolute zero in Celsius?', a: ['-273.15', '-100', '-459.67', '0'], c: 'science', d: 'medium' },

  // ---------- geography ----------
  { q: 'What is the capital of Australia?', a: ['Canberra', 'Sydney', 'Melbourne', 'Perth'], c: 'geography', d: 'medium' },
  { q: 'Which is the longest river in the world?', a: ['The Nile', 'The Amazon', 'The Yangtze', 'The Mississippi'], c: 'geography', d: 'medium' },
  { q: 'How many continents are there?', a: ['Seven', 'Five', 'Six', 'Eight'], c: 'geography', d: 'easy' },
  { q: 'What is the smallest country in the world?', a: ['Vatican City', 'Monaco', 'Nauru', 'San Marino'], c: 'geography', d: 'easy' },
  { q: 'Mount Everest sits on the border of Nepal and which country?', a: ['China', 'India', 'Bhutan', 'Pakistan'], c: 'geography', d: 'medium' },
  { q: 'Which desert is the largest hot desert on Earth?', a: ['The Sahara', 'The Gobi', 'The Kalahari', 'The Atacama'], c: 'geography', d: 'easy' },
  { q: 'What is the capital of Canada?', a: ['Ottawa', 'Toronto', 'Vancouver', 'Montreal'], c: 'geography', d: 'medium' },
  { q: 'Which ocean is the deepest?', a: ['Pacific', 'Atlantic', 'Indian', 'Arctic'], c: 'geography', d: 'easy' },
  { q: 'Which country has the most people?', a: ['India', 'China', 'United States', 'Indonesia'], c: 'geography', d: 'medium' },
  { q: 'What is the largest country by land area?', a: ['Russia', 'Canada', 'China', 'United States'], c: 'geography', d: 'easy' },
  { q: 'In which country would you find Machu Picchu?', a: ['Peru', 'Chile', 'Bolivia', 'Ecuador'], c: 'geography', d: 'easy' },
  { q: 'Which two countries share the longest international border?', a: ['USA and Canada', 'Russia and China', 'Chile and Argentina', 'India and China'], c: 'geography', d: 'hard' },
  { q: 'What is the capital of Japan?', a: ['Tokyo', 'Osaka', 'Kyoto', 'Nagoya'], c: 'geography', d: 'easy' },
  { q: 'Which sea is the saltiest?', a: ['The Dead Sea', 'The Red Sea', 'The Mediterranean', 'The Caspian Sea'], c: 'geography', d: 'medium' },
  { q: 'How many time zones does Russia span?', a: ['11', '9', '7', '13'], c: 'geography', d: 'hard' },
  { q: 'Which African country was never colonised?', a: ['Ethiopia', 'Kenya', 'Ghana', 'Nigeria'], c: 'geography', d: 'hard' },
  { q: 'What is the capital of Brazil?', a: ['Brasília', 'Rio de Janeiro', 'São Paulo', 'Salvador'], c: 'geography', d: 'medium' },
  { q: 'Which strait separates Europe from Africa?', a: ['Gibraltar', 'Bosphorus', 'Hormuz', 'Malacca'], c: 'geography', d: 'medium' },

  // ---------- history ----------
  { q: 'In what year did the Second World War end?', a: ['1945', '1944', '1946', '1943'], c: 'history', d: 'easy' },
  { q: 'Who was the first person to walk on the Moon?', a: ['Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Michael Collins'], c: 'history', d: 'easy' },
  { q: 'Which empire built the Colosseum?', a: ['Roman', 'Greek', 'Ottoman', 'Byzantine'], c: 'history', d: 'easy' },
  { q: 'In what year did the Berlin Wall fall?', a: ['1989', '1991', '1987', '1993'], c: 'history', d: 'medium' },
  { q: 'Who wrote the Declaration of Independence?', a: ['Thomas Jefferson', 'George Washington', 'Benjamin Franklin', 'John Adams'], c: 'history', d: 'medium' },
  { q: 'Which ancient wonder stood in Alexandria?', a: ['The Lighthouse', 'The Colossus', 'The Hanging Gardens', 'The Mausoleum'], c: 'history', d: 'hard' },
  { q: 'Who was the first Emperor of unified China?', a: ['Qin Shi Huang', 'Han Wudi', 'Kublai Khan', 'Sun Yat-sen'], c: 'history', d: 'medium' },
  { q: 'The Titanic sank in which year?', a: ['1912', '1905', '1918', '1923'], c: 'history', d: 'easy' },
  { q: 'Which war was fought between the North and South of the USA?', a: ['The Civil War', 'The Revolutionary War', 'The War of 1812', 'The Spanish-American War'], c: 'history', d: 'easy' },
  { q: 'Who was the first female Prime Minister of the United Kingdom?', a: ['Margaret Thatcher', 'Theresa May', 'Liz Truss', 'Queen Victoria'], c: 'history', d: 'easy' },
  { q: 'What year did the Soviet Union dissolve?', a: ['1991', '1989', '1993', '1990'], c: 'history', d: 'medium' },
  { q: 'Which civilisation built Chichen Itza?', a: ['Maya', 'Aztec', 'Inca', 'Olmec'], c: 'history', d: 'medium' },
  { q: 'Who painted the ceiling of the Sistine Chapel?', a: ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Donatello'], c: 'history', d: 'easy' },
  { q: 'The Hundred Years War lasted roughly how long?', a: ['116 years', '100 years', '75 years', '150 years'], c: 'history', d: 'hard' },
  { q: 'Which pharaoh\'s tomb was found nearly intact in 1922?', a: ['Tutankhamun', 'Ramesses II', 'Cleopatra', 'Khufu'], c: 'history', d: 'medium' },

  // ---------- technology ----------
  { q: 'What does CPU stand for?', a: ['Central Processing Unit', 'Computer Processing Unit', 'Central Program Unit', 'Core Processing Unit'], c: 'technology', d: 'easy' },
  { q: 'Which company created the Java programming language?', a: ['Sun Microsystems', 'Microsoft', 'IBM', 'Oracle'], c: 'technology', d: 'medium' },
  { q: 'What does HTTP stand for?', a: ['HyperText Transfer Protocol', 'High Transfer Text Protocol', 'HyperText Transport Process', 'Hyperlink Text Transfer Protocol'], c: 'technology', d: 'easy' },
  { q: 'How many bits are in a byte?', a: ['8', '16', '4', '32'], c: 'technology', d: 'easy' },
  { q: 'Who is credited with writing the first computer algorithm?', a: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Charles Babbage'], c: 'technology', d: 'medium' },
  { q: 'What does "RAM" stand for?', a: ['Random Access Memory', 'Rapid Access Memory', 'Read Access Memory', 'Runtime Allocated Memory'], c: 'technology', d: 'easy' },
  { q: 'Which protocol translates domain names into IP addresses?', a: ['DNS', 'DHCP', 'FTP', 'SMTP'], c: 'technology', d: 'medium' },
  { q: 'What year was the first iPhone released?', a: ['2007', '2005', '2008', '2010'], c: 'technology', d: 'medium' },
  { q: 'What does "open source" primarily mean?', a: ['The source code is publicly available', 'The software is free of charge', 'It runs on any OS', 'It has no licence'], c: 'technology', d: 'medium' },
  { q: 'Which language runs natively in a web browser?', a: ['JavaScript', 'Python', 'C++', 'Ruby'], c: 'technology', d: 'easy' },
  { q: 'What is the default port for HTTPS?', a: ['443', '80', '8080', '22'], c: 'technology', d: 'medium' },
  { q: 'Who founded Linux?', a: ['Linus Torvalds', 'Richard Stallman', 'Ken Thompson', 'Dennis Ritchie'], c: 'technology', d: 'easy' },
  { q: 'What does SQL stand for?', a: ['Structured Query Language', 'Simple Query Language', 'Sequential Query Logic', 'Standard Query Layer'], c: 'technology', d: 'medium' },
  { q: 'In binary, what is 1010?', a: ['10', '8', '12', '6'], c: 'technology', d: 'medium' },
  { q: 'Which data structure works first-in, first-out?', a: ['Queue', 'Stack', 'Tree', 'Graph'], c: 'technology', d: 'medium' },
  { q: 'What is the time complexity of binary search?', a: ['O(log n)', 'O(n)', 'O(n log n)', 'O(1)'], c: 'technology', d: 'hard' },

  // ---------- entertainment ----------
  { q: 'How many strings does a standard guitar have?', a: ['Six', 'Four', 'Seven', 'Twelve'], c: 'entertainment', d: 'easy' },
  { q: 'Which film won the first Academy Award for Best Picture?', a: ['Wings', 'Sunrise', 'The Jazz Singer', 'Metropolis'], c: 'entertainment', d: 'hard' },
  { q: 'How many keys does a standard piano have?', a: ['88', '76', '96', '61'], c: 'entertainment', d: 'medium' },
  { q: 'Who directed the film "Jaws"?', a: ['Steven Spielberg', 'George Lucas', 'Martin Scorsese', 'Francis Ford Coppola'], c: 'entertainment', d: 'medium' },
  { q: 'Which band released the album "Abbey Road"?', a: ['The Beatles', 'The Rolling Stones', 'Pink Floyd', 'Led Zeppelin'], c: 'entertainment', d: 'easy' },
  { q: 'In chess, which piece can only move diagonally?', a: ['Bishop', 'Rook', 'Knight', 'Pawn'], c: 'entertainment', d: 'easy' },
  { q: 'How many players are on a football (soccer) team on the pitch?', a: ['11', '10', '12', '9'], c: 'entertainment', d: 'easy' },
  { q: 'Which video game features a character named Link?', a: ['The Legend of Zelda', 'Metroid', 'Final Fantasy', 'Kirby'], c: 'entertainment', d: 'easy' },
  { q: 'What is the best-selling video game of all time?', a: ['Minecraft', 'Tetris', 'GTA V', 'Wii Sports'], c: 'entertainment', d: 'medium' },
  { q: 'How many dots are on a standard six-sided die in total?', a: ['21', '18', '24', '20'], c: 'entertainment', d: 'medium' },
  { q: 'Which instrument has 47 strings and 7 pedals?', a: ['Harp', 'Piano', 'Cello', 'Sitar'], c: 'entertainment', d: 'hard' },
  { q: 'In Monopoly, how much do you collect when passing Go?', a: ['$200', '$100', '$500', '$150'], c: 'entertainment', d: 'easy' },
  { q: 'How many cards are in a standard deck including jokers?', a: ['54', '52', '56', '50'], c: 'entertainment', d: 'easy' },

  // ---------- general ----------
  { q: 'How many minutes are in a full day?', a: ['1440', '1200', '1800', '960'], c: 'general', d: 'medium' },
  { q: 'What colour do you get by mixing blue and yellow?', a: ['Green', 'Purple', 'Orange', 'Brown'], c: 'general', d: 'easy' },
  { q: 'How many sides does a hexagon have?', a: ['Six', 'Five', 'Seven', 'Eight'], c: 'general', d: 'easy' },
  { q: 'What is the most spoken language in the world by native speakers?', a: ['Mandarin Chinese', 'English', 'Spanish', 'Hindi'], c: 'general', d: 'medium' },
  { q: 'How many degrees are in a circle?', a: ['360', '180', '270', '400'], c: 'general', d: 'easy' },
  { q: 'Which animal is the fastest land animal?', a: ['Cheetah', 'Lion', 'Pronghorn', 'Horse'], c: 'general', d: 'easy' },
  { q: 'What is a group of crows called?', a: ['A murder', 'A flock', 'A pack', 'A gaggle'], c: 'general', d: 'medium' },
  { q: 'How many teeth does an adult human usually have?', a: ['32', '28', '30', '36'], c: 'general', d: 'medium' },
  { q: 'Which is the only mammal capable of true flight?', a: ['Bat', 'Flying squirrel', 'Colugo', 'Sugar glider'], c: 'general', d: 'easy' },
  { q: 'What does the "www" in a web address stand for?', a: ['World Wide Web', 'Web World Wide', 'Wide World Web', 'World Web Wide'], c: 'general', d: 'easy' },
  { q: 'How many players are in a standard basketball team on court?', a: ['Five', 'Six', 'Seven', 'Four'], c: 'general', d: 'easy' },
  { q: 'What is the currency of Japan?', a: ['Yen', 'Won', 'Yuan', 'Ringgit'], c: 'general', d: 'easy' },
  { q: 'Which vitamin does the body make from sunlight?', a: ['Vitamin D', 'Vitamin C', 'Vitamin A', 'Vitamin B12'], c: 'general', d: 'easy' },
  { q: 'How many squares are on a chessboard?', a: ['64', '81', '100', '49'], c: 'general', d: 'easy' },
  { q: 'What is the tallest species of tree?', a: ['Coast redwood', 'Giant sequoia', 'Douglas fir', 'Eucalyptus'], c: 'general', d: 'medium' },
  { q: 'Which is the only letter that does not appear in any US state name?', a: ['Q', 'Z', 'X', 'J'], c: 'general', d: 'hard' },
  { q: 'How many rings are on the Olympic flag?', a: ['Five', 'Four', 'Six', 'Seven'], c: 'general', d: 'easy' },
  { q: 'What is the collective noun for a group of owls?', a: ['A parliament', 'A murder', 'A pod', 'A troop'], c: 'general', d: 'medium' },
];

const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.c))].sort();
const DIFFICULTIES = ['easy', 'medium', 'hard'];

/** Points awarded per difficulty, used by the economy payout. */
const POINTS = { easy: 10, medium: 25, hard: 50 };

/** Seconds allowed to answer, per difficulty. */
const TIME_LIMIT = { easy: 20, medium: 25, hard: 30 };

/**
 * Filters the bank.
 * @param {{ category?: string, difficulty?: string }} [opts]
 */
function filter({ category = null, difficulty = null } = {}) {
  return QUESTIONS.filter(
    (q) => (!category || q.c === category) && (!difficulty || q.d === difficulty),
  );
}

/** Count per category, used by the /trivia stats view. */
function counts() {
  const out = {};
  for (const q of QUESTIONS) {
    out[q.c] ??= { total: 0, easy: 0, medium: 0, hard: 0 };
    out[q.c].total++;
    out[q.c][q.d]++;
  }
  return out;
}

module.exports = { QUESTIONS, CATEGORIES, DIFFICULTIES, POINTS, TIME_LIMIT, filter, counts };
