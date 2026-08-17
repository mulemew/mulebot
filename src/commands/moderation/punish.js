'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const perms = require('../../util/perms');
const { parseDuration, formatDuration, fullTimestamp, relative } = require('../../util/time');
const { truncate, number } = require('../../util/text');

/**
 * Punishment commands: /kick, /ban, /softban, /unban, /timeout, /untimeout.
 *
 * Each one follows the same shape, and the order matters:
 *
 *   1. resolve the target
 *   2. run the hierarchy check (perms.checkTarget) which produces a *specific*
 *      refusal, not a generic one
 *   3. DM the member while the shared server still exists - after a ban the bot
 *      can no longer open a DM channel with them
 *   4. perform the action
 *   5. record the case
 *
 * Getting 3 and 4 the wrong way round is the single most common bug in
 * moderation bots, and it silently costs the member any explanation.
 */

/** Shared pre-flight for every command that targets a member. */
async function resolveTarget(ctx, action, { allowAbsent = false } = {}) {
  const user = ctx.userOpt('user');
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);

  if (!member && !allowAbsent) return { error: ctx.t('err.memberNotFound') };
  if (member) {
    const problem = perms.checkTarget(ctx.i, member, action, {
      protectedRoles: ctx.settings.moderation.protectedRoles,
      t: ctx.t,
    });
    if (problem) return { error: problem };
  }
  return { user, member };
}

const kick = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from the server')
    .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Recorded in the case log and sent to them'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.KickMembers],
  botPerms: [PermissionFlagsBits.KickMembers],

  async execute(ctx) {
    const { user, member, error } = await resolveTarget(ctx, 'kick');
    if (error) return ctx.fail(error);

    const reason = ctx.str('reason', 'No reason provided');
    if (!member.kickable) return ctx.fail('Discord will not let me kick that member. Check my role position.');

    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'kick',
      user,
      moderator: ctx.user,
      reason,
    });

    await member.kick(`${ctx.user.tag}: ${reason}`);

    return ctx.send({
      embeds: [
        embeds
          .success('Member kicked', `**${user.tag}** was removed from the server.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Moderator', value: `<@${ctx.user.id}>`, inline: true },
            { name: 'Case', value: `#${entry.id}`, inline: true },
          ),
      ],
    });
  },
};

const ban = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member, permanently or for a set time')
    .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Recorded in the case log and sent to them'))
    .addStringOption((o) => o.setName('duration').setDescription('Temporary ban, e.g. 7d. Leave empty for permanent'))
    .addIntegerOption((o) =>
      o.setName('delete_days').setDescription('Also delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.BanMembers],
  botPerms: [PermissionFlagsBits.BanMembers],
  examples: ['/ban user:@spammer reason:advertising delete_days:1', '/ban user:@x duration:7d'],

  async execute(ctx) {
    // A user who already left can still be banned, so an absent member is fine.
    const { user, member, error } = await resolveTarget(ctx, 'ban', { allowAbsent: true });
    if (error) return ctx.fail(error);

    const reason = ctx.str('reason', 'No reason provided');
    const days = ctx.int('delete_days', 0);
    const durationRaw = ctx.str('duration');

    let durationMs = 0;
    if (durationRaw) {
      durationMs = parseDuration(durationRaw);
      if (durationMs === null) return ctx.tfail('err.badDuration');
      if (durationMs < 60_000) return ctx.fail('The shortest temporary ban is one minute.');
    }

    if (member && !member.bannable) {
      return ctx.fail('Discord will not let me ban that member. Check my role position.');
    }

    const existing = await ctx.guild.bans.fetch(user.id).catch(() => null);
    if (existing) return ctx.fail(`**${user.tag}** is already banned.`);

    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'ban',
      user,
      moderator: ctx.user,
      reason,
      duration: durationMs,
    });

    await ctx.guild.members.ban(user.id, {
      reason: `${ctx.user.tag}: ${reason}`,
      deleteMessageSeconds: days * 86_400,
    });

    // A temporary ban is a ban plus a scheduled reversal, which survives a
    // restart because the scheduler is persistent.
    if (durationMs) {
      ctx.bot.scheduler.scheduleIn('unban', durationMs, { userId: user.id }, { guildId: ctx.i.guildId, userId: user.id });
    }

    return ctx.send({
      embeds: [
        embeds
          .success(durationMs ? 'Member temporarily banned' : 'Member banned', `**${user.tag}** (\`${user.id}\`)`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Messages purged', value: days ? `${days} day(s)` : 'none', inline: true },
            {
              name: 'Expires',
              value: durationMs ? `${fullTimestamp(Date.now() + durationMs)}\n(${formatDuration(durationMs)})` : 'never',
              inline: true,
            },
            { name: 'Moderator', value: `<@${ctx.user.id}>`, inline: true },
            { name: 'Case', value: `#${entry.id}`, inline: true },
          ),
      ],
    });
  },
};

