'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { number, progressBar } = require('../util/text');

/**
 * Number guessing with feedback.
 *
 * The optimal strategy is binary search, so the attempt allowance is derived
 * from log2 of the range plus a small cushion. That keeps every difficulty
 * winnable by a careful player and unwinnable by a careless one, instead of the
 * usual arbitrary "ten tries" that is trivial on a small range and impossible
 * on a large one.
 */

const RANGES = {
  easy: { min: 1, max: 50 },
  medium: { min: 1, max: 500 },
  hard: { min: 1, max: 10_000 },
};

function allowanceFor(min, max) {
  return Math.ceil(Math.log2(max - min + 1)) + 2;
}

module.exports = {
  name: 'gs',
  title: 'Guess the Number',

  start({ difficulty = 'medium', min = null, max = null } = {}) {
    const range = RANGES[difficulty] || RANGES.medium;
    const lo = min ?? range.min;
    const hi = max ?? range.max;
    return {
      min: lo,
      max: hi,
      target: rng.int(lo, hi),
      guesses: [], // { value, hint }
      allowance: allowanceFor(lo, hi),
      difficulty,
      result: null,
      // The window narrows as hints are given, which is what the bar shows.
      lowBound: lo,
      highBound: hi,
    };
  },

  render(session) {
    const { state } = session;
    const used = state.guesses.length;
    const left = state.allowance - used;

    const history = state.guesses
      .slice(-8)
      .map((g) => `${g.hint === 'higher' ? '⬆️' : g.hint === 'lower' ? '⬇️' : '🎯'} \`${number(g.value)}\``)
      .join('  ');

    const span = state.max - state.min;
    const narrowed = span ? 1 - (state.highBound - state.lowBound) / span : 1;

    let status;
    if (state.result === 'won') status = `Correct — the number was **${number(state.target)}**, found in ${used} guess(es).`;
    else if (state.result === 'lost') status = `Out of guesses. It was **${number(state.target)}**.`;
    else status = `Between **${number(state.lowBound)}** and **${number(state.highBound)}** · **${left}** guess(es) left`;

    const embed = embeds
      .base(
        'Guess the Number',
        [
          `I picked a number between **${number(state.min)}** and **${number(state.max)}**.`,
          '',
          history || '*No guesses yet.*',
          '',
          `\`${progressBar(narrowed, 20)}\` range narrowed`,
          '',
          status,
        ].join('\n'),
        state.result === 'won' ? embeds.theme.success : state.result === 'lost' ? embeds.theme.danger : embeds.theme.primary,
      )
      .setFooter({ text: `${state.difficulty} · optimal play needs about ${allowanceFor(state.min, state.max) - 2} guesses` });

    if (state.result) return { embeds: [embed], components: [] };

    return {
      embeds: [embed],
      components: [
        components.buttonRow(
          { id: components.customId('g', 'gs', 'open', session.id), label: 'Guess', emoji: '🔢', style: 'Primary' },
          { id: components.customId('g', 'gs', 'quit', session.id), label: 'Give up', style: 'Danger' },
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
          id: components.customId('g', 'gs', 'submit', session.id),
          title: `Guess between ${state.lowBound} and ${state.highBound}`,
          inputs: [{ id: 'value', label: 'Your guess', style: 'Short', max: 12 }],
        }),
      );
      return { handled: true };
    }

    if (action !== 'submit') return {};

    const raw = interaction.fields.getTextInputValue('value').trim().replace(/[,\s_]/g, '');
    const value = Number(raw);

    if (!Number.isInteger(value)) {
      await interaction.reply({ content: 'Whole numbers only.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return { handled: true };
    }
    if (value < state.min || value > state.max) {
      await interaction
        .reply({ content: `Stay between ${number(state.min)} and ${number(state.max)}.`, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return { handled: true };
    }
    if (state.guesses.some((g) => g.value === value)) {
      await interaction
        .reply({ content: 'You already tried that number - it does not cost you a guess.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return { handled: true };
    }

    const hint = value === state.target ? 'exact' : value < state.target ? 'higher' : 'lower';
    state.guesses.push({ value, hint });

    if (hint === 'higher') state.lowBound = Math.max(state.lowBound, value + 1);
    else if (hint === 'lower') state.highBound = Math.min(state.highBound, value - 1);

    if (hint === 'exact') state.result = 'won';
    else if (state.guesses.length >= state.allowance) state.result = 'lost';

    if (state.result) await module.exports.finish(session, manager);

    await interaction.update(module.exports.render(session)).catch(() => {});
    return { handled: true, ...(state.result ? { finished: true } : {}) };
  },

  async finish(session, manager) {
    if (!session.guildId) return;
    const player = session.players[0];
    const won = session.state.result === 'won';
    manager.recordResult(session.guildId, player.id, won ? 'win' : 'loss');

    if (!won) return;
    const economy = manager.bot.features.economy;
    if (!economy || !manager.bot.db.settings(session.guildId).economy.enabled) return;

    // Reward efficiency: a win in the theoretical minimum pays the most.
    const optimal = allowanceFor(session.state.min, session.state.max) - 2;
    const efficiency = Math.max(0.2, optimal / Math.max(1, session.state.guesses.length));
    const base = { easy: 150, medium: 400, hard: 1200 }[session.state.difficulty] || 300;
    economy.add(session.guildId, player.id, Math.round(base * efficiency));
  },

  RANGES,
  allowanceFor,
};
