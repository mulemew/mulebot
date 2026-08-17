'use strict';

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { fullTimestamp, formatDuration, relative } = require('../util/time');
const { number, humanList } = require('../util/text');

/**
 * Giveaways.
 *
 * Entries are stored, not counted from reactions. Reaction-based giveaways look
 * simpler until the draw, at which point they need to fetch every reactor, which
 * is paginated, rate limited, and quietly truncated at large counts - producing
 * a draw that silently excludes people. A button that appends a user id to a
 * stored array is exact, cheap and auditable.
 *
 * The end time is a scheduled task, so a restart mid-giveaway costs nothing.
 */

function init(bot) {
  const log = bot.log.child('giveaways');

  const store = bot.db.stores.giveaways;

  /** Requirements a member must satisfy to enter. */
  function checkRequirements(giveaway, member) {
    const problems = [];
    if (giveaway.requiredRoleId && !member.roles.cache.has(giveaway.requiredRoleId)) {
      problems.push(`you need the <@&${giveaway.requiredRoleId}> role`);
    }
    if (giveaway.minLevel) {
      const record = bot.db.member(member.guild.id, member.id);
      const level = bot.features.leveling?.levelFromXp(record.xp) ?? 0;
      if (level < giveaway.minLevel) problems.push(`you need to be level ${giveaway.minLevel} (you are ${level})`);
    }
    if (giveaway.minAccountDays) {
      const days = (Date.now() - member.user.createdTimestamp) / 86_400_000;
      if (days < giveaway.minAccountDays) problems.push(`your account must be at least ${giveaway.minAccountDays} days old`);
    }
    if (giveaway.minServerDays && member.joinedTimestamp) {
      const days = (Date.now() - member.joinedTimestamp) / 86_400_000;
      if (days < giveaway.minServerDays) problems.push(`you must have been in the server for ${giveaway.minServerDays} days`);
    }
    return problems;
  }

  const api = {
    /** Live giveaway record by message id. */
    get(messageId) {
      return store.get(messageId, null);
    },

    /** All giveaways in a guild. */
    forGuild(guildId, { includeEnded = false } = {}) {
      return Object.entries(store.data || {})
        .filter(([, g]) => g.guildId === guildId && (includeEnded || !g.ended))
        .map(([messageId, g]) => ({ messageId, ...g }));
    },

    /** Builds the giveaway embed. */
    render(giveaway) {
      const embed = embeds
        .base(`🎉 ${giveaway.prize}`, null, giveaway.ended ? embeds.theme.neutral : embeds.theme.primary)
        .addFields(
          { name: 'Winners', value: String(giveaway.winnerCount), inline: true },
          { name: 'Entries', value: number(giveaway.entries.length), inline: true },
          {
            name: giveaway.ended ? 'Ended' : 'Ends',
            value: giveaway.ended ? fullTimestamp(giveaway.endsAt) : `${relative(giveaway.endsAt)}\n${fullTimestamp(giveaway.endsAt)}`,
            inline: true,
          },
        )
        .setFooter({ text: `Hosted by ${giveaway.hostTag}` });

      if (giveaway.description) embed.setDescription(giveaway.description);

      const requirements = [];
      if (giveaway.requiredRoleId) requirements.push(`role <@&${giveaway.requiredRoleId}>`);
      if (giveaway.minLevel) requirements.push(`level ${giveaway.minLevel}+`);
      if (giveaway.minAccountDays) requirements.push(`account ${giveaway.minAccountDays}d+`);
      if (giveaway.minServerDays) requirements.push(`member ${giveaway.minServerDays}d+`);
      if (requirements.length) embed.addFields({ name: 'Requirements', value: humanList(requirements) });

      if (giveaway.ended && giveaway.winners?.length) {
        embed.addFields({ name: 'Winners', value: giveaway.winners.map((id) => `<@${id}>`).join(', ') });
      }
      return embed;
    },

    /** Buttons for an active giveaway. */
    buildRow(messageId, giveaway) {
      if (giveaway.ended) {
        return components.buttonRow({
          id: components.customId('gw', 'ended', messageId),
          label: 'Ended',
          emoji: '🎉',
          style: 'Secondary',
          disabled: true,
        });
      }
      return components.buttonRow(
        { id: components.customId('gw', 'enter', messageId), label: 'Enter', emoji: '🎉', style: 'Primary' },
        {
          id: components.customId('gw', 'count', messageId),
          label: `${giveaway.entries.length}`,
          style: 'Secondary',
          disabled: true,
        },
      );
    },

    /** Starts a giveaway and posts its message. */
    async start(interaction, options) {
      const channel = options.channel || interaction.channel;
      const giveaway = {
        guildId: interaction.guildId,
        channelId: channel.id,
        prize: options.prize,
        description: options.description || null,
        winnerCount: Math.max(1, Math.min(20, options.winners || 1)),
        endsAt: Date.now() + options.durationMs,
        hostId: interaction.user.id,
        hostTag: interaction.user.tag,
        entries: [],
        ended: false,
        winners: [],
        requiredRoleId: options.requiredRoleId || null,
        minLevel: options.minLevel || 0,
        minAccountDays: options.minAccountDays || 0,
        minServerDays: options.minServerDays || 0,
        createdAt: Date.now(),
      };

      const message = await channel.send({
        embeds: [api.render(giveaway)],
        components: [api.buildRow('pending', giveaway)],
      });

      // The custom ids need the real message id, which only exists after the
      // send, so the row is rebuilt once.
      store.set(message.id, giveaway);
      await message.edit({ components: [api.buildRow(message.id, giveaway)] }).catch(() => {});

      bot.scheduler.schedule('giveaway_end', giveaway.endsAt, { messageId: message.id }, { guildId: interaction.guildId });
      log.info(`giveaway "${options.prize}" started in ${interaction.guild.name}, ends ${new Date(giveaway.endsAt).toISOString()}`);
      return { message, giveaway };
    },

    /** Handles the Enter button. */
    async enter(interaction, messageId) {
      const giveaway = api.get(messageId);
      if (!giveaway) {
        return interaction.reply({ content: 'This giveaway no longer exists.', flags: MessageFlags.Ephemeral });
      }
      if (giveaway.ended) {
        return interaction.reply({ content: 'This giveaway has already ended.', flags: MessageFlags.Ephemeral });
      }

      const index = giveaway.entries.indexOf(interaction.user.id);
      if (index !== -1) {
        // Clicking again leaves, which is friendlier than an inert button.
        giveaway.entries.splice(index, 1);
        store.set(messageId, giveaway);
        await api.refresh(interaction.guild, messageId, giveaway);
        return interaction.reply({ content: 'You left the giveaway.', flags: MessageFlags.Ephemeral });
      }

      const problems = checkRequirements(giveaway, interaction.member);
      if (problems.length) {
        return interaction.reply({
          content: `You cannot enter: ${humanList(problems)}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      giveaway.entries.push(interaction.user.id);
      store.set(messageId, giveaway);
      await api.refresh(interaction.guild, messageId, giveaway);
      return interaction.reply({
        content: `You are entered. ${giveaway.entries.length} total. Ends ${relative(giveaway.endsAt)}.`,
        flags: MessageFlags.Ephemeral,
      });
    },

    /** Re-renders the giveaway message after the entry count changes. */
    async refresh(guild, messageId, giveaway) {
      const channel = await bot.resolveChannel(guild, giveaway.channelId);
      const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (!message) return false;
      await message
        .edit({ embeds: [api.render(giveaway)], components: [api.buildRow(messageId, giveaway)] })
        .catch(() => {});
      return true;
    },

    /**
     * Draws winners and closes the giveaway.
     * @param {string} messageId
     * @param {{ reroll?: boolean, count?: number }} [opts]
     */
    async end(messageId, opts = {}) {
      const giveaway = api.get(messageId);
      if (!giveaway) return null;

      const guild = bot.client.guilds.cache.get(giveaway.guildId);
      if (!guild) return null;

      // Members who left cannot win; filtering here rather than at entry time
      // means someone who leaves and rejoins keeps their place.
      const present = [];
      for (const userId of giveaway.entries) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) present.push(userId);
      }

      const count = opts.count || giveaway.winnerCount;
      const winners = rng.sample(present, Math.min(count, present.length));

      giveaway.ended = true;
      giveaway.winners = opts.reroll ? winners : winners;
      giveaway.endedAt = Date.now();
      store.set(messageId, giveaway);

      const channel = await bot.resolveChannel(guild, giveaway.channelId);
      if (channel) {
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (message) {
          await message
            .edit({ embeds: [api.render(giveaway)], components: [api.buildRow(messageId, giveaway)] })
            .catch(() => {});
        }

        if (winners.length) {
          await channel
            .send({
              content: winners.map((id) => `<@${id}>`).join(' '),
              embeds: [
                embeds.success(
                  opts.reroll ? 'Rerolled' : 'Giveaway ended',
                  `**${giveaway.prize}**\n${winners.map((id) => `<@${id}>`).join(', ')} won out of ${present.length} entries.` +
                    (message ? `\n\n[Jump to the giveaway](${message.url})` : ''),
                ),
              ],
              allowedMentions: { users: winners },
            })
            .catch(() => {});

          // Winners get a DM as well, because the ping is easy to miss.
          for (const id of winners) {
            const user = await bot.client.users.fetch(id).catch(() => null);
            await user
              ?.send({
                embeds: [
                  embeds.success(
                    'You won a giveaway',
                    `You won **${giveaway.prize}** in **${guild.name}**.\nContact <@${giveaway.hostId}> to claim it.`,
                  ),
                ],
              })
              .catch(() => {});
          }
        } else {
          await channel
            .send({
              embeds: [
                embeds.warning('Giveaway ended', `Nobody entered **${giveaway.prize}**, so there is no winner.`),
              ],
            })
            .catch(() => {});
        }
      }

      log.info(`giveaway ${messageId} ended with ${winners.length} winner(s) from ${present.length} entries`);
      return { giveaway, winners, entries: present.length };
    },

    /** Ends a giveaway early. */
    async endEarly(messageId) {
      bot.scheduler.cancelWhere((t) => t.type === 'giveaway_end' && t.data.messageId === messageId);
      return api.end(messageId);
    },

    /** Picks fresh winners for an already-ended giveaway. */
    async reroll(messageId, count = 1) {
      const giveaway = api.get(messageId);
      if (!giveaway) return null;
      if (!giveaway.ended) return { error: 'That giveaway is still running.' };
      return api.end(messageId, { reroll: true, count });
    },

    /** Removes finished giveaways older than a week to bound the store. */
    prune() {
      const cutoff = Date.now() - 7 * 86_400_000;
      let removed = 0;
      for (const [messageId, g] of Object.entries(store.data || {})) {
        if (g.ended && (g.endedAt || g.endsAt) < cutoff) {
          store.delete(messageId);
          removed++;
        }
      }
      return removed;
    },

    /** Permission helper shared by the command file. */
    canManage(member) {
      return (
        member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        member.permissions.has(PermissionFlagsBits.ManageEvents)
      );
    },
  };

  bot.scheduler.register('giveaway_end', async (task) => {
    await api.end(task.data.messageId);
  });

  // Daily housekeeping, re-armed by the scheduler's repeat support.
  bot.scheduler.register('giveaway_prune', () => {
    const removed = api.prune();
    if (removed) log.debug(`pruned ${removed} finished giveaway(s)`);
  });
  if (!bot.scheduler.find({ type: 'giveaway_prune' }).length) {
    bot.scheduler.scheduleIn('giveaway_prune', 3_600_000, {}, { repeatMs: 86_400_000 });
  }

  bot.components.register('gw', async (interaction, parts) => {
    const [action, messageId] = parts;
    if (action === 'enter') return api.enter(interaction, messageId);
    return null;
  });

  void formatDuration;
  return api;
}

module.exports = { name: 'giveaways', init };
