'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { WORDLE_ANSWERS, WORDLE_VALID } = require('../data/words');

/**
 * Wordle.
 *
 * Guesses arrive through a modal, which is the only way to collect free text
 * from a component interaction without the message content intent.
 *
 * The scoring below is the part everyone gets wrong. Marking greens first and
 * then counting remaining letters is required: a naive "is this letter in the
 * word" check reports two yellows when the answer contains only one of that
 * letter, which makes the puzzle unsolvable and looks like a bug to anyone who
 * has played the real thing.
 */

const MAX_ATTEMPTS = 6;
const WORD_LENGTH = 5;

const TILE = { correct: '🟩', present: '🟨', absent: '⬛' };
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * Scores a guess against the answer.
 * @returns {Array<'correct'|'present'|'absent'>}
 */
function scoreGuess(guess, answer) {
  const result = Array(WORD_LENGTH).fill('absent');
  const remaining = {};

  // Pass 1: exact positions, and tally what is left over.
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === answer[i]) result[i] = 'correct';
    else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
  }

  // Pass 2: misplaced letters, limited by what pass 1 left unaccounted for.
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === 'correct') continue;
    const letter = guess[i];
    if (remaining[letter] > 0) {
      result[i] = 'present';
      remaining[letter]--;
    }
  }
  return result;
}

/** Best-known state of each letter, for the keyboard hint. */
function keyboardState(guesses) {
  const rank = { absent: 0, present: 1, correct: 2 };
  const state = {};
  for (const { word, score } of guesses) {
    for (let i = 0; i < word.length; i++) {
      const letter = word[i];
      const current = state[letter];
      if (!current || rank[score[i]] > rank[current]) state[letter] = score[i];
    }
  }
  return state;
}

module.exports = {
  name: 'wd',
  title: 'Wordle',

  start({ answer = null, hardMode = false } = {}) {
    return {
      answer: (answer || rng.pick(WORDLE_ANSWERS)).toLowerCase(),
      guesses: [], // { word, score }
      result: null,
      hardMode,
    };
  },

  render(session) {
    const { state } = session;

    const rows = state.guesses.map(({ word, score }) => {
      const tiles = score.map((s) => TILE[s]).join('');
      return `${tiles}  \`${word.toUpperCase().split('').join(' ')}\``;
    });
    while (rows.length < MAX_ATTEMPTS) rows.push('⬜⬜⬜⬜⬜');

    const keys = keyboardState(state.guesses);
    const keyboard = KEY_ROWS.map((row) =>
      row
        .split('')
        .map((c) => {
          const s = keys[c];
          if (s === 'correct') return `**${c.toUpperCase()}**`;
          if (s === 'present') return c.toUpperCase();
          if (s === 'absent') return '·';
          return c;
        })
        .join(' '),
    ).join('\n');

    let status;
    if (state.result === 'won') {
      status = `Solved in **${state.guesses.length}/${MAX_ATTEMPTS}**.`;
    } else if (state.result === 'lost') {
      status = `Out of guesses. The word was **${state.answer.toUpperCase()}**.`;
    } else {
      status = `Guess ${state.guesses.length + 1} of ${MAX_ATTEMPTS}.${state.hardMode ? ' Hard mode.' : ''}`;
    }

    const embed = embeds
      .base(
        'Wordle',
        `${rows.join('\n')}\n\n\`\`\`\n${keyboard}\n\`\`\`\n${status}`,
        state.result === 'won' ? embeds.theme.success : state.result === 'lost' ? embeds.theme.danger : embeds.theme.primary,
      )
      .setFooter({ text: `Player: ${session.players[0].tag}` });

    if (state.result) return { embeds: [embed], components: [] };

    return {
      embeds: [embed],
      components: [
        components.buttonRow(
          { id: components.customId('g', 'wd', 'open', session.id), label: 'Guess', emoji: '✏️', style: 'Primary' },
          { id: components.customId('g', 'wd', 'quit', session.id), label: 'Give up', style: 'Danger' },
        ),
      ],
    };
  },

  async action(session, interaction, { action, manager }) {
    const { state } = session;

    if (action === 'quit') {
      state.result = 'lost';
      await module.exports.finish(session, manager);
      return { finished: true };
    }

    if (action === 'open') {
      await interaction.showModal(
        components.modal({
          id: components.customId('g', 'wd', 'submit', session.id),
          title: `Guess ${state.guesses.length + 1} of ${MAX_ATTEMPTS}`,
          inputs: [
            {
              id: 'word',
              label: 'Five letter word',
              style: 'Short',
              min: WORD_LENGTH,
              max: WORD_LENGTH,
              placeholder: 'crane',
            },
          ],
        }),
      );
      return { handled: true };
    }

    if (action !== 'submit') return {};

    const guess = interaction.fields.getTextInputValue('word').trim().toLowerCase();

    const problem = module.exports.validate(guess, state);
    if (problem) {
      await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral }).catch(() => {});
      return { handled: true };
    }

    const score = scoreGuess(guess, state.answer);
    state.guesses.push({ word: guess, score });

    if (guess === state.answer) state.result = 'won';
    else if (state.guesses.length >= MAX_ATTEMPTS) state.result = 'lost';

    if (state.result) await module.exports.finish(session, manager);

    await interaction.update(module.exports.render(session)).catch(() => {});
    return { handled: true, ...(state.result ? { finished: true } : {}) };
  },

  /** Returns an error string, or null when the guess is playable. */
  validate(guess, state) {
    if (guess.length !== WORD_LENGTH) return `Guesses must be exactly ${WORD_LENGTH} letters.`;
    if (!/^[a-z]+$/.test(guess)) return 'Letters only.';
    if (!WORDLE_VALID.has(guess)) return `**${guess.toUpperCase()}** is not in the word list.`;
    if (state.guesses.some((g) => g.word === guess)) return 'You already tried that word.';

    if (state.hardMode && state.guesses.length) {
      // Hard mode: every revealed hint must be reused.
      const last = state.guesses[state.guesses.length - 1];
      for (let i = 0; i < WORD_LENGTH; i++) {
        if (last.score[i] === 'correct' && guess[i] !== last.word[i]) {
          return `Hard mode: position ${i + 1} must stay **${last.word[i].toUpperCase()}**.`;
        }
      }
      for (let i = 0; i < WORD_LENGTH; i++) {
        if (last.score[i] === 'present' && !guess.includes(last.word[i])) {
          return `Hard mode: your guess must contain **${last.word[i].toUpperCase()}**.`;
        }
      }
    }
    return null;
  },

  async finish(session, manager) {
    if (!session.guildId) return;
    const player = session.players[0];
    const won = session.state.result === 'won';
    manager.recordResult(session.guildId, player.id, won ? 'win' : 'loss');

    if (!won) return;
    const economy = manager.bot.features.economy;
    if (!economy || !manager.bot.db.settings(session.guildId).economy.enabled) return;
    // Fewer guesses, larger payout.
    const payout = [0, 1000, 700, 500, 350, 250, 150][session.state.guesses.length] || 150;
    economy.add(session.guildId, player.id, payout);
  },

  scoreGuess,
  MAX_ATTEMPTS,
  WORD_LENGTH,
};
