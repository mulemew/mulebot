'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const { truncate } = require('../util/text');

/**
 * Command context.
 *
 * Every command receives one of these instead of a raw interaction. The point
 * is that the fifty-odd command files should not each re-implement "reply with
 * an error embed, ephemerally, whether or not the interaction was already
 * deferred" - getting that wrong produces the dreaded "This interaction failed"
 * with no log line, and it is the single most common bug in a bot this size.
 */
class Context {
  /**
   * @param {import('../bot')} bot
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  constructor(bot, interaction) {
    this.bot = bot;
    this.i = interaction;
    this.interaction = interaction;
    this.client = bot.client;
    this.db = bot.db;
    this.log = bot.log;

    this.user = interaction.user;
    this.member = interaction.member;
    this.guild = interaction.guild;
    this.channel = interaction.channel;

    this.settings = interaction.guildId ? bot.db.settings(interaction.guildId) : bot.db.settings('0');
    this.t = bot.t(interaction.guildId);
    this.locale = this.t.locale;
  }

  // ---------- option accessors ----------
  // Thin wrappers so a command reads as ctx.str('reason') rather than
  // ctx.i.options.getString('reason').

  str(name, fallback = null) {
    return this.i.options.getString(name) ?? fallback;
  }

  int(name, fallback = null) {
    const v = this.i.options.getInteger(name);
    return v === null || v === undefined ? fallback : v;
  }

  num(name, fallback = null) {
    const v = this.i.options.getNumber(name);
    return v === null || v === undefined ? fallback : v;
  }

  bool(name, fallback = false) {
    const v = this.i.options.getBoolean(name);
    return v === null || v === undefined ? fallback : v;
  }

  userOpt(name, fallbackToSelf = false) {
    return this.i.options.getUser(name) ?? (fallbackToSelf ? this.user : null);
  }

  memberOpt(name) {
    return this.i.options.getMember(name) ?? null;
  }

  roleOpt(name) {
    return this.i.options.getRole(name) ?? null;
  }

  channelOpt(name, fallbackToCurrent = false) {
    return this.i.options.getChannel(name) ?? (fallbackToCurrent ? this.channel : null);
  }

  attachmentOpt(name) {
    return this.i.options.getAttachment(name) ?? null;
  }

  get sub() {
    return this.i.options.getSubcommand(false);
  }

  get group() {
    return this.i.options.getSubcommandGroup(false);
  }

  // ---------- replying ----------

  /** True when a reply has already been sent or deferred. */
  get answered() {
    return this.i.replied || this.i.deferred;
  }

  /**
   * Sends or edits, whichever is correct for the current state. Every reply in
   * the codebase funnels through here so the deferred/replied distinction is
   * handled exactly once.
   */
  async send(payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (this.answered) {
      // editReply rejects `flags`, which is only meaningful on the first reply.
      const { flags, ...rest } = body;
      return this.i.editReply(rest);
    }
    return this.i.reply(body);
  }

  /** Ephemeral reply, i.e. visible only to the person who ran the command. */
  async whisper(payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    return this.send({ ...body, flags: MessageFlags.Ephemeral });
  }

  /** Defers, buying 15 minutes for slow work such as fetching many members. */
  async defer({ ephemeral = false } = {}) {
    if (this.answered) return null;
    return this.i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  }

  /** Success embed. */
  async ok(title, description, { ephemeral = false, ...rest } = {}) {
    const embed = embeds.success(title, description);
    return ephemeral ? this.whisper({ embeds: [embed], ...rest }) : this.send({ embeds: [embed], ...rest });
  }

  /** Error embed, ephemeral by default because a failure is nobody else's business. */
  async fail(description, { title = null, ephemeral = true } = {}) {
    const embed = embeds.error(title, truncate(description, 4000));
    return ephemeral ? this.whisper({ embeds: [embed] }) : this.send({ embeds: [embed] });
  }

  /** Warning embed. */
  async warn(description, { title = null, ephemeral = true } = {}) {
    const embed = embeds.warning(title, truncate(description, 4000));
    return ephemeral ? this.whisper({ embeds: [embed] }) : this.send({ embeds: [embed] });
  }

  /** Plain informational embed. */
  async info(title, description, { ephemeral = false, ...rest } = {}) {
    const embed = embeds.base(title, description);
    return ephemeral ? this.whisper({ embeds: [embed], ...rest }) : this.send({ embeds: [embed], ...rest });
  }

  /** Localised error: ctx.tfail('err.badDuration'). */
  async tfail(key, vars) {
    return this.fail(this.t(key, vars));
  }

  /** Hands a page array to the shared paginator. */
  async paginate(pages, opts) {
    return this.bot.paginator.send(this.i, pages, opts);
  }

  // ---------- data shortcuts ----------

  /** Live member record for the command invoker, or another user. */
  record(userId = null) {
    return this.db.member(this.i.guildId, userId || this.user.id);
  }

  /** Persists changes made to any record fetched through this context. */
  save() {
    this.db.saveMember();
  }

  /** Reads a dotted guild setting. */
  setting(dotted, fallback = undefined) {
    const parts = dotted.split('.');
    let cur = this.settings;
    for (const p of parts) {
      if (cur === null || typeof cur !== 'object' || !(p in cur)) return fallback;
      cur = cur[p];
    }
    return cur;
  }

  /** Writes a dotted guild setting and refreshes the local copy. */
  setSetting(dotted, value) {
    this.db.setSetting(this.i.guildId, dotted, value);
    this.settings = this.db.settings(this.i.guildId);
    return value;
  }

  /** Formats an amount with the guild's currency symbol. */
  money(amount) {
    const symbol = this.settings.economy?.currency || '🪙';
    return `${symbol} ${Number(amount || 0).toLocaleString('en-US')}`;
  }
}

module.exports = { Context };
