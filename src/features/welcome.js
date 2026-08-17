'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const { template } = require('../util/text');

/**
 * Welcome, goodbye and autorole.
 *
 * All three hang off member join/leave, and all three depend on the SERVER
 * MEMBERS privileged intent. When that intent is unavailable the events simply
 * never fire, so each entry point checks and logs once rather than failing
 * silently - "the welcome message stopped working" is otherwise a very hard
 * thing to diagnose from the outside.
 */

/** Placeholders available in welcome and goodbye templates. */
function vars(member) {
  return {
    user: `<@${member.id}>`,
    tag: member.user.tag,
    username: member.user.username,
    id: member.id,
    server: member.guild.name,
    count: member.guild.memberCount,
    ordinal: member.guild.memberCount,
  };
}

function init(bot) {
  const log = bot.log.child('welcome');
  let warnedNoIntent = false;

  /** Falls back to a sensibly named channel when none is configured. */
  function autoDetect(guild) {
    const configured = bot.config.welcomeChannel;
    if (configured) {
      const byId = guild.channels.cache.get(configured);
      if (byId) return byId;
      const byName = guild.channels.cache.find((c) => c.name === configured);
      if (byName) return byName;
    }
    return guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        /general|welcome|lobby|chat|新人|欢迎/i.test(c.name) &&
        c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages),
    );
  }

  const api = {
    vars,

    /** Builds the welcome payload without sending it, so /welcome test can reuse it. */
    buildWelcome(member, settings) {
      const body = template(settings.welcome.message, vars(member));
      if (!settings.welcome.embed) return { content: body, allowedMentions: { users: [member.id] } };

      const embed = embeds
        .base(`Welcome to ${member.guild.name}`, body, embeds.theme.success)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setFooter({ text: `Member #${member.guild.memberCount}` });
      if (settings.welcome.imageBanner) embed.setImage(settings.welcome.imageBanner);
      return { content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } };
    },

    buildGoodbye(member, settings) {
      const body = template(settings.goodbye.message, vars(member));
      if (!settings.goodbye.embed) return { content: body, allowedMentions: { parse: [] } };
      return {
        embeds: [
          embeds
            .base('Member left', body, embeds.theme.neutral)
            .setThumbnail(member.user.displayAvatarURL({ size: 128 })),
        ],
      };
    },

    /** Handles a join: welcome message, DM and autorole. */
    async onJoin(member) {
      if (!bot.intents.members && !warnedNoIntent) {
        warnedNoIntent = true;
        log.warn('member events are unavailable without the SERVER MEMBERS INTENT');
      }
      const settings = bot.db.settings(member.guild.id);

      // ---------- channel welcome ----------
      if (settings.welcome.enabled) {
        const channel = settings.welcome.channelId
          ? await bot.resolveChannel(member.guild, settings.welcome.channelId)
          : autoDetect(member.guild);

        if (channel) {
          const message = await channel.send(api.buildWelcome(member, settings)).catch((e) => {
            log.debug(`welcome message failed in ${member.guild.name}: ${e.message}`);
            return null;
          });
          if (message && settings.welcome.deleteAfter > 0) {
            setTimeout(() => message.delete().catch(() => {}), settings.welcome.deleteAfter * 1000);
          }
        } else {
          log.debug(`no usable welcome channel in ${member.guild.name}`);
        }
      }

      // ---------- direct message ----------
      if (settings.welcome.dm && settings.welcome.dmMessage) {
        await member.send(template(settings.welcome.dmMessage, vars(member))).catch(() => {
          // Closed DMs are the norm, not an error worth logging at info level.
        });
      }

      // ---------- autorole ----------
      if (settings.autorole.enabled) {
        const delay = (settings.autorole.delaySeconds || 0) * 1000;
        if (delay > 0) {
          // Persisted rather than a bare setTimeout so a restart during the
          // delay does not leave the member without their role forever.
          bot.scheduler.scheduleIn('autorole', delay, { userId: member.id }, { guildId: member.guild.id });
        } else {
          await api.applyAutorole(member);
        }
      }
    },

    /** Grants the configured roles, respecting the bot/human split. */
    async applyAutorole(member) {
      const settings = bot.db.settings(member.guild.id);
      if (!settings.autorole.enabled) return [];
      const me = member.guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        log.debug(`cannot autorole in ${member.guild.name}: missing Manage Roles`);
        return [];
      }

      const wanted = member.user.bot
        ? settings.autorole.botRoleIds.length
          ? settings.autorole.botRoleIds
          : []
        : settings.autorole.roleIds;

      const granted = [];
      for (const roleId of wanted) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role || role.managed || role.position >= me.roles.highest.position) continue;
        const ok = await member.roles.add(role, 'Autorole').then(() => true).catch(() => false);
        if (ok) granted.push(role.name);
      }
      return granted;
    },

    /** Handles a leave. */
    async onLeave(member) {
      const settings = bot.db.settings(member.guild.id);
      if (!settings.goodbye.enabled) return;
      const channelId = settings.goodbye.channelId || settings.welcome.channelId;
      if (!channelId) return;
      await bot.sendTo(member.guild, channelId, api.buildGoodbye(member, settings));
    },
  };

  // A delayed autorole is a scheduled task, so it survives restarts.
  bot.scheduler.register('autorole', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    if (!guild) return;
    const member = await guild.members.fetch(task.data.userId).catch(() => null);
    if (!member) return; // they left during the delay, which is fine
    await api.applyAutorole(member);
  });

  return api;
}

module.exports = { name: 'welcome', init };
