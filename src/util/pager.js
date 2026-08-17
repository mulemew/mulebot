'use strict';

const { MessageFlags } = require('discord.js');
const { buttonRow, customId, select } = require('./components');
const rng = require('./random');

/**
 * Button paginator.
 *
 * Pages live in a Map keyed by a short session token that is embedded in the
 * button custom ids. A message collector would have been less code, but it dies
 * with the process and stops working after 15 minutes; routing through the
 * component router means the buttons keep responding for as long as the session
 * is in memory, and degrade to a clear "this menu expired" message afterwards.
 *
 * Sessions are swept on a timer so an abandoned leaderboard cannot pin an array
 * of embeds in memory forever.
 */

const SESSION_TTL_MS = 15 * 60 * 1000;
const NAMESPACE = 'pg';

class Paginator {
  constructor({ log } = {}) {
    this.log = log;
    /** token -> { pages, ownerId, index, createdAt, ephemeral, selectLabels } */
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(token);
    }
  }

  /** Builds the navigation row for a given position. */
  buildRow(token, index, total) {
    const first = index === 0;
    const last = index === total - 1;
    return buttonRow(
      { id: customId(NAMESPACE, 'first', token), emoji: '⏮️', style: 'Secondary', disabled: first },
      { id: customId(NAMESPACE, 'prev', token), emoji: '◀️', style: 'Primary', disabled: first },
      { id: customId(NAMESPACE, 'page', token), label: `${index + 1} / ${total}`, style: 'Secondary', disabled: true },
      { id: customId(NAMESPACE, 'next', token), emoji: '▶️', style: 'Primary', disabled: last },
      { id: customId(NAMESPACE, 'last', token), emoji: '⏭️', style: 'Secondary', disabled: last },
    );
  }

  /** Optional jump menu for long page sets. */
  buildSelect(token, pages, index) {
    if (pages.length < 4 || pages.length > 25) return null;
    return select({
      id: customId(NAMESPACE, 'jump', token),
      placeholder: 'Jump to a page',
      options: pages.map((p, i) => ({
        label: (p.label || `Page ${i + 1}`).slice(0, 100),
        value: String(i),
        default: i === index,
      })),
    });
  }

  /**
   * Sends a paginated reply.
   * @param {import('discord.js').RepliableInteraction} interaction
   * @param {Array<import('discord.js').EmbedBuilder|{embed: object, label?: string}>} pages
   * @param {{ ephemeral?: boolean, ownerOnly?: boolean, startIndex?: number }} [opts]
   */
  async send(interaction, pages, opts = {}) {
    const normalized = pages.map((p) => (p && p.embed ? p : { embed: p }));
    if (!normalized.length) throw new Error('paginator called with zero pages');

    // A single page needs no controls at all.
    if (normalized.length === 1) {
      const payload = { embeds: [normalized[0].embed] };
      if (opts.ephemeral) payload.flags = MessageFlags.Ephemeral;
      return interaction.replied || interaction.deferred
        ? interaction.editReply(payload)
        : interaction.reply(payload);
    }

    const token = rng.id(6);
    const index = Math.min(Math.max(0, opts.startIndex || 0), normalized.length - 1);
    this.sessions.set(token, {
      pages: normalized,
      ownerId: opts.ownerOnly === false ? null : interaction.user.id,
      index,
      createdAt: Date.now(),
    });

    const components = [this.buildRow(token, index, normalized.length)];
    const jump = this.buildSelect(token, normalized, index);
    if (jump) components.push(jump);

    const payload = { embeds: [normalized[index].embed], components };
    if (opts.ephemeral) payload.flags = MessageFlags.Ephemeral;
    return interaction.replied || interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload);
  }

  /** Component router entry point. */
  async handle(interaction, parts) {
    const [action, token] = parts;
    const session = this.sessions.get(token);

    if (!session) {
      return interaction.update({
        content: 'This menu expired. Run the command again to get fresh controls.',
        components: [],
      }).catch(() => {});
    }
    if (session.ownerId && interaction.user.id !== session.ownerId) {
      return interaction.reply({
        content: 'Only the person who ran the command can page through this.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const total = session.pages.length;
    switch (action) {
      case 'first':
        session.index = 0;
        break;
      case 'prev':
        session.index = Math.max(0, session.index - 1);
        break;
      case 'next':
        session.index = Math.min(total - 1, session.index + 1);
        break;
      case 'last':
        session.index = total - 1;
        break;
      case 'jump':
        session.index = Math.min(total - 1, Math.max(0, Number(interaction.values?.[0]) || 0));
        break;
      default:
        return;
    }
    // Touch the session so an actively used paginator does not expire mid-read.
    session.createdAt = Date.now();

    const components = [this.buildRow(token, session.index, total)];
    const jump = this.buildSelect(token, session.pages, session.index);
    if (jump) components.push(jump);

    await interaction.update({ embeds: [session.pages[session.index].embed], components });
  }

  /** Registers this paginator with the component router. */
  attach(router) {
    router.register(NAMESPACE, (interaction, parts) => this.handle(interaction, parts));
    return this;
  }

  stats() {
    return { sessions: this.sessions.size };
  }
}

/**
 * Splits a flat array of lines into pages of `perPage` entries, then hands each
 * chunk to a render function that returns an embed.
 */
function paginate(items, perPage, render) {
  const pages = [];
  const total = Math.max(1, Math.ceil(items.length / perPage));
  for (let i = 0; i < items.length; i += perPage) {
    const slice = items.slice(i, i + perPage);
    pages.push({
      embed: render(slice, { page: pages.length + 1, total, offset: i }),
      label: `Page ${pages.length + 1}`,
    });
  }
  if (!pages.length) pages.push({ embed: render([], { page: 1, total: 1, offset: 0 }), label: 'Page 1' });
  return pages;
}

module.exports = { Paginator, paginate, NAMESPACE };
