'use strict';

const { SlashCommandBuilder, ChannelType, GuildVerificationLevel, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const perms = require('../../util/perms');
const { fullTimestamp, relative } = require('../../util/time');
const { number, truncate, humanList } = require('../../util/text');
const colors = require('../../data/colors');

/**
 * Information commands: /avatar, /userinfo, /serverinfo, /roleinfo,
 * /channelinfo, /emoji.
 *
 * These are the commands people actually use to investigate a member during a
 * moderation incident, so they surface the things that matter for that: account
 * age, join order, timeout state, and dangerous permissions - rather than a
 * decorative wall of IDs.
 */

const avatar = {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Show a user avatar at full size')
    .addUserOption((o) => o.setName('user').setDescription('Target user, defaults to you'))
    .addBooleanOption((o) => o.setName('server').setDescription('Show their server-specific avatar instead')),
  category: 'utility',
  cooldown: 3,

  async execute(ctx) {
    const user = ctx.userOpt('user', true);
    const wantServer = ctx.bool('server');

    const member = wantServer ? await ctx.guild.members.fetch(user.id).catch(() => null) : null;
    const url = (member?.avatarURL({ size: 4096 })) || user.displayAvatarURL({ size: 4096 });

    const embed = embeds
      .base(`${user.tag}`, `[png](${url.replace(/\.\w+\?/, '.png?')}) · [webp](${url}) · [Open](${url})`)
      .setImage(url);

    if (wantServer && !member?.avatarURL()) {
      embed.setFooter({ text: 'They have no server-specific avatar, showing the global one.' });
    }
    return ctx.send({ embeds: [embed] });
  },
};

const userinfo = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show detailed information about a member')
    .addUserOption((o) => o.setName('user').setDescription('Target user, defaults to you')),
  category: 'utility',
  cooldown: 5,
  examples: ['/userinfo', '/userinfo user:@someone'],

  async execute(ctx) {
    const user = ctx.userOpt('user', true);
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);

    const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86_400_000);

    const embed = embeds
      .base(user.tag, user.bot ? 'This account is a bot.' : null)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'User ID', value: `\`${user.id}\``, inline: true },
        { name: 'Account age', value: `${number(accountAgeDays)} days`, inline: true },
        { name: 'Created', value: fullTimestamp(user.createdTimestamp) },
      );

    // A very new account is the single most useful signal during a raid, so it
    // is called out rather than left for the reader to compute.
    if (accountAgeDays < 7) {
      embed.addFields({ name: '⚠️ New account', value: 'This account is less than a week old.' });
      embed.setColor(embeds.theme.warning);
    }

    if (member) {
      const roles = member.roles.cache.filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position);

      embed.addFields(
        { name: 'Joined server', value: member.joinedTimestamp ? fullTimestamp(member.joinedTimestamp) : 'Unknown' },
        { name: 'Nickname', value: member.nickname || '(none)', inline: true },
        { name: 'Highest role', value: roles.first() ? `<@&${roles.first().id}>` : '(none)', inline: true },
        {
          name: `Roles (${roles.size})`,
          value: truncate(roles.map((r) => `<@&${r.id}>`).join(' ') || 'None', 1024),
        },
      );

      // Join position tells you whether someone is a founding member or arrived
      // an hour ago, which a raw date does not convey at a glance.
      const sorted = [...ctx.guild.members.cache.values()]
        .filter((m) => m.joinedTimestamp)
        .sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
      const position = sorted.findIndex((m) => m.id === member.id);
      if (position >= 0) {
        embed.addFields({
          name: 'Join position',
          value: `#${position + 1} of ${sorted.length} cached members`,
          inline: true,
        });
      }

      if (member.communicationDisabledUntilTimestamp > Date.now()) {
        embed.addFields({
          name: '🔇 Timed out',
          value: `Until ${fullTimestamp(member.communicationDisabledUntilTimestamp)}`,
        });
        embed.setColor(embeds.theme.danger);
      }

      if (member.premiumSinceTimestamp) {
        embed.addFields({ name: 'Boosting since', value: fullTimestamp(member.premiumSinceTimestamp), inline: true });
      }

      // Only the permissions worth worrying about.
      const notable = [
        [PermissionFlagsBits.Administrator, 'Administrator'],
        [PermissionFlagsBits.ManageGuild, 'Manage Server'],
        [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
        [PermissionFlagsBits.BanMembers, 'Ban Members'],
        [PermissionFlagsBits.KickMembers, 'Kick Members'],
        [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
        [PermissionFlagsBits.MentionEveryone, 'Mention Everyone'],
      ]
        .filter(([flag]) => member.permissions.has(flag))
        .map(([, name]) => name);
      if (notable.length) embed.addFields({ name: 'Key permissions', value: notable.join(', ') });
    } else {
      embed.addFields({ name: 'Membership', value: 'Not currently in this server.' });
    }

    // Moderation history, but only for people who can act on it.
    if (perms.isModerator(ctx.member)) {
      const cases = ctx.db.casesFor(ctx.guild.id, user.id);
      if (cases.length) {
        const counts = {};
        for (const c of cases) counts[c.type] = (counts[c.type] || 0) + 1;
        embed.addFields({
          name: `Moderation record (${cases.length})`,
          value: `${Object.entries(counts).map(([type, n]) => `${type}: ${n}`).join(' · ')}\nMost recent ${relative(cases[cases.length - 1].at)}`,
        });
      }
    }

    return ctx.send({ embeds: [embed] });
  },
};