const softban = {
  data: new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Ban and immediately unban, to delete a member\'s recent messages')
    .addUserOption((o) => o.setName('user').setDescription('Who to softban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason'))
    .addIntegerOption((o) =>
      o.setName('days').setDescription('How many days of messages to remove (1-7)').setMinValue(1).setMaxValue(7),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.BanMembers],
  botPerms: [PermissionFlagsBits.BanMembers],

  async execute(ctx) {
    const { user, member, error } = await resolveTarget(ctx, 'softban');
    if (error) return ctx.fail(error);
    if (!member.bannable) return ctx.fail('Discord will not let me ban that member. Check my role position.');

    const reason = ctx.str('reason', 'No reason provided');
    const days = ctx.int('days', 1);

    const entry = await ctx.bot.features.moderation.softban(ctx.guild, user, {
      reason,
      days,
      moderator: ctx.user,
    });

    return ctx.send({
      embeds: [
        embeds
          .success('Member softbanned', `**${user.tag}** was removed and their recent messages deleted.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Messages removed', value: `${days} day(s)`, inline: true },
            { name: 'Case', value: `#${entry.id}`, inline: true },
          )
          .setFooter({ text: 'They can rejoin with a fresh invite — this is a kick that also cleans up.' }),
      ],
    });
  },
};

const unban = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Lift a ban')
    .addStringOption((o) =>
      o.setName('user').setDescription('User ID, or start typing a name').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.BanMembers],
  botPerms: [PermissionFlagsBits.BanMembers],

  async autocomplete(ctx) {
    // Nobody remembers a snowflake, so the ban list itself is the picker.
    const focused = ctx.i.options.getFocused().toLowerCase();
    const bans = await ctx.guild.bans.fetch().catch(() => null);
    if (!bans) return ctx.i.respond([]);

    const matches = [...bans.values()]
      .filter((b) => b.user.tag.toLowerCase().includes(focused) || b.user.id.includes(focused))
      .slice(0, 25)
      .map((b) => ({ name: truncate(`${b.user.tag} — ${b.reason || 'no reason'}`, 100), value: b.user.id }));

    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const id = ctx.str('user').trim();
    if (!/^\d{17,20}$/.test(id)) {
      return ctx.fail('That is not a valid user ID. Pick from the suggestions, or paste a 17–20 digit ID.');
    }

    const existing = await ctx.guild.bans.fetch(id).catch(() => null);
    if (!existing) return ctx.fail('That user is not on the ban list.');

    const reason = ctx.str('reason', 'No reason provided');
    await ctx.guild.bans.remove(id, `${ctx.user.tag}: ${reason}`);

    // Cancel a pending automatic unban, or it would fire against a fresh ban
    // later and quietly undo a moderator's decision.
    ctx.bot.scheduler.cancelWhere((t) => t.type === 'unban' && t.data.userId === id && t.guildId === ctx.i.guildId);

    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'unban',
      user: existing.user,
      moderator: ctx.user,
      reason,
      notify: false, // they are not in the server, so a DM would not reach them
    });

    return ctx.send({
      embeds: [
        embeds
          .success('Ban lifted', `**${existing.user.tag}** (\`${id}\`) can rejoin.`)
          .addFields(
            { name: 'Original ban reason', value: existing.reason || 'none recorded' },
            { name: 'Case', value: `#${entry.id}`, inline: true },
          ),
      ],
    });
  },
};

