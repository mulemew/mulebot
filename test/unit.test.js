'use strict';

/**
 * Unit tests for the pure logic — run with `npm test` (Node 18+, no dependencies).
 *
 * Only deterministic, side-effect-free code is covered here: expression
 * parsing, game rules, duration parsing, colour maths, encodings and the level
 * curve. Anything that talks to Discord is exercised by the boot smoke test
 * instead, since mocking the gateway would test the mock rather than the bot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mathexpr = require('../src/util/mathexpr');
const time = require('../src/util/time');
const text = require('../src/util/text');
const colors = require('../src/data/colors');
const codec = require('../src/data/codec');
const rng = require('../src/util/random');
const leveling = require('../src/features/leveling');
const wordle = require('../src/games/wordle');
const ttt = require('../src/games/tictactoe');
const c4 = require('../src/games/connect4');
const blackjack = require('../src/games/blackjack');
const slots = require('../src/games/slots');
const guess = require('../src/games/guess');
const { mergeDefaults, DEFAULT_GUILD } = require('../src/core/db');

// ---------------------------------------------------------------------------
test('math parser: arithmetic and precedence', () => {
  const ok = (expr, expected) => {
    const r = mathexpr.evaluate(expr);
    assert.equal(r.ok, true, `${expr} failed: ${r.error}`);
    assert.ok(Math.abs(r.value - expected) < 1e-9, `${expr} = ${r.value}, expected ${expected}`);
  };

  ok('1 + 2 * 3', 7);
  ok('(1 + 2) * 3', 9);
  ok('2 ^ 3 ^ 2', 512); // right associative
  ok('-3 ^ 2', -9); // exponent binds tighter than a leading minus
  ok('(-3) ^ 2', 9); // parentheses override that
  ok('2 ^ -1', 0.5); // the exponent may itself be negative
  ok('--5', 5);
  ok('4 * -2', -8);
  ok('10 % 3', 1);
  ok('5!', 120);
  ok('sqrt(144)', 12);
  ok('max(1, 7, 3)', 7);
  ok('gcd(12, 18)', 6);
  ok('lcm(4, 6)', 12);
  ok('2 ** 10', 1024);
  ok('1_000 + 1', 1001);
  ok('deg(pi)', 180);
});

test('math parser: rejects everything that is not arithmetic', () => {
  const bad = [
    'process.exit(1)',
    'require("fs")',
    'this.constructor',
    '(()=>1)()',
    '1; 2',
    'globalThis',
    'eval("1")',
    '__proto__',
    '1 +',
    'sqrt()',
    '1 / 0',
  ];
  for (const expr of bad) {
    assert.equal(mathexpr.evaluate(expr).ok, false, `"${expr}" should not evaluate`);
  }
});

test('math parser: bounded work on hostile input', () => {
  const deep = `${'('.repeat(400)}1${')'.repeat(400)}`;
  const started = Date.now();
  mathexpr.evaluate(deep);
  assert.ok(Date.now() - started < 1000, 'deeply nested input must not hang');
  assert.equal(mathexpr.evaluate('9'.repeat(600)).ok, false, 'over-long input is rejected');
});

// ---------------------------------------------------------------------------
test('duration parsing accepts what people actually type', () => {
  assert.equal(time.parseDuration('30s'), 30_000);
  assert.equal(time.parseDuration('10m'), 600_000);
  assert.equal(time.parseDuration('2h'), 7_200_000);
  assert.equal(time.parseDuration('1h30m'), 5_400_000);
  assert.equal(time.parseDuration('1d 12h'), 129_600_000);
  assert.equal(time.parseDuration('2 days'), 172_800_000);
  assert.equal(time.parseDuration('45'), 45_000, 'a bare number means seconds');
  assert.equal(time.parseDuration('1w'), 604_800_000);

  assert.equal(time.parseDuration('tomorrow'), null);
  assert.equal(time.parseDuration('10x'), null, 'an unknown unit is a typo, not a partial match');
  assert.equal(time.parseDuration(''), null);
  assert.equal(time.parseDuration('0s'), null);
  assert.equal(time.parseDuration(null), null);
});

test('duration formatting', () => {
  assert.equal(time.formatDuration(90_000), '1m 30s');
  assert.equal(time.formatDuration(3_600_000), '1h');
  assert.equal(time.formatDuration(90_061_000, { parts: 2 }), '1d 1h');
  assert.equal(time.formatDuration(5000, { compact: false }), '5 seconds');
});

test('same-day and day-gap logic honours a timezone offset', () => {
  const base = Date.UTC(2026, 0, 10, 23, 0); // 23:00 UTC
  const later = Date.UTC(2026, 0, 11, 1, 0); // 01:00 UTC next day

  assert.equal(time.sameDay(base, later, 0), false, 'different UTC days');
  assert.equal(time.sameDay(base, later, 8), true, 'same day in UTC+8');
  assert.equal(time.daysBetween(base, later, 0), 1);
});

test('birthday parsing rejects impossible dates', () => {
  assert.deepEqual(time.parseBirthday('03-17'), { year: null, month: 3, day: 17 });
  assert.deepEqual(time.parseBirthday('1990-12-25'), { year: 1990, month: 12, day: 25 });
  assert.equal(time.parseBirthday('02-31'), null);
  assert.equal(time.parseBirthday('13-01'), null);
  assert.equal(time.parseBirthday('nonsense'), null);
});

// ---------------------------------------------------------------------------
test('text helpers', () => {
  assert.equal(text.truncate('hello world', 8), 'hello w…');
  assert.equal(text.truncate('short', 20), 'short');
  assert.equal(text.ordinal(1), '1st');
  assert.equal(text.ordinal(11), '11th');
  assert.equal(text.ordinal(22), '22nd');
  assert.equal(text.number(1234567), '1,234,567');
  assert.equal(text.compactNumber(1500), '1.5k');
  assert.equal(text.humanList(['a', 'b', 'c']), 'a, b and c');
  assert.equal(text.progressBar(0.5, 10), '█████░░░░░');
  assert.equal(text.closest('pign', ['ping', 'pong']), 'ping');
});

test('caps ratio ignores punctuation and digits', () => {
  assert.equal(text.capsRatio('HELLO'), 1);
  assert.equal(text.capsRatio('hello'), 0);
  assert.equal(text.capsRatio('12345!!!'), 0, 'no letters means no shouting');
  assert.ok(Math.abs(text.capsRatio('HEllo') - 0.4) < 1e-9);
});

test('invite and domain detection', () => {
  assert.deepEqual(text.findInvites('join discord.gg/abc123 now'), ['abc123']);
  assert.deepEqual(text.findInvites('https://discord.com/invite/xyz789'), ['xyz789']);
  assert.deepEqual(text.findInvites('no invites here'), []);
  assert.deepEqual(text.findDomains('see https://www.Example.com/page'), ['example.com']);
});

test('filter normalisation defeats the usual evasions', () => {
  const target = text.normalizeForFilter('free');
  assert.equal(text.normalizeForFilter('f-r-e-e'), target);
  assert.equal(text.normalizeForFilter('FR3E'), target);
  assert.equal(text.normalizeForFilter('fréé'), target);
  assert.notEqual(text.normalizeForFilter('tree'), target);
});

// ---------------------------------------------------------------------------
test('colour parsing accepts every notation', () => {
  assert.equal(colors.parse('#ff0000'), 0xff0000);
  assert.equal(colors.parse('ff0000'), 0xff0000);
  assert.equal(colors.parse('#f00'), 0xff0000);
  assert.equal(colors.parse('red'), 0xff0000);
  assert.equal(colors.parse('rgb(255, 0, 0)'), 0xff0000);
  assert.equal(colors.parse('16711680'), 0xff0000);
  assert.equal(colors.parse('blurple'), 0x5865f2);
  assert.equal(colors.parse('not a colour'), null);
});

test('colour conversions round trip', () => {
  for (const value of [0xff0000, 0x00ff00, 0x0000ff, 0x5865f2, 0x808080]) {
    const { h, s, l } = colors.toHsl(value);
    const back = colors.hslToInt(h, s / 100, l / 100);
    const a = colors.toRgb(value);
    const b = colors.toRgb(back);
    // Rounding through integer degrees and percentages loses a little precision.
    assert.ok(Math.abs(a.r - b.r) <= 4 && Math.abs(a.g - b.g) <= 4 && Math.abs(a.b - b.b) <= 4);
  }
  assert.equal(colors.toHex(0xff0000), '#ff0000');
  assert.ok(colors.contrast(0xffffff, 0x000000) > 20, 'black on white is maximum contrast');
});

// ---------------------------------------------------------------------------
test('encodings round trip', () => {
  const samples = ['hello world', 'The quick brown fox!', '123 456', '中文测试'];
  for (const sample of samples) {
    for (const method of ['base64', 'base32', 'hex', 'binary', 'rot13', 'reverse', 'url']) {
      const encoded = codec.encode(method, sample);
      assert.equal(encoded.ok, true, `${method} encode failed`);
      const decoded = codec.decode(method, encoded.value);
      assert.equal(decoded.ok, true, `${method} decode failed: ${decoded.error}`);
      assert.equal(decoded.value, sample, `${method} did not round trip`);
    }
  }
});

test('morse round trips for the supported alphabet', () => {
  const encoded = codec.encode('morse', 'hello world');
  assert.equal(encoded.ok, true);
  assert.equal(codec.decode('morse', encoded.value).value, 'hello world');
});

test('decoders reject malformed input rather than returning junk', () => {
  assert.equal(codec.decode('hex', 'zzz').ok, false);
  assert.equal(codec.decode('binary', '11112222').ok, false);
  assert.equal(codec.decode('base32', '!!!!').ok, false);
});

// ---------------------------------------------------------------------------
test('level curve is monotonic and consistent', () => {
  let previous = -1;
  for (let level = 0; level < 100; level++) {
    const total = leveling.totalXpFor(level);
    assert.ok(total > previous, 'total XP must strictly increase with level');
    previous = total;
    assert.equal(leveling.levelFromXp(total), level, `levelFromXp(totalXpFor(${level})) must round trip`);
    assert.equal(leveling.levelFromXp(total - 1), Math.max(0, level - 1));
  }
});

test('level progress never exceeds the requirement', () => {
  for (const xp of [0, 1, 99, 100, 5000, 123_456]) {
    const p = leveling.progress(xp);
    assert.ok(p.current >= 0 && p.current < p.needed, `progress out of range at ${xp} xp`);
    assert.ok(p.ratio >= 0 && p.ratio < 1);
  }
});

// ---------------------------------------------------------------------------
test('wordle scoring handles repeated letters correctly', () => {
  // The classic bug: a naive scorer marks both S in "SASSY" yellow when the
  // answer contains only one.
  assert.deepEqual(wordle.scoreGuess('sassy', 'satin'), [
    'correct', 'correct', 'absent', 'absent', 'absent',
  ]);
  // speed vs erase: the answer holds two Es and one S. The lone S in the guess
  // is misplaced, both guess Es are matched against the answer's two Es, and
  // P and D appear nowhere.
  assert.deepEqual(wordle.scoreGuess('speed', 'erase'), [
    'present', 'absent', 'present', 'present', 'absent',
  ]);
  assert.deepEqual(wordle.scoreGuess('crane', 'crane'), Array(5).fill('correct'));
  assert.deepEqual(wordle.scoreGuess('aabbb', 'bbaaa'), [
    'present', 'present', 'present', 'present', 'absent',
  ]);
});

test('wordle answer pool is entirely guessable', () => {
  const { WORDLE_ANSWERS, WORDLE_VALID } = require('../src/data/words');
  for (const word of WORDLE_ANSWERS) {
    assert.equal(word.length, 5, `${word} is not five letters`);
    assert.ok(WORDLE_VALID.has(word), `${word} is an answer but not a valid guess`);
  }
});

// ---------------------------------------------------------------------------
test('tic tac toe detects wins, draws and open boards', () => {
  const E = null;
  assert.equal(ttt.evaluate([0, 0, 0, E, E, E, E, E, E]).winner, 0, 'top row');
  assert.equal(ttt.evaluate([0, E, E, 0, E, E, 0, E, E]).winner, 0, 'left column');
  assert.equal(ttt.evaluate([0, E, E, E, 0, E, E, E, 0]).winner, 0, 'diagonal');
  assert.equal(ttt.evaluate([0, 1, 0, 0, 1, 1, 1, 0, 0]).winner, 'draw');
  assert.equal(ttt.evaluate(Array(9).fill(E)), null);
});

test('tic tac toe AI is unbeatable on hard', () => {
  // Play 200 games where the AI is X and a random player is O. A perfect
  // player can never lose from the first move.
  for (let game = 0; game < 200; game++) {
    const board = Array(9).fill(null);
    let turn = 0;
    let result = null;

    while (!result) {
      if (turn === 0) {
        const move = ttt.chooseMove({ board, turn, difficulty: 'hard' });
        board[move] = 0;
      } else {
        const open = board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
        board[rng.pick(open)] = 1;
      }
      result = ttt.evaluate(board);
      turn = turn === 0 ? 1 : 0;
    }
    assert.notEqual(result.winner, 1, 'the perfect player lost, which is impossible');
  }
});

test('connect four detects wins in all four directions', () => {
  const empty = () => Array(c4.COLS * c4.ROWS).fill(-1);
  const at = (row, col) => row * c4.COLS + col;

  let board = empty();
  for (let i = 0; i < 4; i++) board[at(5, i)] = 0;
  assert.equal(c4.evaluate(board).winner, 0, 'horizontal');

  board = empty();
  for (let i = 0; i < 4; i++) board[at(2 + i, 3)] = 1;
  assert.equal(c4.evaluate(board).winner, 1, 'vertical');

  board = empty();
  for (let i = 0; i < 4; i++) board[at(2 + i, 2 + i)] = 0;
  assert.equal(c4.evaluate(board).winner, 0, 'diagonal down-right');

  board = empty();
  for (let i = 0; i < 4; i++) board[at(2 + i, 5 - i)] = 1;
  assert.equal(c4.evaluate(board).winner, 1, 'diagonal down-left');

  assert.equal(c4.evaluate(empty()), null);
});

test('connect four AI blocks an immediate loss', () => {
  const board = Array(c4.COLS * c4.ROWS).fill(-1);
  const at = (row, col) => row * c4.COLS + col;
  // Opponent (1) has three in a row along the bottom; the AI (0) must play
  // column 3 to block.
  board[at(5, 0)] = 1;
  board[at(5, 1)] = 1;
  board[at(5, 2)] = 1;

  const move = c4.chooseMove({ board, turn: 0, difficulty: 'hard' });
  assert.equal(move, 3, `AI played column ${move} instead of blocking at 3`);
});

// ---------------------------------------------------------------------------
test('blackjack hand values treat aces correctly', () => {
  const hand = (...ranks) => ranks.map((rank) => ({ rank, suit: '♠️' }));

  assert.equal(blackjack.handValue(hand('A', 'K')), 21);
  assert.equal(blackjack.handValue(hand('A', 'A')), 12, 'only one ace can be soft');
  assert.equal(blackjack.handValue(hand('A', 'A', 'A')), 13);
  assert.equal(blackjack.handValue(hand('10', '9', 'A')), 20, 'the ace drops to 1');
  assert.equal(blackjack.handValue(hand('K', 'Q', 'J')), 30);
  assert.equal(blackjack.isBlackjack(hand('A', 'K')), true);
  assert.equal(blackjack.isBlackjack(hand('A', '5', '5')), false, 'three cards is not a natural');
});

test('blackjack deck is complete and shuffled', () => {
  const deck = blackjack.buildDeck(1);
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => `${c.rank}${c.suit}`)).size, 52, 'no duplicate cards');
});

// ---------------------------------------------------------------------------
test('slots pay table is house-favourable but not absurd', () => {
  const rtp = slots.expectedReturn();
  // A slot machine that pays out more than it takes would be an infinite money
  // printer; one that pays almost nothing is not worth playing.
  assert.ok(rtp < 1, `expected return is ${rtp}, which would print money`);
  assert.ok(rtp > 0.3, `expected return is ${rtp}, which is punitively low`);
});

test('slots payouts match the reels', () => {
  const symbol = slots.SLOT_SYMBOLS[0];
  const other = slots.SLOT_SYMBOLS[1];
  assert.equal(slots.payoutFor([symbol, symbol, symbol]).kind, 'triple');
  assert.equal(slots.payoutFor([symbol, symbol, other]).kind, 'pair');
  assert.equal(slots.payoutFor([symbol, other, slots.SLOT_SYMBOLS[2]]).kind, 'none');
});

// ---------------------------------------------------------------------------
test('guess allowance is enough for binary search', () => {
  for (const [min, max] of [[1, 50], [1, 500], [1, 10_000]]) {
    const allowance = guess.allowanceFor(min, max);
    // Simulate a perfect binary searcher and check it always wins.
    for (let target = min; target <= max; target += Math.max(1, Math.floor((max - min) / 97))) {
      let lo = min;
      let hi = max;
      let tries = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        tries++;
        if (mid === target) break;
        if (mid < target) lo = mid + 1;
        else hi = mid - 1;
      }
      assert.ok(tries <= allowance, `binary search needed ${tries} of ${allowance} for ${target} in ${min}-${max}`);
    }
  }
});

// ---------------------------------------------------------------------------
test('settings merge keeps stored values and fills in new defaults', () => {
  const stored = {
    welcome: { enabled: true, message: 'hi' },
    unknownKeyFromNewerVersion: 42,
  };
  const merged = mergeDefaults(DEFAULT_GUILD, stored);

  assert.equal(merged.welcome.enabled, true, 'stored value wins');
  assert.equal(merged.welcome.message, 'hi');
  assert.equal(merged.welcome.embed, DEFAULT_GUILD.welcome.embed, 'missing keys fall back to the default');
  assert.equal(merged.leveling.enabled, false, 'untouched branches use defaults');
  assert.equal(merged.unknownKeyFromNewerVersion, 42, 'unknown keys are preserved, never dropped');
  assert.deepEqual(mergeDefaults(DEFAULT_GUILD, {}).automod.rules.invites, DEFAULT_GUILD.automod.rules.invites);
});

test('settings merge does not alias the defaults object', () => {
  const a = mergeDefaults(DEFAULT_GUILD, {});
  a.autorole.roleIds.push('123');
  const b = mergeDefaults(DEFAULT_GUILD, {});
  assert.deepEqual(b.autorole.roleIds, [], 'mutating one merge must not affect the next');
});

// ---------------------------------------------------------------------------
test('random helpers stay in range', () => {
  for (let i = 0; i < 500; i++) {
    const n = rng.int(1, 6);
    assert.ok(n >= 1 && n <= 6);
    const f = rng.float();
    assert.ok(f >= 0 && f < 1);
  }
  assert.equal(rng.sample([1, 2, 3], 5).length, 3, 'sampling more than exists returns everything');
  assert.equal(rng.pick([]), undefined);

  const { rolls, total } = rng.dice(3, 6);
  assert.equal(rolls.length, 3);
  assert.equal(total, rolls.reduce((a, b) => a + b, 0));
});

test('seeded randomness is reproducible', () => {
  const a = rng.seeded('abc')();
  const b = rng.seeded('abc')();
  assert.equal(a, b, 'the same seed must give the same value');
  assert.notEqual(rng.seeded('abc')(), rng.seeded('abd')());
});

// ---------------------------------------------------------------------------
test('component builders accept both specs and built buttons', () => {
  const components = require('../src/util/components');
  const spec = { id: 'a:b', label: 'x', style: 'Primary' };

  // rows() used to assume pre-built buttons, which silently broke every caller
  // that passed plain objects. Both forms must work.
  const fromSpecs = components.rows([spec, spec]);
  assert.equal(fromSpecs.length, 1);
  assert.equal(fromSpecs[0].toJSON().components.length, 2);

  const fromBuilders = components.rows([components.button(spec)]);
  assert.equal(fromBuilders[0].toJSON().components.length, 1);

  // Ten buttons must split across two rows, never six in one.
  const many = components.rows(Array(10).fill(spec));
  assert.equal(many.length, 2);
  for (const row of many) assert.ok(row.toJSON().components.length <= 5);

  assert.throws(() => components.customId('x'.repeat(120)), /custom id/);
});

test('every game render produces a payload Discord will accept', () => {
  const manager = {
    bot: { features: {}, db: { settings: () => ({ economy: { enabled: false } }) } },
    recordResult() {},
  };
  const modules = ['tictactoe', 'connect4', 'hangman', 'wordle', 'minesweeper', 'blackjack', 'slots', 'trivia', 'rps', 'guess'];

  for (const name of modules) {
    const game = require(`../src/games/${name}`);
    const session = {
      id: 'abcd1234',
      game: game.name,
      players: [
        { id: '111111111111111111', tag: 'alpha#0001' },
        { id: '222222222222222222', tag: 'beta#0002', bot: true },
      ],
      state: game.start({}),
      guildId: '333333333333333333',
      channelId: '444444444444444444',
      wager: 100,
      finished: false,
    };

    const payload = game.render(session, { manager });
    const rows = payload.components || [];
    assert.ok(rows.length <= 5, `${name} produced ${rows.length} action rows`);

    for (const row of rows) {
      const json = row.toJSON();
      const kids = json.components || [];
      const isSelect = kids.some((c) => c.type >= 3 && c.type <= 8);
      if (!isSelect) assert.ok(kids.length <= 5, `${name} put ${kids.length} buttons in one row`);

      for (const child of kids) {
        if (child.custom_id) {
          assert.ok(child.custom_id.length <= 100, `${name} custom_id is ${child.custom_id.length} chars`);
        }
        if (child.label) assert.ok(child.label.length <= 80, `${name} label too long`);
        if (child.options) assert.ok(child.options.length <= 25, `${name} select has too many options`);
      }
    }

    const data = payload.embeds?.[0]?.data || {};
    let chars = (data.title || '').length + (data.description || '').length;
    for (const field of data.fields || []) {
      chars += field.name.length + field.value.length;
      assert.ok(field.value.length <= 1024, `${name} field value over 1024`);
    }
    assert.ok((data.description || '').length <= 4096, `${name} description over 4096`);
    assert.ok(chars <= 6000, `${name} embed is ${chars} chars`);
  }
});

test('weighted picking respects zero weights', () => {
  const entries = [
    { id: 'never', weight: 0 },
    { id: 'always', weight: 10 },
  ];
  for (let i = 0; i < 100; i++) {
    assert.equal(rng.weighted(entries).id, 'always');
  }
});
