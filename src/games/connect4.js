'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');

/**
 * Connect Four on a 7×6 board.
 *
 * Rendered as emoji rather than buttons: 42 cells would need nine button rows
 * and Discord allows five. Instead the board is text and the seven column
 * buttons fit in two rows, which is also how the physical game works.
 *
 * The AI is a depth-limited negamax with a positional heuristic. Full search is
 * far too slow for an interaction's three-second budget, so the depth is capped
 * and the evaluation rewards lines of two and three plus central control.
 */

const COLS = 7;
const ROWS = 6;
const EMPTY = -1;

const DISCS = ['🔴', '🟡'];
const BLANK = '⚫';
const COLUMN_LABELS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

const idx = (row, col) => row * COLS + col;

/** Lowest empty row in a column, or -1 when it is full. */
function dropRow(board, col) {
  for (let row = ROWS - 1; row >= 0; row--) if (board[idx(row, col)] === EMPTY) return row;
  return -1;
}

function legalColumns(board) {
  const out = [];
  for (let col = 0; col < COLS; col++) if (dropRow(board, col) >= 0) out.push(col);
  return out;
}

/** Every length-4 window on the board, precomputed once. */
const WINDOWS = (() => {
  const out = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (col + 3 < COLS) out.push([idx(row, col), idx(row, col + 1), idx(row, col + 2), idx(row, col + 3)]);
      if (row + 3 < ROWS) out.push([idx(row, col), idx(row + 1, col), idx(row + 2, col), idx(row + 3, col)]);
      if (row + 3 < ROWS && col + 3 < COLS) {
        out.push([idx(row, col), idx(row + 1, col + 1), idx(row + 2, col + 2), idx(row + 3, col + 3)]);
      }
      if (row + 3 < ROWS && col - 3 >= 0) {
        out.push([idx(row, col), idx(row + 1, col - 1), idx(row + 2, col - 2), idx(row + 3, col - 3)]);
      }
    }
  }
  return out;
})();

function evaluate(board) {
  for (const window of WINDOWS) {
    const first = board[window[0]];
    if (first === EMPTY) continue;
    if (window.every((i) => board[i] === first)) return { winner: first, line: window };
  }
  if (board.every((c) => c !== EMPTY)) return { winner: 'draw', line: null };
  return null;
}

/** Positional score from `me`'s perspective. */
function score(board, me) {
  const them = me === 0 ? 1 : 0;
  let total = 0;

  for (const window of WINDOWS) {
    let mine = 0;
    let theirs = 0;
    for (const i of window) {
      if (board[i] === me) mine++;
      else if (board[i] === them) theirs++;
    }
    if (mine && theirs) continue; // a contested window is worth nothing
    if (mine === 4) total += 10_000;
    else if (mine === 3) total += 50;
    else if (mine === 2) total += 8;
    if (theirs === 4) total -= 10_000;
    else if (theirs === 3) total -= 60; // block slightly harder than we build
    else if (theirs === 2) total -= 8;
  }

  // Central columns create more windows, so occupying them is worth something.
  for (let row = 0; row < ROWS; row++) {
    const centre = board[idx(row, 3)];
    if (centre === me) total += 6;
    else if (centre === them) total -= 6;
  }
  return total;
}

function negamax(board, player, me, depth, alpha, beta) {
  const result = evaluate(board);
  if (result) {
    if (result.winner === 'draw') return { value: 0, move: -1 };
    return { value: result.winner === me ? 100_000 - depth : depth - 100_000, move: -1 };
  }
  if (depth <= 0) return { value: score(board, me), move: -1 };

  // Centre-first ordering makes alpha-beta prune far more aggressively.
  const order = [3, 2, 4, 1, 5, 0, 6].filter((c) => dropRow(board, c) >= 0);
  const maximising = player === me;
  let best = { value: maximising ? -Infinity : Infinity, move: order[0] ?? -1 };

  for (const col of order) {
    const row = dropRow(board, col);
    board[idx(row, col)] = player;
    const { value } = negamax(board, player === 0 ? 1 : 0, me, depth - 1, alpha, beta);
    board[idx(row, col)] = EMPTY;

    if (maximising) {
      if (value > best.value) best = { value, move: col };
      alpha = Math.max(alpha, value);
    } else {
      if (value < best.value) best = { value, move: col };
      beta = Math.min(beta, value);
    }
    if (beta <= alpha) break;
  }
  return best;
}

