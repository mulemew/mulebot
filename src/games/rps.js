'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const flavor = require('../data/flavor');

/**
 * Rock paper scissors, best of N, against the bot or another member.
 *
 * Player-versus-player needs hidden simultaneous choices, which buttons do not
 * naturally provide: whoever clicks second would see the first choice in the
 * message. The fix is to record choices privately and only reveal them once
 * both are in, so the second player genuinely cannot see the first move.
 */

const MOVES = {
  rock: { emoji: '🪨', beats: 'scissors', label: 'Rock' },
  paper: { emoji: '📄', beats: 'rock', label: 'Paper' },
  scissors: { emoji: '✂️', beats: 'paper', label: 'Scissors' },
};
const MOVE_KEYS = Object.keys(MOVES);

module.exports = {
  name: 'rps',
  title: 'Rock Paper Scissors',

  start({ bestOf = 3 } = {}) {
    return {
      bestOf: Math.max(1, Math.min(9, bestOf | 1)), // force odd so there is a decider
      round: 1,
      choices: {}, // userId -> move for the current round
      wins: {}, // userId -> rounds won
      history: [], // { round, choices, winner }
      result: null,
    };
  },

  render(session) {
    const { state } = session;
    const target = Math.ceil(state.bestOf / 2);
    const [p1, p2] = session.players;

    const scoreLine = session.players
      .map((p) => `${p.bot ? 'Me' : `<@${p.id}>`} — **${state.wins[p.id] || 0}**`)
      .join('   ·   ');

    const historyLines = state.history.slice(-5).map((h) => {
      const shown = session.players
        .map((p) => `${MOVES[h.choices[p.id]]?.emoji || '❔'}`)
        .join(' vs ');
      const label = h.winner === 'draw' ? 'draw' : h.winner === p1.id ? (p1.bot ? 'me' : p1.tag) : p2.bot ? 'me' : p2.tag;
      return `Round ${h.round}: ${shown} → ${label}`;
    });

    let status;
    if (state.result) {
      status =
        state.result === 'draw'
          ? 'The match ended level.'
          : `${state.result === p1.id ? (p1.bot ? '**I** win' : `<@${p1.id}> wins`) : p2.bot ? '**I** win' : `<@${p2.id}> wins`} the match.`;
    } else {
      const waiting = session.players.filter((p) => !p.bot && !(p.id in state.choices));
      status = waiting.length
        ? `Round ${state.round} — waiting on ${waiting.map((p) => `<@${p.id}>`).join(' and ')}.`
        : `Round ${state.round}.`;
    }

    const embed = embeds
      .base(
        'Rock Paper Scissors',
        [`First to **${target}** of ${state.bestOf}.`, '', scoreLine, '', status].join('\n'),
        state.result ? embeds.theme.success : embeds.theme.primary,
      );

    if (historyLines.length) embed.addFields({ name: 'Recent rounds', value: historyLines.join('\n') });

    if (state.result) return { embeds: [embed], components: [] };

    return {
      embeds: [embed],
      components: [
        components.buttonRow(
          ...MOVE_KEYS.map((key) => ({
            id: components.customId('g', 'rps', 'pick', session.id, key),
            label: MOVES[key].label,
            emoji: MOVES[key].emoji,
            style: 'Secondary',
          })),
        ),
      ],
    };
  },

  async action(session, interaction, { action, extra, manager }) {
    const { state } = session;
    if (action !== 'pick') return {};

    const move = extra[0];
    if (!MOVES[move]) return {};

    if (interaction.user.id in state.choices) {
      await interaction
        .reply({ content: 'You already picked for this round.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return { handled: true };
    }

    state.choices[interaction.user.id] = move;

    // The bot picks as soon as a human has, and never before - picking early
    // and storing it would be identical in effect but harder to prove fair.
    const botPlayer = session.players.find((p) => p.bot);
    if (botPlayer && !(botPlayer.id in state.choices)) {
      state.choices[botPlayer.id] = module.exports.chooseMove(session);
    }

    const everyone = session.players.every((p) => p.id in state.choices);
    if (!everyone) {
      // Acknowledge privately so the other player learns nothing from the reply.
      await interaction
        .reply({ content: `You chose ${MOVES[move].emoji} ${MOVES[move].label}. Waiting for your opponent.`, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      await interaction.message.edit(module.exports.render(session)).catch(() => {});
      return { handled: true };
    }

    // ---------- resolve the round ----------
    const [p1, p2] = session.players;
    const m1 = state.choices[p1.id];
    const m2 = state.choices[p2.id];

    let winner;
    if (m1 === m2) winner = 'draw';
    else if (MOVES[m1].beats === m2) winner = p1.id;
    else winner = p2.id;

    if (winner !== 'draw') state.wins[winner] = (state.wins[winner] || 0) + 1;
    state.history.push({ round: state.round, choices: { ...state.choices }, winner });

    const target = Math.ceil(state.bestOf / 2);
    const leader = session.players.find((p) => (state.wins[p.id] || 0) >= target);

    if (leader) {
      state.result = leader.id;
      await module.exports.finish(session, manager);
    } else if (state.round >= state.bestOf) {
      state.result = 'draw';
      await module.exports.finish(session, manager);
    } else {
      state.round++;
      state.choices = {};
    }

    const taunt = winner === 'draw' ? rng.pick(flavor.RPS_TAUNTS.draw) : null;
    await interaction.update(module.exports.render(session)).catch(() => {});
    if (taunt) await interaction.followUp({ content: taunt, flags: MessageFlags.Ephemeral }).catch(() => {});
    return { handled: true, ...(state.result ? { finished: true } : {}) };
  },

  /**
   * The bot's move. Uniform random is the only unexploitable strategy, but a
   * small bias towards countering the opponent's most frequent choice makes it
   * feel less like a coin flip against a repetitive human.
   */
  chooseMove(session) {
    const opponent = session.players.find((p) => !p.bot);
    const history = session.state.history.map((h) => h.choices[opponent?.id]).filter(Boolean);
    if (history.length < 3 || rng.chance(0.6)) return rng.pick(MOVE_KEYS);

    const counts = {};
    for (const move of history) counts[move] = (counts[move] || 0) + 1;
    const favourite = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return MOVE_KEYS.find((k) => MOVES[k].beats === favourite) || rng.pick(MOVE_KEYS);
  },

  async finish(session, manager) {
    if (!session.guildId) return;
    for (const player of session.players) {
      if (player.bot) continue;
      const outcome = session.state.result === 'draw' ? 'draw' : session.state.result === player.id ? 'win' : 'loss';
      manager.recordResult(session.guildId, player.id, outcome);
    }
    if (session.state.result !== 'draw') {
      const winner = session.players.find((p) => p.id === session.state.result);
      if (winner && !winner.bot) await manager.settleWager(session, winner.id);
    }
  },

  MOVES,
  MOVE_KEYS,
};