const serverinfo = {
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server'),
  category: 'utility',
  cooldown: 5,

  async execute(ctx) {
    const g = ctx.guild;
    const owner = await g.fetchOwner().catch(() => null);

    const channels = g.channels.cache;
    const counts = {
      text: channels.filter((c) => c.type === ChannelType.GuildText).size,
      voice: channels.filter((c) => c.type === ChannelType.GuildVoice).size,
      category: channels.filter((c) => c.type === ChannelType.GuildCategory).size,
      forum: channels.filter((c) => c.type === ChannelType.GuildForum).size,
      stage: channels.filter((c) => c.type === ChannelType.GuildStageVoice).size,
    };

    const verification = {
      [GuildVerificationLevel.None]: 'None',
      [GuildVerificationLevel.Low]: 'Low — verified email',
      [GuildVerificationLevel.Medium]: 'Medium — registered 5 minutes',
      [GuildVerificationLevel.High]: 'High — member for 10 minutes',
      [GuildVerificationLevel.VeryHigh]: 'Highest — verified phone',
    }[g.verificationLevel];

    const embed = embeds
      .base(g.name, g.description || null)
      .addFields(
        { name: 'Server ID', value: `\`${g.id}\``, inline: true },
        { name: 'Owner', value: owner ? `<@${owner.id}>` : 'Unknown', inline: true },
        { name: 'Created', value: fullTimestamp(g.createdTimestamp) },
        { name: 'Members', value: number(g.memberCount), inline: true },
        { name: 'Roles', value: number(g.roles.cache.size), inline: true },
        { name: 'Emojis', value: `${g.emojis.cache.size} / ${g.stickers.cache.size} stickers`, inline: true },
        {
          name: 'Channels',
          value: `${counts.text} text · ${counts.voice} voice · ${counts.category} categories` +
            (counts.forum ? ` · ${counts.forum} forum` : '') +
            (counts.stage ? ` · ${counts.stage} stage` : ''),
        },
        {
          name: 'Boosts',
          value: `Tier ${g.premiumTier} — ${g.premiumSubscriptionCount || 0} boost(s)`,
          inline: true,
        },
        { name: 'Verification', value: verification || 'Unknown', inline: true },
      );

    if (g.iconURL()) embed.setThumbnail(g.iconURL({ size: 256 }));
    if (g.bannerURL()) embed.setImage(g.bannerURL({ size: 1024 }));

    if (g.features.length) {
      embed.addFields({
        name: 'Features',
        value: truncate(g.features.map((f) => f.toLowerCase().replace(/_/g, ' ')).join(', '), 1024),
      });
    }

    // What this bot is doing here, which is usually the actual question.
    const s = ctx.settings;
    const active = Object.entries({
      levelling: s.leveling.enabled,
      economy: s.economy.enabled,
      automod: s.automod.enabled,
      logging: s.logging.enabled,
      starboard: s.starboard.enabled,
      tickets: s.tickets.enabled,
      welcome: s.welcome.enabled,
      counting: s.counting.enabled,
    })
      .filter(([, on]) => on)
      .map(([name]) => name);

    embed.addFields({
      name: 'Bot features enabled',
      value: active.length ? humanList(active) : 'None — run `/config` to set things up.',
    });

    return ctx.send({ embeds: [embed] });
  },
};

