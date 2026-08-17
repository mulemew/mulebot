'use strict';

const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { SLOT_SYMBOLS } = require('../data/jobs');
const { number } = require('../util/text');

/**
 * Slot machine.
 *
 * The paytable is published in the embed and the expected return is computed
 * from the actual weights rather than asserted, so the number shown is always
 * the truth about the machine the player is using. A gambling feature that
 * hides its odds is one balance change away from being a lie.
 *
 * Payouts: three of a kind pays the symbol multiplier, two of a kind pays a
 * small consolation, and anything else loses the stake.
 */

const TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

/** Expected return per unit staked, computed from the weights. */
function expectedReturn() {
  let value = 0;
  for (const symbol of SLOT_SYMBOLS) {
    const p = symbol.weight / TOTAL_WEIGHT;
    value += p ** 3 * symbol.payout; // three of a kind
    // Exactly two of a kind, in any of three arrangements.
    value += 3 * p * p * (1 - p) * 0.5;
  }
  return value;
}

function spin() {
  return [0, 1, 2].map(() => rng.weighted(SLOT_SYMBOLS));
}

/** Multiplier applied to the stake for a given reel result. */
function payoutFor(reels) {
  const [a, b, c] = reels.map((r) => r.emoji);
  if (a === b && b === c) return { multiplier: reels[0].payout, kind: 'triple' };
  if (a === b || b === c || a === c) return { multiplier: 0.5, kind: 'pair' };
  return { multiplier: 0, kind: 'none' };
}

module.exports = {
  name: 'sl',
  title: 'Slots',

  start({ wager = 0 } = {}) {
    return {
      wager,
      spins: 0,
      reels: null,
      net: 0,
      lastPayout: null,
      finished: false,
    };
  },

  render(session) {
    const { state } = session;

    const reelLine = state.reels
      ? `\n\n**[ ${state.reels.map((r) => r.emoji).join(' | ')} ]**\n`
      : '\n\n**[ ❓ | ❓ | ❓ ]**\n';

    let outcome = 'Press spin to play.';
    if (state.lastPayout) {
      if (state.lastPayout.kind === 'triple') {
        outcome = `Three of a kind — **${state.lastPayout.multiplier}×**, won ${number(state.lastPayout.won)}.`;
      } else if (state.lastPayout.kind === 'pair') {
        outcome = `A pair — half your stake back (${number(state.lastPayout.won)}).`;
      } else {
        outcome = `No match. Lost ${number(state.wager)}.`;
      }
    }

    const paytable = SLOT_SYMBOLS.map(
      (s) => `${s.emoji}${s.emoji}${s.emoji}  ×${s.payout}  (${((s.weight / TOTAL_WEIGHT) * 100).toFixed(0)}% per reel)`,
    ).join('\n');

    const embed = embeds
      .base(
        'Slots',
        [
          `Stake: **${number(state.wager)}** per spin`,
          reelLine,
          outcome,
          '',
          `Session: **${state.spins}** spin(s), net **${state.net >= 0 ? '+' : ''}${number(state.net)}**`,
        ].join('\n'),
        state.lastPayout?.won > 0 ? embeds.theme.success : embeds.theme.primary,
      )
      .addFields({ name: 'Paytable', value: `${paytable}\n\nAny two matching: ×0.5` })
      .setFooter({ text: `Expected return: ${(expectedReturn() * 100).toFixed(1)}% of each stake` });

    if (state.finished) return { embeds: [embed], components: [] };

    return {
      embeds: [embed],
      components: [
        components.buttonRow(
          { id: components.customId('g', 'sl', 'spin', session.id), label: 'Spin', emoji: '🎰', style: 'Primary' },
          { id: components.customId('g', 'sl', 'stop', session.id), label: 'Cash out', style: 'Secondary' },
        ),
      ],
    };
  },

  async action(session, interaction, { action, manager }) {
    const { state } = session;
    const economy = manager.bot.features.economy;
    const player = session.players[0];

    if (action === 'stop') {
      state.finished = true;
      return { finished: true };
    }
    if (action !== 'spin') return {};

    // Each spin is a fresh transaction: take the stake, then pay any win.
    if (state.wager && economy) {
      if (!economy.take(session.guildId, player.id, state.wager)) {
        state.finished = true;
        return { finished: true, followUp: 'You ran out of coins.' };
      }
    }

    state.reels = spin();
    state.spins++;

    const { multiplier, kind } = payoutFor(state.reels);
    const won = Math.round(state.wager * multiplier);
    state.lastPayout = { kind, multiplier, won };
    state.net += won - state.wager;

    if (won > 0 && economy) economy.add(session.guildId, player.id, won);

    if (session.guildId) {
      const record = manager.bot.db.member(session.guildId, player.id);
      record.gambling.wagered += state.wager;
      if (won > state.wager) record.gambling.won += won - state.wager;
      else record.gambling.lost += state.wager - won;
      manager.bot.db.saveMember();
      manager.recordResult(session.guildId, player.id, won > state.wager ? 'win' : won === state.wager ? 'draw' : 'loss');
    }

    return {};
  },

  spin,
  payoutFor,
  expectedReturn,
  SLOT_SYMBOLS,
};
