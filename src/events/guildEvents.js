'use strict';

const embeds = require('../util/embeds');
const { fullTimestamp } = require('../util/time');

/**
 * Guild-level events: joins and leaves for the bot itself, bans, and the
 * structural changes (roles, channels) that a server audit log wants.
 */

module.exports = [
  {
    name: 'guildCreate',
    async execute(bot, guild) {
      bot.log.info(`joined ${guild.name} (${guild.id}) with ${guild.memberCount} members`);
      if (!bot.db.settings(guild.id).stats.joinedAt) {
        bot.db.setSetting(guild.id, 'stats.joinedAt', Date.now());
      }

      // A short orientation message in the first channel the bot can post in.
      // Servers add bots and then have no idea what to do next; one message with
      // the two commands that matter fixes that without being spam.
      const channel = guild.channels.cache.find(
        (c) => c.isTextBased?.() && c.permissionsFor(guild.members.me)?.has('SendMessages'),
      );
      if (!channel) return;

      await channel
        .send({
          embeds: [
            embeds
              .base(
                'Thanks for the invite',
                [
                  'Run `/help` to see everything I can do.',
                  'Run `/config` to switch on levelling, the economy, automod, logging and the rest — everything is off by default.',
                  '',
                  'Nothing is enabled until an admin turns it on, so I will stay quiet until then.',
                ].join('\n'),
              )
              .setFooter({ text: 'Set up by a server administrator' }),
          ],
        })
        .catch(() => {});
    },
  },

  {
    name: 'guildDelete',
    async execute(bot, guild) {
      bot.log.info(`removed from ${guild.name || guild.id}`);
      // Settings are deliberately kept: a bot re-invited after an accidental
      // kick should not come back with a blank configuration.
      bot.scheduler.cancelWhere((t) => t.guildId === guild.id);
    },
  },

  {
    name: 'guildBanAdd',
    async execute(bot, ban) {
      await bot.features.logging?.post(
        ban.guild,
        'memberBan',
        embeds
          .base('Member banned', null, embeds.theme.danger)
          .addFields(
            bot.features.logging.memberField(ban.user),
            { name: 'Reason', value: ban.reason || 'No reason recorded' },
          ),
      );
    },
  },

  {
    name: 'guildBanRemove',
    async execute(bot, ban) {
      await bot.features.logging?.post(
        ban.guild,
        'memberUnban',
        embeds.base('Ban lifted', null, embeds.theme.success).addFields(bot.features.logging.memberField(ban.user)),
      );
    },
  },

  {
    name: 'roleCreate',
    async execute(bot, role) {
      await bot.features.logging?.post(role.guild, 'roleCreate', bot.features.logging.roleChanged(role, 'created'));
    },
  },

  {
    name: 'roleDelete',
    async execute(bot, role) {
      await bot.features.logging?.post(role.guild, 'roleDelete', bot.features.logging.roleChanged(role, 'deleted'));

      // A deleted role leaves dangling references in half the settings tree.
      // Cleaning up here avoids a class of confusing "nothing happens" bugs
      // where a level reward or autorole silently points at nothing.
      const settings = bot.db.settings(role.guild.id);
      const patch = {};

      if (settings.autorole.roleIds.includes(role.id)) {
        patch['autorole.roleIds'] = settings.autorole.roleIds.filter((r) => r !== role.id);
      }
      if (settings.moderation.protectedRoles.includes(role.id)) {
        patch['moderation.protectedRoles'] = settings.moderation.protectedRoles.filter((r) => r !== role.id);
      }
      if (settings.moderation.muteRoleId === role.id) patch['moderation.muteRoleId'] = null;

      const rewards = { ...settings.leveling.rewards };
      let rewardsChanged = false;
      for (const [level, ids] of Object.entries(rewards)) {
        if (!ids.includes(role.id)) continue;
        const next = ids.filter((r) => r !== role.id);
        rewardsChanged = true;
        if (next.length) rewards[level] = next;
        else delete rewards[level];
      }
      if (rewardsChanged) patch['leveling.rewards'] = rewards;

      if (Object.keys(patch).length) {
        bot.db.patchSettings(role.guild.id, patch);
        bot.log.debug(`cleaned settings references to deleted role ${role.id}`);
      }
    },
  },

  {
    name: 'roleUpdate',
    async execute(bot, before, after) {
      const changes = [];
      if (before.name !== after.name) changes.push(`name: ${before.name} → ${after.name}`);
      if (before.color !== after.color) {
        changes.push(`colour: #${before.color.toString(16)} → #${after.color.toString(16)}`);
      }
      if (before.permissions.bitfield !== after.permissions.bitfield) changes.push('permissions changed');
      if (!changes.length) return;

      await bot.features.logging?.post(
        after.guild,
        'roleUpdate',
        bot.features.logging.roleChanged(after, 'updated').addFields({ name: 'Changes', value: changes.join('\n') }),
      );
    },
  },

  {
    name: 'channelCreate',
    async execute(bot, channel) {
      if (!channel.guild) return;
      await bot.features.logging?.post(
        channel.guild,
        'channelCreate',
        bot.features.logging.channelChanged(channel, 'created'),
      );
    },
  },

  {
    name: 'channelDelete',
    async execute(bot, channel) {
      if (!channel.guild) return;
      await bot.features.logging?.post(
        channel.guild,
        'channelDelete',
        bot.features.logging.channelChanged(channel, 'deleted'),
      );

      // A deleted ticket channel must not stay in the open-ticket table, or the
      // member can never open another one.
      if (bot.db.stores.tickets.get(`${channel.guild.id}.open.${channel.id}`)) {
        bot.db.stores.tickets.delete(`${channel.guild.id}.open.${channel.id}`);
      }
    },
  },

  {
    name: 'channelUpdate',
    async execute(bot, before, after) {
      if (!after.guild) return;
      const changes = [];
      if (before.name !== after.name) changes.push(`name: ${before.name} → ${after.name}`);
      if (before.topic !== after.topic) changes.push('topic changed');
      if (before.nsfw !== after.nsfw) changes.push(`nsfw: ${before.nsfw} → ${after.nsfw}`);
      if (before.rateLimitPerUser !== after.rateLimitPerUser) {
        changes.push(`slowmode: ${before.rateLimitPerUser}s → ${after.rateLimitPerUser}s`);
      }
      if (!changes.length) return;

      await bot.features.logging?.post(
        after.guild,
        'channelUpdate',
        bot.features.logging
          .channelChanged(after, 'updated')
          .addFields({ name: 'Changes', value: changes.join('\n') }),
      );
    },
  },

  {
    name: 'guildScheduledEventCreate',
    async execute(bot, event) {
      if (!event.guild) return;
      await bot.features.logging?.post(
        event.guild,
        'channelCreate',
        embeds
          .base('Scheduled event created', event.name, embeds.theme.info)
          .addFields({ name: 'Starts', value: event.scheduledStartTimestamp ? fullTimestamp(event.scheduledStartTimestamp) : 'Unknown' }),
      );
    },
  },
];