module.exports = {
  name: 'c4',
  title: 'Connect Four',

  start({ difficulty = 'medium' } = {}) {
    return {
      board: Array(COLS * ROWS).fill(EMPTY),
      turn: 0,
      difficulty,
      lastMove: null,
      result: null,
    };
  },

  turnOf(session) {
    if (session.state.result) return null;
    const player = session.players[session.state.turn];
    return player.bot ? null : player.id;
  },

  render(session) {
    const { board, result, lastMove } = session.state;

    const rows = [];
    for (let row = 0; row < ROWS; row++) {
      const cells = [];
      for (let col = 0; col < COLS; col++) {
        const value = board[idx(row, col)];
        cells.push(value === EMPTY ? BLANK : DISCS[value]);
      }
      rows.push(cells.join(''));
    }
    const grid = `${rows.join('\n')}\n${COLUMN_LABELS.join('')}`;

    let status;
    if (result?.winner === 'draw') status = 'The board is full — a draw.';
    else if (result) {
      const winner = session.players[result.winner];
      status = `${winner.bot ? '**I** win' : `<@${winner.id}> wins`} with ${DISCS[result.winner]}.`;
    } else {
      const current = session.players[session.state.turn];
      status = `${current.bot ? 'My' : `<@${current.id}>'s`} turn — ${DISCS[session.state.turn]}`;
    }

    const embed = embeds
      .base('Connect Four', `${grid}\n\n${status}`, result ? embeds.theme.success : embeds.theme.primary)
      .addFields({
        name: 'Players',
        value: session.players
          .map((p, i) => `${DISCS[i]} ${p.bot ? 'Me' : `<@${p.id}>`}`)
          .join('\n'),
      });
    if (lastMove !== null && !result) {
      embed.setFooter({ text: `Last drop: column ${lastMove + 1}` });
    }

    const buttons = COLUMN_LABELS.map((label, col) => ({
      id: components.customId('g', 'c4', 'drop', session.id, String(col)),
      emoji: label,
      style: 'Secondary',
      disabled: Boolean(result) || dropRow(board, col) < 0,
    }));

    return { embeds: [embed], components: components.rows(buttons) };
  },

  async action(session, interaction, { action, extra, manager }) {
    if (action === 'quit') {
      session.state.result = { winner: session.state.turn === 0 ? 1 : 0, resigned: true };
      return { finished: true };
    }
    if (action !== 'drop') return {};

    const col = Number(extra[0]);
    const { state } = session;
    const row = dropRow(state.board, col);
    if (row < 0) {
      await interaction.reply({ content: 'That column is full.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return { handled: true };
    }

    state.board[idx(row, col)] = state.turn;
    state.lastMove = col;
    state.result = evaluate(state.board);

    if (!state.result) {
      state.turn = state.turn === 0 ? 1 : 0;
      const next = session.players[state.turn];
      if (next.bot) {
        const move = module.exports.chooseMove(state);
        const botRow = dropRow(state.board, move);
        if (botRow >= 0) {
          state.board[idx(botRow, move)] = state.turn;
          state.lastMove = move;
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

  chooseMove(state) {
    const open = legalColumns(state.board);
    if (!open.length) return -1;

    const depth = { easy: 1, medium: 4, hard: 6 }[state.difficulty] ?? 4;
    if (state.difficulty === 'easy' && rng.chance(0.4)) return rng.pick(open);

    const best = negamax([...state.board], state.turn, state.turn, depth, -Infinity, Infinity);
    return best.move >= 0 && open.includes(best.move) ? best.move : rng.pick(open);
  },

  async finish(session, manager) {
    const { result } = session.state;
    if (!session.guildId) return;

    if (result.winner === 'draw') {
      for (const player of session.players) if (!player.bot) manager.recordResult(session.guildId, player.id, 'draw');
      return;
    }
    const winner = session.players[result.winner];
    for (const player of session.players) {
      if (player.bot) continue;
      manager.recordResult(session.guildId, player.id, player.id === winner.id ? 'win' : 'loss');
    }
    if (!winner.bot) await manager.settleWager(session, winner.id);
  },

  COLS,
  ROWS,
  evaluate,
};
