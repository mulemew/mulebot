'use strict';

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const { truncate, progressBar, pct } = require('../util/text');

/**
 * Suggestion board.
 *
 * Votes are stored per suggestion rather than read from reactions, for the same
 * reason giveaway entries are: reaction counts cannot tell you *who* voted
 * without a paginated fetch, so "you already voted" and vote switching are
 * impossible to implement correctly on top of them.
 *
 * Suggestion state lives in the guild store keyed by message id, so a restart
 * leaves every open suggestion clickable.
 */

function init(bot) {
  const log = bot.log.child('suggestions');

  function key(guildId, messageId) {
    return `${guildId}.suggestionData.${messageId}`;
  }

  function load(guildId, messageId) {
    return bot.db.stores.guilds.get(key(guildId, messageId), null);
  }

  function save(guildId, messageId, data) {
    bot.db.stores.guilds.set(key(guildId, messageId), data);
    bot.db.settingsCache.delete(guildId);
    return data;
  }

  const api = {
    /** Renders a suggestion embed from its stored state. */
    render(data) {
      const up = data.up.length;
      const down = data.down.length;
      const total = up + down;
      const ratio = total ? up / total : 0;

      const statusColor = {
        open: embeds.theme.primary,
        approved: embeds.theme.success,
        denied: embeds.theme.danger,
        implemented: embeds.theme.info,
      }[data.status];

      const embed = embeds
        .base(`Suggestion #${data.number}`, truncate(data.body, 3500), statusColor)
        .addFields(
          { name: 'Author', value: `<@${data.authorId}>`, inline: true },
          { name: 'Status', value: data.status, inline: true },
          {
            name: `Votes (${total})`,
            value: total
              ? `\`${progressBar(ratio, 18)}\`\n👍 ${up} · 👎 ${down} · ${pct(up, total)} in favour`
              : 'No votes yet.',
          },
        );

      if (data.staffNote) {
        embed.addFields({ name: `Response from ${data.staffTag || 'staff'}`, value: truncate(data.staffNote, 1024) });
      }
      return embed;
    },

    buildRow(messageId, data) {
      if (data.status !== 'open') {
        return components.buttonRow({
          id: components.customId('sg', 'closed', messageId),
          label: data.status,
          style: 'Secondary',
          disabled: true,
        });
      }
      return components.buttonRow(
        { id: components.customId('sg', 'up', messageId), label: String(data.up.length), emoji: '👍', style: 'Success' },
        { id: components.customId('sg', 'down', messageId), label: String(data.down.length), emoji: '👎', style: 'Danger' },
        { id: components.customId('sg', 'who', messageId), emoji: '📊', style: 'Secondary' },
      );
    },

    /** Posts a new suggestion. */
    async submit(interaction, body) {
      const settings = bot.db.settings(interaction.guildId);
      if (!settings.suggestions.enabled || !settings.suggestions.channelId) {
        return { ok: false, error: 'Suggestions are not set up. An admin can run `/config suggestions`.' };
      }
      const channel = await bot.resolveChannel(interaction.guild, settings.suggestions.channelId);
      if (!channel) return { ok: false, error: 'I cannot post in the configured suggestion channel.' };

      const number = (settings.suggestions.counter || 0) + 1;
      bot.db.setSetting(interaction.guildId, 'suggestions.counter', number);

      const data = {
        number,
        authorId: interaction.user.id,
        authorTag: interaction.user.tag,
        body,
        status: 'open',
        up: [],
        down: [],
        createdAt: Date.now(),
        channelId: channel.id,
      };

      const message = await channel.send({ embeds: [api.render(data)], components: [api.buildRow('pending', data)] });
      save(interaction.guildId, message.id, data);
      await message.edit({ components: [api.buildRow(message.id, data)] }).catch(() => {});

      if (settings.suggestions.threads) {
        await message.startThread({ name: `Suggestion #${number}`, autoArchiveDuration: 1440 }).catch(() => {});
      }

      return { ok: true, message, number };
    },

    /** Handles a vote button. */
    async vote(interaction, messageId, direction) {
      const data = load(interaction.guildId, messageId);
      if (!data) {
        return interaction.reply({ content: 'This suggestion is no longer tracked.', flags: MessageFlags.Ephemeral });
      }
      if (data.status !== 'open') {
        return interaction.reply({ content: 'Voting is closed on this suggestion.', flags: MessageFlags.Ephemeral });
      }

      const userId = interaction.user.id;
      const target = direction === 'up' ? data.up : data.down;
      const other = direction === 'up' ? data.down : data.up;

      // Switching sides removes the old vote; clicking the same side again
      // withdraws it entirely.
      const otherIndex = other.indexOf(userId);
      if (otherIndex !== -1) other.splice(otherIndex, 1);

      const index = target.indexOf(userId);
      let message;
      if (index !== -1) {
        target.splice(index, 1);
        message = 'Vote withdrawn.';
      } else {
        target.push(userId);
        message = direction === 'up' ? 'Voted in favour.' : 'Voted against.';
      }

      save(interaction.guildId, messageId, data);
      await interaction.update({ embeds: [api.render(data)], components: [api.buildRow(messageId, data)] });
      return interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    },

    /** Shows who voted, staff only, because vote privacy matters by default. */
    async who(interaction, messageId) {
      const data = load(interaction.guildId, messageId);
      if (!data) return interaction.reply({ content: 'Not tracked.', flags: MessageFlags.Ephemeral });

      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        const total = data.up.length + data.down.length;
        return interaction.reply({
          content: `**${data.up.length}** in favour, **${data.down.length}** against, ${total} total.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const list = (ids) => (ids.length ? ids.map((id) => `<@${id}>`).join(', ') : 'nobody');
      return interaction.reply({
        embeds: [
          embeds
            .base(`Suggestion #${data.number} votes`)
            .addFields(
              { name: `👍 ${data.up.length}`, value: truncate(list(data.up), 1024) },
              { name: `👎 ${data.down.length}`, value: truncate(list(data.down), 1024) },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },

    /** Approves, denies or marks a suggestion implemented. */
    async resolve(guild, messageId, status, { note, staff } = {}) {
      const data = load(guild.id, messageId);
      if (!data) return { ok: false, error: 'That suggestion id is not tracked in this server.' };

      data.status = status;
      data.staffNote = note || null;
      data.staffTag = staff?.tag || null;
      data.resolvedAt = Date.now();
      save(guild.id, messageId, data);

      const channel = await bot.resolveChannel(guild, data.channelId);
      const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (message) {
        await message.edit({ embeds: [api.render(data)], components: [api.buildRow(messageId, data)] }).catch(() => {});
      }

      // Mirror to the approved/denied archive channel when one is configured.
      const settings = bot.db.settings(guild.id);
      const archiveId = status === 'approved' ? settings.suggestions.approvedChannelId : settings.suggestions.deniedChannelId;
      if (archiveId) await bot.sendTo(guild, archiveId, { embeds: [api.render(data)] });

      // Tell the author, who otherwise has to keep checking the channel.
      const author = await bot.client.users.fetch(data.authorId).catch(() => null);
      await author
        ?.send({
          embeds: [
            embeds.base(
              `Your suggestion #${data.number} was ${status}`,
              `In **${guild.name}**.\n\n> ${truncate(data.body, 500)}` + (note ? `\n\n**Staff response:** ${note}` : ''),
            ),
          ],
        })
        .catch(() => {});

      log.info(`suggestion #${data.number} in ${guild.name} marked ${status}`);
      return { ok: true, data };
    },

    /** All tracked suggestions for a guild. */
    list(guildId, { status = null } = {}) {
      const all = bot.db.stores.guilds.get(`${guildId}.suggestionData`, {});
      return Object.entries(all)
        .map(([messageId, data]) => ({ messageId, ...data }))
        .filter((s) => !status || s.status === status)
        .sort((a, b) => b.number - a.number);
    },
  };

  bot.components.register('sg', async (interaction, parts) => {
    const [action, messageId] = parts;
    if (action === 'up' || action === 'down') return api.vote(interaction, messageId, action);
    if (action === 'who') return api.who(interaction, messageId);
    return null;
  });

  return api;
}

module.exports = { name: 'suggestions', init };
