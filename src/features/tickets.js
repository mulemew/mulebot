'use strict';

const { ChannelType, PermissionFlagsBits, MessageFlags, AttachmentBuilder } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const { truncate, template } = require('../util/text');
const { fullTimestamp } = require('../util/time');

/**
 * Support tickets.
 *
 * A ticket is a private channel created from a persistent panel button. The
 * important design choice is that ticket state lives in tickets.json keyed by
 * channel id, not in a collector: panels are meant to sit in a channel for
 * months and keep working across restarts, which a collector cannot do.
 *
 * Closing produces a plain-text transcript before the channel is deleted,
 * because the most common complaint about ticket bots is that the conversation
 * vanishes the moment it is resolved.
 */

function init(bot) {
  const log = bot.log.child('tickets');

  /** Live tickets for a guild: { channelId: ticket }. */
  function open(guildId) {
    return bot.db.stores.tickets.get(`${guildId}.open`, {});
  }

  function ticketFor(guildId, channelId) {
    return bot.db.stores.tickets.get(`${guildId}.open.${channelId}`, null);
  }

  const api = {
    open,
    ticketFor,

    /** Panel embed plus its open button. */
    buildPanel(guild, { title, description } = {}) {
      const embed = embeds.base(
        title || 'Support',
        description || 'Click the button below to open a private ticket with the staff team.',
      );
      const row = components.buttonRow({
        id: components.customId('ticket', 'open'),
        label: 'Open a ticket',
        emoji: '🎫',
        style: 'Primary',
      });
      void guild;
      return { embeds: [embed], components: [row] };
    },

    /** Creates a ticket channel for a member. */
    async create(interaction) {
      const guild = interaction.guild;
      const settings = bot.db.settings(guild.id);
      const cfg = settings.tickets;

      if (!cfg.enabled) {
        return interaction.reply({ content: 'Tickets are not enabled on this server.', flags: MessageFlags.Ephemeral });
      }

      const me = guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
          content: 'I am missing the **Manage Channels** permission, so I cannot create a ticket channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // One ticket per member by default: a member who opens six tickets while
      // waiting is the single most common way these channels get out of hand.
      const existing = Object.entries(open(guild.id)).filter(([, t]) => t.userId === interaction.user.id);
      if (existing.length >= (cfg.maxOpenPerUser || 1)) {
        return interaction.reply({
          content: `You already have an open ticket: <#${existing[0][0]}>`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const number = (bot.db.settings(guild.id).tickets.counter || 0) + 1;
      bot.db.setSetting(guild.id, 'tickets.counter', number);

      const name = template(cfg.nameTemplate || 'ticket-{number}', {
        number: String(number).padStart(4, '0'),
        user: interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'member',
      }).slice(0, 90);

      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ];
      for (const roleId of cfg.supportRoleIds || []) {
        if (!guild.roles.cache.has(roleId)) continue;
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        });
      }

      let channel;
      try {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: cfg.categoryId || null,
          permissionOverwrites: overwrites,
          reason: `Ticket opened by ${interaction.user.tag}`,
        });
      } catch (e) {
        log.warn(`ticket creation failed in ${guild.name}: ${e.message}`);
        return interaction.editReply(
          'I could not create the channel. The configured category may be full (50 channel limit) or deleted.',
        );
      }

      bot.db.stores.tickets.set(`${guild.id}.open.${channel.id}`, {
        number,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        openedAt: Date.now(),
        participants: [interaction.user.id],
      });

      const welcome = embeds
        .base(`Ticket #${String(number).padStart(4, '0')}`, cfg.openMessage)
        .addFields({ name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true });

      const row = components.buttonRow(
        { id: components.customId('ticket', 'close', channel.id), label: 'Close', emoji: '🔒', style: 'Danger' },
        { id: components.customId('ticket', 'claim', channel.id), label: 'Claim', emoji: '🙋', style: 'Secondary' },
      );

      const mentions = [`<@${interaction.user.id}>`, ...(cfg.supportRoleIds || []).map((r) => `<@&${r}>`)].join(' ');
      await channel.send({ content: mentions, embeds: [welcome], components: [row] }).catch(() => {});

      return interaction.editReply(`Your ticket is open: <#${channel.id}>`);
    },

    /** Marks a ticket as handled by a staff member. */
    async claim(interaction, channelId) {
      const ticket = ticketFor(interaction.guildId, channelId);
      if (!ticket) return interaction.reply({ content: 'This is not an open ticket.', flags: MessageFlags.Ephemeral });

      const settings = bot.db.settings(interaction.guildId);
      const isStaff =
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
        (settings.tickets.supportRoleIds || []).some((r) => interaction.member.roles.cache.has(r));
      if (!isStaff) {
        return interaction.reply({ content: 'Only support staff can claim a ticket.', flags: MessageFlags.Ephemeral });
      }

      if (ticket.claimedBy) {
        return interaction.reply({
          content: `Already claimed by <@${ticket.claimedBy}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      ticket.claimedBy = interaction.user.id;
      bot.db.stores.tickets.set(`${interaction.guildId}.open.${channelId}`, ticket);

      return interaction.reply({
        embeds: [embeds.success('Claimed', `<@${interaction.user.id}> is handling this ticket.`)],
      });
    },

    /** Builds a plain-text transcript of a ticket channel. */
    async transcript(channel, ticket) {
      const lines = [
        `Transcript for ticket #${String(ticket.number).padStart(4, '0')}`,
        `Channel: #${channel.name} (${channel.id})`,
        `Opened by: ${ticket.userTag} (${ticket.userId})`,
        `Opened at: ${new Date(ticket.openedAt).toISOString()}`,
        `Closed at: ${new Date().toISOString()}`,
        ''.padEnd(60, '-'),
        '',
      ];

      // Discord caps a fetch at 100 messages, so page backwards until exhausted
      // or until a sane ceiling - a runaway ticket should not produce a 20MB file.
      let before;
      const collected = [];
      for (let page = 0; page < 10; page++) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch?.size) break;
        collected.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
      }

      for (const message of collected.reverse()) {
        const stamp = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
        const body = message.content || '';
        const attachments = message.attachments.size
          ? ` [attachments: ${[...message.attachments.values()].map((a) => a.name).join(', ')}]`
          : '';
        const embedNote = message.embeds.length ? ` [${message.embeds.length} embed(s)]` : '';
        lines.push(`[${stamp}] ${message.author.tag}: ${body}${attachments}${embedNote}`);
      }

      return lines.join('\n');
    },

    /** Closes a ticket: transcript, notify, delete. */
    async close(interaction, channelId) {
      const guild = interaction.guild;
      const ticket = ticketFor(guild.id, channelId);
      if (!ticket) return interaction.reply({ content: 'This is not an open ticket.', flags: MessageFlags.Ephemeral });

      const settings = bot.db.settings(guild.id);
      const isOwner = ticket.userId === interaction.user.id;
      const isStaff =
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
        (settings.tickets.supportRoleIds || []).some((r) => interaction.member.roles.cache.has(r));
      if (!isOwner && !isStaff) {
        return interaction.reply({ content: 'Only the ticket opener or staff can close this.', flags: MessageFlags.Ephemeral });
      }

      await interaction.reply({ embeds: [embeds.warning('Closing', 'Saving the transcript, then deleting this channel.')] });

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        bot.db.stores.tickets.delete(`${guild.id}.open.${channelId}`);
        return null;
      }

      const body = await api.transcript(channel, ticket).catch(() => 'Transcript could not be generated.');

      if (settings.tickets.transcriptChannelId) {
        const file = new AttachmentBuilder(Buffer.from(body, 'utf8'), {
          name: `ticket-${String(ticket.number).padStart(4, '0')}.txt`,
        });
        const summary = embeds
          .base(`Ticket #${String(ticket.number).padStart(4, '0')} closed`)
          .addFields(
            { name: 'Opened by', value: `<@${ticket.userId}>`, inline: true },
            { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Open for', value: fullTimestamp(ticket.openedAt) },
            { name: 'Claimed by', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Nobody', inline: true },
          );
        await bot.sendTo(guild, settings.tickets.transcriptChannelId, { embeds: [summary], files: [file] });
      }

      // Send the opener their own copy while the shared server still exists.
      const opener = await bot.client.users.fetch(ticket.userId).catch(() => null);
      if (opener) {
        const file = new AttachmentBuilder(Buffer.from(body, 'utf8'), {
          name: `ticket-${String(ticket.number).padStart(4, '0')}.txt`,
        });
        await opener
          .send({
            embeds: [embeds.base(`Your ticket in ${guild.name} was closed`, truncate(body.slice(0, 300), 300))],
            files: [file],
          })
          .catch(() => {});
      }

      bot.db.stores.tickets.delete(`${guild.id}.open.${channelId}`);
      // A short delay lets the "closing" reply render before the channel goes.
      setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 4000);
      return true;
    },

    /** Adds or removes a member from a ticket channel. */
    async setAccess(channel, user, allowed) {
      return channel.permissionOverwrites
        .edit(user.id, {
          ViewChannel: allowed,
          SendMessages: allowed,
          ReadMessageHistory: allowed,
        })
        .then(() => true)
        .catch(() => false);
    },
  };

  bot.components.register('ticket', async (interaction, parts) => {
    const [action, channelId] = parts;
    if (action === 'open') return api.create(interaction);
    if (action === 'close') return api.close(interaction, channelId || interaction.channelId);
    if (action === 'claim') return api.claim(interaction, channelId || interaction.channelId);
    return null;
  });

  return api;
}

module.exports = { name: 'tickets', init };
