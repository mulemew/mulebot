'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const embeds = require('../../util/embeds');
const perms = require('../../util/perms');
const { parseDuration, formatDuration, relative } = require('../../util/time');
const { number, truncate } = require('../../util/text');

/**
 * Channel and member management: /purge, /lock, /unlock, /slowmode, /nick,
 * /role.
 *
 * /purge deserves a note. Discord's bulk delete refuses messages older than 14
 * days and silently ignores pinned ones, so a naive implementation reports
 * "deleted 100" and deletes 12. This one filters first, deletes what it can,
 * and tells you exactly what it skipped and why.
 */

const purge = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete recent messages')
    .addIntegerOption((o) =>
      o.setName('count').setDescription('How many to check, 1-100').setRequired(true).setMinValue(1).setMaxValue(100),
    )
    .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this member'))
    .addStringOption((o) =>
      o
        .setName('filter')
        .setDescription('Only delete a certain kind of message')
        .addChoices(
          { name: 'bots', value: 'bots' },
          { name: 'humans', value: 'humans' },
          { name: 'with attachments', value: 'attachments' },
          { name: 'with links', value: 'links' },
          { name: 'with embeds', value: 'embeds' },
        ),
    )
    .addStringOption((o) => o.setName('contains').setDescription('Only delete messages containing this text'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: 'moderation',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageMessages],
  botPerms: [PermissionFlagsBits.ManageMessages],
  examples: ['/purge count:50', '/purge count:100 user:@spammer', '/purge count:50 filter:bots'],

  async execute(ctx) {
    if (!ctx.channel?.isTextBased()) return ctx.fail('This channel does not support bulk deletion.');

    const count = ctx.int('count');
    const user = ctx.userOpt('user');
    const filter = ctx.str('filter');
    const contains = ctx.str('contains')?.toLowerCase();

    await ctx.defer({ ephemeral: true });

    // Always fetch the full 100 when filtering, since the requested count is a
    // target for *matches*, not for messages examined.
    const fetchLimit = user || filter || contains ? 100 : count;
    const fetched = await ctx.channel.messages.fetch({ limit: fetchLimit });

    const cutoff = Date.now() - 14 * 86_400_000;
    let tooOld = 0;
    let pinned = 0;

    const candidates = [...fetched.values()].filter((message) => {
      if (message.pinned) {
        pinned++;
        return false;
      }
      if (message.createdTimestamp <= cutoff) {
        tooOld++;
        return false;
      }
      if (user && message.author.id !== user.id) return false;
      if (filter === 'bots' && !message.author.bot) return false;
      if (filter === 'humans' && message.author.bot) return false;
      if (filter === 'attachments' && !message.attachments.size) return false;
      if (filter === 'embeds' && !message.embeds.length) return false;
      if (filter === 'links' && !/https?:\/\//i.test(message.content)) return false;
      if (contains && !message.content.toLowerCase().includes(contains)) return false;
      return true;
    });

    const toDelete = candidates.slice(0, count);

    if (!toDelete.length) {
      return ctx.send({
        embeds: [
          embeds.warning(
            'Nothing deleted',
            [
              'No messages matched your filter.',
              tooOld ? `${tooOld} were older than 14 days, which Discord refuses to bulk delete.` : null,
              pinned ? `${pinned} pinned message(s) were skipped.` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      });
    }

    const deleted = await ctx.channel.bulkDelete(toDelete, true);

    const details = [
      `Deleted **${deleted.size}** message(s).`,
      user ? `Only from ${user.tag}.` : null,
      filter ? `Filter: ${filter}.` : null,
      contains ? `Containing "${truncate(contains, 50)}".` : null,
      tooOld ? `\n${tooOld} message(s) were skipped for being older than 14 days.` : null,
      pinned ? `${pinned} pinned message(s) were left alone.` : null,
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.bot.features.logging?.post(
      ctx.guild,
      'messageBulkDelete',
      embeds
        .base('Purge', details, embeds.theme.danger)
        .addFields(
          { name: 'Moderator', value: `<@${ctx.user.id}>`, inline: true },
          { name: 'Channel', value: `<#${ctx.i.channelId}>`, inline: true },
        ),
    );

    return ctx.send({ embeds: [embeds.success('Purged', details)] });
  },
};

const lock = {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Stop members sending messages in a channel')
    .addChannelOption((o) => o.setName('channel').setDescription('Which channel, defaults to this one'))
    .addStringOption((o) => o.setName('duration').setDescription('Unlock automatically after, e.g. 30m'))
    .addStringOption((o) => o.setName('reason').setDescription('Announced in the channel'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: 'moderation',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageChannels],
  botPerms: [PermissionFlagsBits.ManageChannels],

  async execute(ctx) {
    const channel = ctx.channelOpt('channel', true);
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      return ctx.fail('Only text channels can be locked.');
    }

    const everyone = ctx.guild.roles.everyone;
    const current = channel.permissionOverwrites.cache.get(everyone.id);
    if (current?.deny.has(PermissionFlagsBits.SendMessages)) {
      return ctx.fail(`${channel} is already locked. Use \`/unlock\` to open it.`);
    }

    const reason = ctx.str('reason', 'No reason provided');
    const durationRaw = ctx.str('duration');
    let ms = 0;
    if (durationRaw) {
      ms = parseDuration(durationRaw);
      if (ms === null) return ctx.tfail('err.badDuration');
    }

    await channel.permissionOverwrites.edit(
      everyone,
      { SendMessages: false },
      { reason: `${ctx.user.tag}: ${reason}` },
    );

    if (ms) {
      ctx.bot.scheduler.scheduleIn('unlock_channel', ms, { channelId: channel.id }, { guildId: ctx.i.guildId });
    }

    // Announce in the locked channel itself: members watching it should see why
    // it went quiet, not just find they cannot type.
    await channel
      .send({
        embeds: [
          embeds.warning(
            'Channel locked',
            [reason, ms ? `\nIt unlocks automatically ${relative(Date.now() + ms)}.` : null].filter(Boolean).join('\n'),
          ),
        ],
      })
      .catch(() => {});

    return ctx.ok(
      'Locked',
      `${channel} is locked${ms ? ` for ${formatDuration(ms)}` : ''}.`,
      { ephemeral: channel.id !== ctx.i.channelId },
    );
  },
};

const unlock = {
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Let members send messages again')
    .addChannelOption((o) => o.setName('channel').setDescription('Which channel, defaults to this one'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: 'moderation',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageChannels],
  botPerms: [PermissionFlagsBits.ManageChannels],

  async execute(ctx) {
    const channel = ctx.channelOpt('channel', true);
    const everyone = ctx.guild.roles.everyone;

    const current = channel.permissionOverwrites.cache.get(everyone.id);
    if (!current?.deny.has(PermissionFlagsBits.SendMessages)) {
      return ctx.fail(`${channel} is not locked.`);
    }

    // null, not true: setting it to true would *grant* Send Messages, which is
    // not the same as removing the override and can override a category deny.
    await channel.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: `${ctx.user.tag} unlocked` });
    ctx.bot.scheduler.cancelWhere((t) => t.type === 'unlock_channel' && t.data.channelId === channel.id);

    await channel.send({ embeds: [embeds.success('Channel unlocked', 'You can post here again.')] }).catch(() => {});
    return ctx.ok('Unlocked', `${channel} is open.`, { ephemeral: channel.id !== ctx.i.channelId });
  },
};

const slowmode = {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set how long members must wait between messages')
    .addStringOption((o) =>
      o.setName('duration').setDescription('e.g. 10s, 2m, 1h. Use 0 or "off" to disable').setRequired(true),
    )
    .addChannelOption((o) => o.setName('channel').setDescription('Which channel, defaults to this one'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: 'moderation',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageChannels],
  botPerms: [PermissionFlagsBits.ManageChannels],

  async execute(ctx) {
    const channel = ctx.channelOpt('channel', true);
    if (!channel.isTextBased()) return ctx.fail('That channel does not support slowmode.');

    const raw = ctx.str('duration').trim().toLowerCase();
    let seconds;
    if (raw === 'off' || raw === '0') seconds = 0;
    else {
      const ms = parseDuration(raw);
      if (ms === null) return ctx.tfail('err.badDuration');
      seconds = Math.round(ms / 1000);
    }

    if (seconds > 21_600) return ctx.fail('Discord caps slowmode at 6 hours.');

    await channel.setRateLimitPerUser(seconds, `${ctx.user.tag} changed slowmode`);

    return ctx.ok(
      'Slowmode updated',
      seconds === 0
        ? `Slowmode is off in ${channel}.`
        : `Members must wait **${formatDuration(seconds * 1000, { compact: false })}** between messages in ${channel}.`,
    );
  },
};

const nick = {
  data: new SlashCommandBuilder()
    .setName('nick')
    .setDescription('Change a member\'s nickname')
    .addUserOption((o) => o.setName('user').setDescription('Whose nickname').setRequired(true))
    .addStringOption((o) => o.setName('nickname').setDescription('New nickname, leave empty to reset'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ManageNicknames],
  botPerms: [PermissionFlagsBits.ManageNicknames],

  async execute(ctx) {
    const user = ctx.userOpt('user');
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);
    if (!member) return ctx.tfail('err.memberNotFound');

    // Discord refuses a nickname change on the guild owner no matter what
    // permissions the bot has; saying so beats a bare API error.
    if (member.id === ctx.guild.ownerId) return ctx.fail('Discord does not allow anyone to rename the server owner.');
    if (!member.manageable) return ctx.fail('Their highest role is not below mine, so I cannot rename them.');

    const nickname = ctx.str('nickname');
    if (nickname && nickname.length > 32) return ctx.fail('Nicknames must be 32 characters or fewer.');

    const before = member.nickname || member.user.username;
    await member.setNickname(nickname || null, `${ctx.user.tag} changed the nickname`);

    return ctx.ok(
      nickname ? 'Nickname changed' : 'Nickname reset',
      `**${before}** → **${nickname || member.user.username}**`,
    );
  },
};

const role = {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Add or remove roles')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give a member a role')
        .addUserOption((o) => o.setName('user').setDescription('Target member').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('Remove it again after, e.g. 7d')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take a role away')
        .addUserOption((o) => o.setName('user').setDescription('Target member').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Who has a role')
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ManageRoles],
  botPerms: [PermissionFlagsBits.ManageRoles],

  async execute(ctx) {
    const target = ctx.roleOpt('role');

    if (ctx.sub === 'info') {
      const members = target.members;
      return ctx.send({
        embeds: [
          embeds
            .base(`${target.name} — ${number(members.size)} member(s)`, null, target.color || undefined)
            .setDescription(
              members.size
                ? truncate(members.map((m) => `<@${m.id}>`).join(' '), 4000)
                : 'Nobody has this role.',
            ),
        ],
      });
    }

    const user = ctx.userOpt('user');
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);
    if (!member) return ctx.tfail('err.memberNotFound');

    const problem = perms.checkRole(ctx.guild, target);
    if (problem) return ctx.fail(problem);

    // A moderator must not be able to grant a role above their own; without
    // this check /role add is a straight privilege escalation.
    if (!perms.canGrantRole(ctx.member, target)) {
      return ctx.fail(`**${target.name}** is at or above your highest role, so you cannot hand it out.`);
    }

    if (ctx.sub === 'add') {
      if (member.roles.cache.has(target.id)) return ctx.fail(`They already have **${target.name}**.`);

      await member.roles.add(target, `${ctx.user.tag} via /role`);

      const durationRaw = ctx.str('duration');
      if (durationRaw) {
        const ms = parseDuration(durationRaw);
        if (ms === null) return ctx.tfail('err.badDuration');
        ctx.bot.scheduler.scheduleIn(
          'remove_role',
          ms,
          { userId: member.id, roleId: target.id },
          { guildId: ctx.i.guildId, userId: member.id },
        );
        return ctx.ok('Role added', `<@${member.id}> now has **${target.name}** for ${formatDuration(ms)}.`);
      }

      return ctx.ok('Role added', `<@${member.id}> now has **${target.name}**.`);
    }

    if (!member.roles.cache.has(target.id)) return ctx.fail(`They do not have **${target.name}**.`);
    await member.roles.remove(target, `${ctx.user.tag} via /role`);
    ctx.bot.scheduler.cancelWhere(
      (t) => t.type === 'remove_role' && t.data.userId === member.id && t.data.roleId === target.id,
    );
    return ctx.ok('Role removed', `<@${member.id}> no longer has **${target.name}**.`);
  },
};

module.exports = [purge, lock, unlock, slowmode, nick, role];
