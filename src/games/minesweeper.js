'use strict';

const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');

/**
 * Minesweeper.
 *
 * Two modes, because the interaction budget forces a choice:
 *
 *   - "spoiler" mode renders a whole grid as Discord spoiler tags. It is a
 *     single message, works at any size, and is the classic implementation.
 *   - "interactive" mode uses buttons, which means at most 5×5 given Discord's
 *     five-rows-of-five limit, but supports flood fill, flagging and a real
 *     win condition.
 *
 * The first click is always safe: mines are placed *after* it, which is how the
 * original game works and avoids the deeply unsatisfying instant loss.
 */

const NUMBERS = ['⬜', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];
const MINE = '💥';
const HIDDEN = '⬛';
const FLAG = '🚩';

const DIFFICULTIES = {
  easy: { size: 5, mines: 3 },
  medium: { size: 5, mines: 5 },
  hard: { size: 5, mines: 8 },
};

function neighbours(index, size) {
  const row = Math.floor(index / size);
  const col = index % size;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      out.push(r * size + c);
    }
  }
  return out;
}

/** Places mines avoiding `safeIndex` and its neighbours, then counts adjacency. */
function layMines(state, safeIndex) {
  const forbidden = new Set([safeIndex, ...neighbours(safeIndex, state.size)]);
  const candidates = [];
  for (let i = 0; i < state.size * state.size; i++) if (!forbidden.has(i)) candidates.push(i);

  for (const index of rng.sample(candidates, Math.min(state.mines, candidates.length))) {
    state.grid[index] = -1;
  }
  for (let i = 0; i < state.grid.length; i++) {
    if (state.grid[i] === -1) continue;
    state.grid[i] = neighbours(i, state.size).filter((n) => state.grid[n] === -1).length;
  }
  state.laid = true;
}

/** Reveals a cell, flood-filling through zero-adjacency regions. */
function reveal(state, index) {
  const stack = [index];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current) || state.revealed[current]) continue;
    seen.add(current);
    state.revealed[current] = true;
    state.flagged[current] = false;
    if (state.grid[current] === 0) {
      for (const n of neighbours(current, state.size)) if (!state.revealed[n]) stack.push(n);
    }
  }
}

module.exports = {
  name: 'ms',
  title: 'Minesweeper',

  start({ difficulty = 'medium' } = {}) {
    const preset = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
    const cells = preset.size * preset.size;
    return {
      size: preset.size,
      mines: preset.mines,
      difficulty,
      grid: Array(cells).fill(0),
      revealed: Array(cells).fill(false),
      flagged: Array(cells).fill(false),
      laid: false,
      flagMode: false,
      result: null,
      startedAt: Date.now(),
    };
  },

  /** Renders a static spoiler board, used by the non-interactive mode. */
  renderSpoiler(size, mineCount) {
    const state = {
      size,
      mines: mineCount,
      grid: Array(size * size).fill(0),
      revealed: [],
      flagged: [],
    };
    // No safe-first-click here; the whole board is generated at once.
    const indexes = rng.sample(
      Array.from({ length: size * size }, (_, i) => i),
      mineCount,
    );
    for (const i of indexes) state.grid[i] = -1;
    for (let i = 0; i < state.grid.length; i++) {
      if (state.grid[i] === -1) continue;
      state.grid[i] = neighbours(i, size).filter((n) => state.grid[n] === -1).length;
    }

    const rows = [];
    for (let r = 0; r < size; r++) {
      const cells = [];
      for (let c = 0; c < size; c++) {
        const value = state.grid[r * size + c];
        cells.push(`||${value === -1 ? MINE : NUMBERS[value]}||`);
      }
      rows.push(cells.join(''));
    }
    return rows.join('\n');
  },

  render(session) {
    const { state } = session;
    const remaining = state.mines - state.flagged.filter(Boolean).length;
    const hiddenSafe = state.revealed.filter((r, i) => !r && state.grid[i] !== -1).length;

    let status;
    if (state.result === 'won') status = `Cleared in ${Math.round((Date.now() - state.startedAt) / 1000)}s.`;
    else if (state.result === 'lost') status = 'You hit a mine.';
    else status = `${remaining} mine(s) unflagged · ${hiddenSafe} safe cell(s) left${state.flagMode ? '\n🚩 **Flag mode is on**' : ''}`;

    const embed = embeds.base(
      'Minesweeper',
      `**${state.difficulty}** — ${state.size}×${state.size}, ${state.mines} mines\n\n${status}`,
      state.result === 'won' ? embeds.theme.success : state.result === 'lost' ? embeds.theme.danger : embeds.theme.primary,
    );

    const cells = state.grid.map((value, index) => {
      const isRevealed = state.revealed[index] || state.result;
      let emoji;
      let style = 'Secondary';

      if (!isRevealed) {
        emoji = state.flagged[index] ? FLAG : undefined;
        if (state.flagged[index]) style = 'Primary';
      } else if (value === -1) {
        emoji = MINE;
        style = 'Danger';
      } else if (value === 0) {
        emoji = undefined;
        style = 'Secondary';
      } else {
        emoji = NUMBERS[value];
        style = 'Success';
      }

      return {
        id: components.customId('g', 'ms', 'cell', session.id, String(index)),
        emoji,
        label: emoji ? undefined : isRevealed ? '·' : '​',
        style,
        disabled: Boolean(state.result) || state.revealed[index],
      };
    });

    const rows = components.grid(cells, state.size);
    if (!state.result && rows.length < 5) {
      rows.push(
        components.buttonRow({
          id: components.customId('g', 'ms', 'flag', session.id),
          label: state.flagMode ? 'Flag mode: on' : 'Flag mode: off',
          emoji: '🚩',
          style: state.flagMode ? 'Primary' : 'Secondary',
        }),
      );
    }

    return { embeds: [embed], components: rows };
  },

  async action(session, interaction, { action, extra, manager }) {
    const { state } = session;

    if (action === 'flag') {
      state.flagMode = !state.flagMode;
      return {};
    }
    if (action !== 'cell') return {};

    const index = Number(extra[0]);
    if (!Number.isInteger(index) || index < 0 || index >= state.grid.length) return {};

    if (state.flagMode) {
      state.flagged[index] = !state.flagged[index];
      return {};
    }
    if (state.flagged[index]) return {}; // a flagged cell is protected from a stray tap

    if (!state.laid) layMines(state, index);

    if (state.grid[index] === -1) {
      state.result = 'lost';
      state.revealed[index] = true;
      await module.exports.finish(session, manager);
      return { finished: true };
    }

    reveal(state, index);

    const cleared = state.revealed.every((r, i) => r || state.grid[i] === -1);
    if (cleared) {
      state.result = 'won';
      await module.exports.finish(session, manager);
      return { finished: true };
    }
    return {};
  },

  async finish(session, manager) {
    if (!session.guildId) return;
    const player = session.players[0];
    const won = session.state.result === 'won';
    manager.recordResult(session.guildId, player.id, won ? 'win' : 'loss');

    if (!won) return;
    const economy = manager.bot.features.economy;
    if (!economy || !manager.bot.db.settings(session.guildId).economy.enabled) return;
    const payout = { easy: 200, medium: 450, hard: 900 }[session.state.difficulty] || 300;
    economy.add(session.guildId, player.id, payout);
  },

  DIFFICULTIES,
  neighbours,
};