const timeout = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Mute a member for a while (Discord caps this at 28 days)')
    .addUserOption((o) => o.setName('user').setDescription('Who to time out').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ModerateMembers],
  botPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(ctx) {
    const { user, member, error } = await resolveTarget(ctx, 'time out');
    if (error) return ctx.fail(error);

    const ms = parseDuration(ctx.str('duration'));
    if (ms === null) return ctx.tfail('err.badDuration');
    if (ms > 28 * 86_400_000) return ctx.fail('Discord caps timeouts at 28 days. Use `/ban duration:` for longer.');
    if (ms < 5000) return ctx.fail('The shortest timeout is 5 seconds.');

    const reason = ctx.str('reason', 'No reason provided');
    if (!member.moderatable) return ctx.fail('Discord will not let me time out that member. Check my role position.');

    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'timeout',
      user,
      moderator: ctx.user,
      reason,
      duration: ms,
    });

    await member.timeout(ms, `${ctx.user.tag}: ${reason}`);
    const until = Date.now() + ms;

    return ctx.send({
      embeds: [
        embeds
          .success('Member timed out', `**${user.tag}** cannot send messages or join voice.`)
          .addFields(
            { name: 'Duration', value: formatDuration(ms, { compact: false }), inline: true },
            { name: 'Expires', value: `${fullTimestamp(until)}\n${relative(until)}` },
            { name: 'Reason', value: reason },
            { name: 'Case', value: `#${entry.id}`, inline: true },
          ),
      ],
    });
  },
};

const untimeout = {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('End a member\'s timeout early')
    .addUserOption((o) => o.setName('user').setDescription('Who to release').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ModerateMembers],
  botPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(ctx) {
    const user = ctx.userOpt('user');
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);
    if (!member) return ctx.tfail('err.memberNotFound');

    if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
      return ctx.fail(`**${user.tag}** is not currently timed out.`);
    }

    const reason = ctx.str('reason', 'No reason provided');
    await member.timeout(null, `${ctx.user.tag}: ${reason}`);

    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'untimeout',
      user,
      moderator: ctx.user,
      reason,
    });

    return ctx.ok('Timeout removed', `**${user.tag}** can speak again. Case #${entry.id}.`);
  },
};

const modstats = {
  data: new SlashCommandBuilder()
    .setName('modstats')
    .setDescription('Moderation activity on this server')
    .addUserOption((o) => o.setName('moderator').setDescription('Show one moderator\'s activity'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 10,
  userPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(ctx) {
    const all = ctx.db.cases(ctx.i.guildId);
    if (!all.length) return ctx.fail('No moderation cases have been recorded on this server yet.');

    const moderator = ctx.userOpt('moderator');
    const scoped = moderator ? all.filter((c) => c.moderatorId === moderator.id) : all;
    if (!scoped.length) return ctx.fail(`**${moderator.tag}** has not filed any cases.`);

    const byType = {};
    for (const c of scoped) byType[c.type] = (byType[c.type] || 0) + 1;

    const week = scoped.filter((c) => Date.now() - c.at < 7 * 86_400_000).length;
    const month = scoped.filter((c) => Date.now() - c.at < 30 * 86_400_000).length;

    const embed = embeds
      .base(moderator ? `Moderation by ${moderator.tag}` : `Moderation in ${ctx.guild.name}`)
      .addFields(
        { name: 'Total cases', value: number(scoped.length), inline: true },
        { name: 'Last 7 days', value: number(week), inline: true },
        { name: 'Last 30 days', value: number(month), inline: true },
        {
          name: 'By type',
          value: Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `${type}: **${count}**`)
            .join('\n'),
        },
      );

    if (!moderator) {
      const byMod = {};
      for (const c of scoped) {
        const key = c.moderatorTag || 'automod';
        byMod[key] = (byMod[key] || 0) + 1;
      }
      embed.addFields({
        name: 'By moderator',
        value: Object.entries(byMod)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => `${name}: **${count}**`)
          .join('\n'),
      });
    }

    return ctx.send({ embeds: [embed] });
  },
};

module.exports = [kick, ban, softban, unban, timeout, untimeout, modstats];
