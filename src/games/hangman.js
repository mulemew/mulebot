'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { HANGMAN } = require('../data/words');

/**
 * Hangman with a letter picker.
 *
 * A text-entry version would need the message content intent and a collector;
 * paging the alphabet across select menus keeps it working with slash commands
 * alone. Two select menus of thirteen letters each fit comfortably and are
 * faster to use on a phone than 26 buttons.
 *
 * Anyone in the channel can guess by default: hangman is more fun as a group
 * activity, and the alternative (locking it to one member) makes it a worse
 * version of playing alone.
 */

const MAX_MISSES = 6;

const GALLOWS = [
  '```\n  ┌───┐\n      │\n      │\n      │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n      │\n      │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n  |   │\n      │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n /|   │\n      │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n /|\\  │\n      │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n /|\\  │\n /    │\n     ═══\n```',
  '```\n  ┌───┐\n  O   │\n /|\\  │\n / \\  │\n     ═══\n```',
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

module.exports = {
  name: 'hm',
  title: 'Hangman',
  openToAll: true, // anyone in the channel may guess

  start({ word = null } = {}) {
    const entry = word ? { word: word.toLowerCase(), hint: 'custom word' } : rng.pick(HANGMAN);
    return {
      word: entry.word,
      hint: entry.hint,
      guessed: [],
      misses: 0,
      result: null,
      guessers: {}, // userId -> correct guesses, used for the summary
    };
  },

  /** The word with unguessed letters masked. */
  masked(state) {
    return state.word
      .split('')
      .map((c) => (/[a-z]/.test(c) ? (state.guessed.includes(c) ? c.toUpperCase() : '\\_') : c))
      .join(' ');
  },

  render(session) {
    const { state } = session;
    const wrong = state.guessed.filter((c) => !state.word.includes(c));

    let status;
    if (state.result === 'won') status = `Solved: **${state.word.toUpperCase()}**`;
    else if (state.result === 'lost') status = `Out of guesses. The word was **${state.word.toUpperCase()}**.`;
    else status = `${MAX_MISSES - state.misses} wrong guess(es) left.`;

    const embed = embeds
      .base(
        'Hangman',
        [
          GALLOWS[Math.min(state.misses, GALLOWS.length - 1)],
          `\`${module.exports.masked(state)}\``,
          '',
          `**Hint:** ${state.hint}`,
          wrong.length ? `**Missed:** ${wrong.map((c) => c.toUpperCase()).join(' ')}` : null,
          '',
          status,
        ]
          .filter(Boolean)
          .join('\n'),
        state.result === 'won' ? embeds.theme.success : state.result === 'lost' ? embeds.theme.danger : embeds.theme.primary,
      );

    const top = [];
    const contributors = Object.entries(state.guessers).sort((a, b) => b[1] - a[1]);
    for (const [userId, count] of contributors.slice(0, 5)) top.push(`<@${userId}> ${count}`);
    if (top.length) embed.addFields({ name: 'Letters found', value: top.join(' · ') });

    if (state.result) return { embeds: [embed], components: [] };

    // Two menus: A-M and N-Z. Guessed letters are removed rather than disabled,
    // which keeps the list short as the game goes on.
    const available = ALPHABET.filter((c) => !state.guessed.includes(c));
    const half = Math.ceil(available.length / 2);
    const menus = [];
    for (const [i, slice] of [available.slice(0, half), available.slice(half)].entries()) {
      if (!slice.length) continue;
      menus.push(
        components.select({
          id: components.customId('g', 'hm', 'guess', session.id, String(i)),
          placeholder: `Guess a letter (${slice[0].toUpperCase()}–${slice[slice.length - 1].toUpperCase()})`,
          options: slice.map((c) => ({ label: c.toUpperCase(), value: c })),
        }),
      );
    }

    menus.push(
      components.buttonRow(
        { id: components.customId('g', 'hm', 'solve', session.id), label: 'Solve', emoji: '💡', style: 'Success' },
        { id: components.customId('g', 'hm', 'quit', session.id), label: 'Give up', style: 'Danger' },
      ),
    );

    return { embeds: [embed], components: menus };
  },

  async action(session, interaction, { action, manager }) {
    const { state } = session;

    if (action === 'quit') {
      state.result = 'lost';
      await module.exports.finish(session, manager);
      return { finished: true };
    }

    if (action === 'solve') {
      // A modal is the only way to take free text from a component interaction.
      await interaction.showModal(
        components.modal({
          id: components.customId('g', 'hm', 'solved', session.id),
          title: 'Solve the word',
          inputs: [{ id: 'answer', label: 'Your answer', style: 'Short', max: 40 }],
        }),
      );
      return { handled: true };
    }

    if (action === 'solved') {
      const answer = interaction.fields.getTextInputValue('answer').trim().toLowerCase();
      if (answer === state.word) {
        state.guessed = [...new Set([...state.guessed, ...state.word.split('')])];
        state.result = 'won';
        state.guessers[interaction.user.id] = (state.guessers[interaction.user.id] || 0) + 3;
        await module.exports.finish(session, manager);
        await interaction.update(module.exports.render(session)).catch(() => {});
        return { handled: true };
      }
      state.misses++;
      if (state.misses >= MAX_MISSES) {
        state.result = 'lost';
        await module.exports.finish(session, manager);
      }
      await interaction.update(module.exports.render(session)).catch(() => {});
      return { handled: true };
    }

    if (action !== 'guess') return {};

    const letter = interaction.values?.[0];
    if (!letter || state.guessed.includes(letter)) {
      await interaction.reply({ content: 'That letter was already used.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return { handled: true };
    }

    state.guessed.push(letter);

    if (state.word.includes(letter)) {
      const hits = state.word.split('').filter((c) => c === letter).length;
      state.guessers[interaction.user.id] = (state.guessers[interaction.user.id] || 0) + hits;
      const solved = state.word.split('').every((c) => !/[a-z]/.test(c) || state.guessed.includes(c));
      if (solved) {
        state.result = 'won';
        await module.exports.finish(session, manager);
        return { finished: true };
      }
    } else {
      state.misses++;
      if (state.misses >= MAX_MISSES) {
        state.result = 'lost';
        await module.exports.finish(session, manager);
        return { finished: true };
      }
    }
    return {};
  },

  /** Awards results and a small economy payout for a win. */
  async finish(session, manager) {
    if (!session.guildId) return;
    const won = session.state.result === 'won';

    for (const userId of Object.keys(session.state.guessers)) {
      manager.recordResult(session.guildId, userId, won ? 'win' : 'loss');
    }

    if (!won) return;
    const economy = manager.bot.features.economy;
    const settings = manager.bot.db.settings(session.guildId);
    if (!economy || !settings.economy.enabled) return;

    // The payout is split by contribution so the person who guessed one vowel
    // does not earn the same as the person who solved it.
    const total = Object.values(session.state.guessers).reduce((a, b) => a + b, 0) || 1;
    const pot = 150 + session.state.word.length * 25;
    for (const [userId, hits] of Object.entries(session.state.guessers)) {
      economy.add(session.guildId, userId, Math.round((hits / total) * pot));
    }
  },

  MAX_MISSES,
};
