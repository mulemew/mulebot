'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const rng = require('../util/random');
const embeds = require('../util/embeds');

/**
 * Game session manager.
 *
 * Every interactive game shares one component namespace ("g") and one session
 * table. That is what makes the games survive the things collectors do not:
 *
 *   - a collector expires after 15 minutes and cannot be restarted; a session
 *     is looked up fresh on every click, so a long game only ends when the
 *     manager decides it has gone stale
 *   - a collector belongs to one message, so a bot restart orphans every open
 *     board with buttons that do nothing; here the button explains itself
 *   - turn order, player membership and "this is not your game" are enforced in
 *     one place instead of being reimplemented per game
 *
 * Custom id layout:  g:<game>:<action>:<sessionId>[:extra…]
 *
 * Sessions live in memory only. Persisting an in-progress tic-tac-toe board
 * across restarts is not worth a disk write per move.
 */

const SESSION_TTL_MS = 20 * 60_000;
const MAX_SESSIONS = 500;

class GameManager {
  constructor(bot) {
    this.bot = bot;
    this.log = bot.log.child('games');
    /** @type {Map<string, object>} game name -> module */
    this.games = new Map();
    /** @type {Map<string, object>} session id -> session */
    this.sessions = new Map();
    this.stats = { started: 0, finished: 0, expired: 0 };

    this.sweeper = setInterval(() => this.sweep(), 60_000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  /** Loads every game module in this directory. */
  loadAll(dir = __dirname) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js') && f !== 'manager.js' && !f.startsWith('_'));

    for (const file of files) {
      try {
        const mod = require(path.join(dir, file));
        if (!mod.name || typeof mod.render !== 'function') {
          this.log.warn(`game ${file} does not export a valid module`);
          continue;
        }
        this.games.set(mod.name, mod);
      } catch (e) {
        this.log.error(`game ${file} failed to load:`, e);
      }
    }
    this.log.info(`loaded ${this.games.size} game(s): ${[...this.games.keys()].join(', ')}`);
    return this.games.size;
  }

  get(name) {
    return this.games.get(name) || null;
  }

  /**
   * Creates a session and returns it. The caller sends the rendered payload and
   * then calls attach() with the resulting message id.
   */
  create(gameName, { players, state, guildId, channelId, wager = 0 }) {
    const game = this.get(gameName);
    if (!game) throw new Error(`unknown game "${gameName}"`);

    // A hard ceiling keeps a busy server from growing the table without bound.
    if (this.sessions.size >= MAX_SESSIONS) this.sweep(true);

    const session = {
      id: rng.id(8),
      game: gameName,
      players, // [{ id, tag, bot? }]
      state,
      guildId,
      channelId,
      messageId: null,
      wager,
      createdAt: Date.now(),
      lastAt: Date.now(),
      finished: false,
    };
    this.sessions.set(session.id, session);
    this.stats.started++;
    return session;
  }

  attach(session, messageId) {
    session.messageId = messageId;
    return session;
  }

  end(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.finished = true;
      this.stats.finished++;
      // Keep it briefly so a late click gets "this game ended" rather than
      // "this game never existed", which reads like a bug to the user.
      setTimeout(() => this.sessions.delete(sessionId), 60_000);
    }
    return session;
  }

  /** Removes stale sessions; `aggressive` also drops the oldest live ones. */
  sweep(aggressive = false) {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.stats.expired++;
      }
    }
    if (aggressive && this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, 50);
      for (const session of oldest) this.sessions.delete(session.id);
    }
  }

  /** Records a win/loss/draw against a member's profile. */
  recordResult(guildId, userId, outcome) {
    if (!guildId) return;
    const record = this.bot.db.member(guildId, userId);
    record.games.played++;
    if (outcome === 'win') record.games.won++;
    else if (outcome === 'loss') record.games.lost++;
    else record.games.drawn++;
    this.bot.db.saveMember();
  }

  /** Pays out a wager from the economy, if the guild has one. */
  async settleWager(session, winnerId) {
    if (!session.wager || !session.guildId) return null;
    const economy = this.bot.features.economy;
    if (!economy) return null;

    const losers = session.players.filter((p) => p.id !== winnerId && !p.bot);
    let pot = 0;
    for (const loser of losers) {
      if (economy.take(session.guildId, loser.id, session.wager)) pot += session.wager;
    }
    if (pot && winnerId) economy.add(session.guildId, winnerId, pot);
    return pot;
  }

  /** Component router entry point for every game. */
  async route(interaction, parts, ctx) {
    const [gameName, action, sessionId, ...extra] = parts;
    const game = this.get(gameName);
    if (!game) return false;

    const session = this.sessions.get(sessionId);
    if (!session) {
      return interaction
        .update({
          embeds: [embeds.warning('Game over', 'This game is no longer active. Start a new one to play again.')],
          components: [],
        })
        .catch(() =>
          interaction.reply({ content: 'This game is no longer active.', flags: MessageFlags.Ephemeral }).catch(() => {}),
        );
    }

    if (session.finished) {
      return interaction.reply({ content: 'This game has already ended.', flags: MessageFlags.Ephemeral });
    }

    // ---------- participation ----------
    const isPlayer = session.players.some((p) => p.id === interaction.user.id);
    if (!isPlayer && !game.openToAll) {
      return interaction.reply({
        content: 'This game belongs to someone else. Start your own with the same command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ---------- turn order ----------
    if (typeof game.turnOf === 'function') {
      const expected = game.turnOf(session);
      if (expected && expected !== interaction.user.id && action !== 'quit') {
        return interaction.reply({
          content: `It is <@${expected}>'s turn.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    session.lastAt = Date.now();

    // ---------- the move ----------
    const result = (await game.action(session, interaction, { action, extra, manager: this, ctx })) || {};

    if (result.handled) return true; // the game already replied itself

    if (result.finished) this.end(session.id);

    const payload = game.render(session, { manager: this });
    if (result.finished) payload.components = [];

    if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => {});
    else await interaction.update(payload).catch(() => {});

    if (result.followUp) {
      await interaction.followUp({ content: result.followUp, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return true;
  }

  snapshot() {
    const byGame = {};
    for (const session of this.sessions.values()) byGame[session.game] = (byGame[session.game] || 0) + 1;
    return { active: this.sessions.size, byGame, ...this.stats, games: [...this.games.keys()] };
  }

  shutdown() {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }
}

/** Feature entry point: builds the manager and wires the component namespace. */
function init(bot) {
  const manager = new GameManager(bot);
  manager.loadAll();
  bot.components.register('g', (interaction, parts, ctx) => manager.route(interaction, parts, ctx));
  return manager;
}

module.exports = { GameManager, init, SESSION_TTL_MS };
