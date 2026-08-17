'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');

/**
 * Tic-tac-toe, playable against another member or the bot.
 *
 * The bot opponent uses full minimax. The board is small enough that the search
 * is instant, and a bot that plays perfectly is more satisfying than one that
 * blunders randomly - a "hard" mode that loses to a fork feels broken.
 * Difficulty is instead expressed as a probability of playing the best move,
 * which degrades gracefully rather than playing obviously silly moves.
 */

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6], // diagonals
];

const MARKS = ['❌', '⭕'];
const EMPTY = null;

/** Winner mark index, 'draw', or null when the game is still open. */
function evaluate(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] !== EMPTY && board[a] === board[b] && board[b] === board[c]) return { winner: board[a], line };
  }
  if (board.every((cell) => cell !== EMPTY)) return { winner: 'draw', line: null };
  return null;
}

/** Minimax with alpha-beta. Returns { score, move } from `player`'s view. */
function minimax(board, player, me, depth = 0, alpha = -Infinity, beta = Infinity) {
  const result = evaluate(board);
  if (result) {
    if (result.winner === 'draw') return { score: 0, move: -1 };
    // Prefer a fast win and a slow loss, which produces natural-looking play.
    return { score: result.winner === me ? 10 - depth : depth - 10, move: -1 };
  }

  const maximising = player === me;
  let best = { score: maximising ? -Infinity : Infinity, move: -1 };

  for (let i = 0; i < 9; i++) {
    if (board[i] !== EMPTY) continue;
    board[i] = player;
    const { score } = minimax(board, player === 0 ? 1 : 0, me, depth + 1, alpha, beta);
    board[i] = EMPTY;

    if (maximising) {
      if (score > best.score) best = { score, move: i };
      alpha = Math.max(alpha, score);
    } else {
      if (score < best.score) best = { score, move: i };
      beta = Math.min(beta, score);
    }
    if (beta <= alpha) break;
  }
  return best;
}

module.exports = {
  name: 'ttt',
  title: 'Tic Tac Toe',

  /** @param {{ players: Array, difficulty?: string }} opts */
  start({ difficulty = 'hard' } = {}) {
    return {
      board: Array(9).fill(EMPTY),
      turn: 0, // index into players
      difficulty,
      moves: 0,
      result: null,
    };
  },

  turnOf(session) {
    if (session.state.result) return null;
    const player = session.players[session.state.turn];
    return player.bot ? null : player.id;
  },

  render(session) {
    const { board, result } = session.state;
    const [p1, p2] = session.players;

    let description;
    if (result?.winner === 'draw') {
      description = 'A draw. Nobody blinked.';
    } else if (result) {
      const winner = session.players[result.winner];
      description = `${winner.bot ? '**I** win' : `<@${winner.id}> wins`} with ${MARKS[result.winner]}.`;
    } else {
      const current = session.players[session.state.turn];
      description = `${current.bot ? 'My' : `<@${current.id}>'s`} turn — ${MARKS[session.state.turn]}`;
    }

    const embed = embeds
      .base('Tic Tac Toe', description, result ? embeds.theme.success : embeds.theme.primary)
      .addFields({
        name: 'Players',
        value: `${MARKS[0]} ${p1.bot ? 'Me' : `<@${p1.id}>`}\n${MARKS[1]} ${p2.bot ? 'Me' : `<@${p2.id}>`}`,
      });
    if (session.wager) embed.addFields({ name: 'Wager', value: String(session.wager), inline: true });

    const cells = board.map((cell, index) => ({
      id: components.customId('g', 'ttt', 'move', session.id, String(index)),
      emoji: cell === EMPTY ? undefined : MARKS[cell],
      label: cell === EMPTY ? '​' : undefined,
      style: cell === EMPTY ? 'Secondary' : cell === 0 ? 'Danger' : 'Primary',
      disabled: Boolean(result) || cell !== EMPTY,
    }));

    return { embeds: [embed], components: components.grid(cells, 3) };
  },

  async action(session, interaction, { action, extra, manager }) {
    if (action === 'quit') {
      session.state.result = { winner: session.state.turn === 0 ? 1 : 0, resigned: true };
      return { finished: true };
    }
    if (action !== 'move') return {};

    const index = Number(extra[0]);
    const { state } = session;
    if (!Number.isInteger(index) || index < 0 || index > 8) return {};
    if (state.board[index] !== EMPTY) {
      await interaction.reply({ content: 'That square is taken.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return { handled: true };
    }

    state.board[index] = state.turn;
    state.moves++;
    state.result = evaluate(state.board);

    if (!state.result) {
      state.turn = state.turn === 0 ? 1 : 0;

      // The bot moves immediately, in the same interaction update, so the board
      // never sits in a half-finished state waiting for a second render.
      const next = session.players[state.turn];
      if (next.bot) {
        const move = module.exports.chooseMove(state);
        if (move >= 0) {
          state.board[move] = state.turn;
          state.moves++;
          state.result = evaluate(state.board);
          if (!state.result) state.turn = state.turn === 0 ? 1 : 0;
        }
      }
    }

    if (state.result) {
      await module.exports.finish(session, manager);
      return { finished: true };
    }
    return {};
  },

  /** Picks the bot's move for the configured difficulty. */
  chooseMove(state) {
    const open = state.board.map((cell, i) => (cell === EMPTY ? i : -1)).filter((i) => i >= 0);
    if (!open.length) return -1;

    const perfectChance = { easy: 0.2, medium: 0.6, hard: 1 }[state.difficulty] ?? 1;
    if (!rng.chance(perfectChance)) return rng.pick(open);

    const me = state.turn;
    return minimax([...state.board], me, me).move;
  },

  /** Records results and settles any wager. */
  async finish(session, manager) {
    const { result } = session.state;
    if (!session.guildId) return;

    if (result.winner === 'draw') {
      for (const player of session.players) {
        if (!player.bot) manager.recordResult(session.guildId, player.id, 'draw');
      }
      return;
    }

    const winner = session.players[result.winner];
    for (const player of session.players) {
      if (player.bot) continue;
      manager.recordResult(session.guildId, player.id, player.id === winner.id ? 'win' : 'loss');
    }
    if (!winner.bot) await manager.settleWager(session, winner.id);
  },

  evaluate,
  WIN_LINES,
  MARKS,
};