const roleinfo = {
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Show information about a role')
    .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
  category: 'utility',
  cooldown: 3,

  async execute(ctx) {
    const role = ctx.roleOpt('role');
    const hex = `#${role.color.toString(16).padStart(6, '0')}`;

    const keyPerms = role.permissions
      .toArray()
      .filter((p) =>
        ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageMessages', 'MentionEveryone'].includes(p),
      );

    const me = ctx.guild.members.me;
    const manageable = !role.managed && role.position < me.roles.highest.position;

    const embed = embeds
      .base(role.name, null, role.color || embeds.theme.neutral)
      .addFields(
        { name: 'Role ID', value: `\`${role.id}\``, inline: true },
        { name: 'Colour', value: role.color ? `${hex} (${colors.nearestName(role.color).name})` : 'default', inline: true },
        { name: 'Members', value: number(role.members.size), inline: true },
        { name: 'Position', value: `${role.position} of ${ctx.guild.roles.cache.size}`, inline: true },
        { name: 'Hoisted', value: role.hoist ? 'Yes — shown separately' : 'No', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Created', value: fullTimestamp(role.createdTimestamp) },
        {
          name: 'Can I manage it?',
          value: manageable
            ? '✅ Yes'
            : role.managed
              ? '❌ No — it belongs to an integration'
              : '❌ No — it sits above my highest role',
        },
      );

    if (keyPerms.length) embed.addFields({ name: 'Key permissions', value: keyPerms.join(', ') });
    if (role.members.size && role.members.size <= 20) {
      embed.addFields({
        name: 'Members with this role',
        value: truncate(role.members.map((m) => `<@${m.id}>`).join(' '), 1024),
      });
    }

    return ctx.send({ embeds: [embed] });
  },
};

const channelinfo = {
  data: new SlashCommandBuilder()
    .setName('channelinfo')
    .setDescription('Show information about a channel')
    .addChannelOption((o) => o.setName('channel').setDescription('The channel, defaults to this one')),
  category: 'utility',
  cooldown: 3,

  async execute(ctx) {
    const channel = ctx.channelOpt('channel', true);

    const typeNames = {
      [ChannelType.GuildText]: 'Text',
      [ChannelType.GuildVoice]: 'Voice',
      [ChannelType.GuildCategory]: 'Category',
      [ChannelType.GuildAnnouncement]: 'Announcement',
      [ChannelType.GuildStageVoice]: 'Stage',
      [ChannelType.GuildForum]: 'Forum',
      [ChannelType.PublicThread]: 'Public thread',
      [ChannelType.PrivateThread]: 'Private thread',
    };

    const embed = embeds
      .base(`#${channel.name}`, channel.topic || null)
      .addFields(
        { name: 'Channel ID', value: `\`${channel.id}\``, inline: true },
        { name: 'Type', value: typeNames[channel.type] || String(channel.type), inline: true },
        { name: 'Category', value: channel.parent?.name || '(none)', inline: true },
        { name: 'Created', value: fullTimestamp(channel.createdTimestamp) },
      );

    if ('nsfw' in channel) embed.addFields({ name: 'Age restricted', value: channel.nsfw ? 'Yes' : 'No', inline: true });
    if ('rateLimitPerUser' in channel) {
      embed.addFields({
        name: 'Slowmode',
        value: channel.rateLimitPerUser ? `${channel.rateLimitPerUser}s` : 'off',
        inline: true,
      });
    }
    if ('bitrate' in channel) {
      embed.addFields(
        { name: 'Bitrate', value: `${Math.round(channel.bitrate / 1000)}kbps`, inline: true },
        { name: 'User limit', value: channel.userLimit ? String(channel.userLimit) : 'unlimited', inline: true },
      );
    }

    // What the bot can do here, which is the thing worth knowing when a feature
    // "does not work in this channel".
    const mine = channel.permissionsFor(ctx.guild.members.me);
    if (mine) {
      const need = [
        [PermissionFlagsBits.ViewChannel, 'View Channel'],
        [PermissionFlagsBits.SendMessages, 'Send Messages'],
        [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
        [PermissionFlagsBits.AddReactions, 'Add Reactions'],
        [PermissionFlagsBits.ReadMessageHistory, 'Read History'],
      ];
      embed.addFields({
        name: 'My permissions here',
        value: need.map(([flag, name]) => `${mine.has(flag) ? '✅' : '❌'} ${name}`).join('\n'),
      });
    }

    return ctx.send({ embeds: [embed] });
  },
};

const emoji = {
  data: new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Enlarge an emoji or list the server emojis')
    .addStringOption((o) => o.setName('emoji').setDescription('A custom emoji to enlarge')),
  category: 'utility',
  cooldown: 3,

  async execute(ctx) {
    const input = ctx.str('emoji');

    if (!input) {
      const list = ctx.guild.emojis.cache;
      if (!list.size) return ctx.fail('This server has no custom emojis.');

      const animated = list.filter((e) => e.animated);
      const still = list.filter((e) => !e.animated);
      return ctx.send({
        embeds: [
          embeds
            .base(`Emojis in ${ctx.guild.name}`, `${list.size} total — ${still.size} static, ${animated.size} animated`)
            .addFields(
              { name: 'Static', value: truncate(still.map((e) => e.toString()).join(' ') || 'none', 1024) },
              { name: 'Animated', value: truncate(animated.map((e) => e.toString()).join(' ') || 'none', 1024) },
            ),
        ],
      });
    }

    const match = input.match(/<(a?):(\w+):(\d+)>/);
    if (!match) {
      // A unicode emoji has no image to enlarge; say so rather than failing.
      return ctx.fail('That is not a custom emoji. Only custom server emojis can be enlarged.');
    }

    const [, animatedFlag, name, id] = match;
    const url = `https://cdn.discordapp.com/emojis/${id}.${animatedFlag ? 'gif' : 'png'}?size=512`;
    const known = ctx.client.emojis.cache.get(id);

    return ctx.send({
      embeds: [
        embeds
          .base(`:${name}:`, `[Open full size](${url})`)
          .setImage(url)
          .addFields(
            { name: 'ID', value: `\`${id}\``, inline: true },
            { name: 'Animated', value: animatedFlag ? 'Yes' : 'No', inline: true },
            { name: 'From', value: known?.guild?.name || 'a server I am not in', inline: true },
          ),
      ],
    });
  },
};

module.exports = [avatar, userinfo, serverinfo, roleinfo, channelinfo, emoji];
