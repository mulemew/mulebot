'use strict';

const embeds = require('../util/embeds');
const { fullTimestamp } = require('../util/time');

/**
 * Member lifecycle events.
 *
 * All of these require the SERVER MEMBERS privileged intent. When it is off the
 * events never arrive at all, so there is nothing to guard against here beyond
 * the one warning the welcome feature emits.
 */

module.exports = [
  {
    name: 'guildMemberAdd',
    async execute(bot, member) {
      try {
        await bot.features.welcome?.onJoin(member);
      } catch (e) {
        bot.log.error('welcome handler failed:', e);
      }

      await bot.features.logging?.post(member.guild, 'memberJoin', bot.features.logging.memberJoined(member));

      // Rejoining does not clear a case history, but it should clear an AFK
      // flag - it is meaningless once they have been gone.
      const record = bot.db.member(member.guild.id, member.id);
      if (record.afk) {
        record.afk = null;
        bot.db.saveMember();
      }
    },
  },

  {
    name: 'guildMemberRemove',
    async execute(bot, member) {
      try {
        await bot.features.welcome?.onLeave(member);
      } catch (e) {
        bot.log.error('goodbye handler failed:', e);
      }
      await bot.features.logging?.post(member.guild, 'memberLeave', bot.features.logging.memberLeft(member));
    },
  },

  {
    name: 'guildMemberUpdate',
    async execute(bot, before, after) {
      const changes = [];

      if (before.nickname !== after.nickname) {
        changes.push({
          name: 'Nickname',
          value: `${before.nickname || '(none)'} → ${after.nickname || '(none)'}`,
        });
      }

      const addedRoles = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
      const removedRoles = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
      if (addedRoles.size) {
        changes.push({ name: 'Roles added', value: addedRoles.map((r) => `<@&${r.id}>`).join(' ').slice(0, 1024) });
      }
      if (removedRoles.size) {
        changes.push({ name: 'Roles removed', value: removedRoles.map((r) => `<@&${r.id}>`).join(' ').slice(0, 1024) });
      }

      // Timeouts arrive as a member update rather than their own event, so they
      // are decoded here to produce a useful log line.
      const beforeTimeout = before.communicationDisabledUntilTimestamp || 0;
      const afterTimeout = after.communicationDisabledUntilTimestamp || 0;
      if (beforeTimeout !== afterTimeout) {
        if (afterTimeout > Date.now()) {
          await bot.features.logging?.post(
            after.guild,
            'memberTimeout',
            embeds
              .base('Member timed out', null, embeds.theme.warning)
              .addFields(
                bot.features.logging.memberField(after.user),
                { name: 'Until', value: fullTimestamp(afterTimeout) },
              ),
          );
        } else if (beforeTimeout > Date.now()) {
          await bot.features.logging?.post(
            after.guild,
            'memberTimeout',
            embeds
              .base('Timeout removed', null, embeds.theme.success)
              .addFields(bot.features.logging.memberField(after.user)),
          );
        }
      }

      if (!changes.length) return;
      await bot.features.logging?.post(
        after.guild,
        'memberUpdate',
        bot.features.logging.memberUpdated(before, after, changes),
      );
    },
  },
];
