'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

/**
 * Permission and hierarchy helpers.
 *
 * Discord's role hierarchy is the source of most "why did the bot say no"
 * confusion, so every check here returns a *specific* message rather than a
 * generic refusal. Telling a moderator "move my role higher in the role list"
 * is the difference between a fixed setup and a support ticket.
 */

/** Human names for the permission bits the bot actually asks for. */
const PERMISSION_NAMES = {
  [PermissionFlagsBits.Administrator]: 'Administrator',
  [PermissionFlagsBits.ManageGuild]: 'Manage Server',
  [PermissionFlagsBits.ManageRoles]: 'Manage Roles',
  [PermissionFlagsBits.ManageChannels]: 'Manage Channels',
  [PermissionFlagsBits.ManageMessages]: 'Manage Messages',
  [PermissionFlagsBits.ManageNicknames]: 'Manage Nicknames',
  [PermissionFlagsBits.ManageEmojisAndStickers]: 'Manage Emojis',
  [PermissionFlagsBits.ManageWebhooks]: 'Manage Webhooks',
  [PermissionFlagsBits.ManageThreads]: 'Manage Threads',
  [PermissionFlagsBits.KickMembers]: 'Kick Members',
  [PermissionFlagsBits.BanMembers]: 'Ban Members',
  [PermissionFlagsBits.ModerateMembers]: 'Timeout Members',
  [PermissionFlagsBits.ViewChannel]: 'View Channel',
  [PermissionFlagsBits.SendMessages]: 'Send Messages',
  [PermissionFlagsBits.SendMessagesInThreads]: 'Send Messages in Threads',
  [PermissionFlagsBits.EmbedLinks]: 'Embed Links',
  [PermissionFlagsBits.AttachFiles]: 'Attach Files',
  [PermissionFlagsBits.ReadMessageHistory]: 'Read Message History',
  [PermissionFlagsBits.AddReactions]: 'Add Reactions',
  [PermissionFlagsBits.UseExternalEmojis]: 'Use External Emojis',
  [PermissionFlagsBits.MentionEveryone]: 'Mention Everyone',
  [PermissionFlagsBits.MuteMembers]: 'Mute Members',
  [PermissionFlagsBits.DeafenMembers]: 'Deafen Members',
  [PermissionFlagsBits.MoveMembers]: 'Move Members',
  [PermissionFlagsBits.CreatePublicThreads]: 'Create Public Threads',
  [PermissionFlagsBits.CreatePrivateThreads]: 'Create Private Threads',
};

/** Turns a list of permission bits into readable names. */
function names(perms) {
  return perms.map((p) => PERMISSION_NAMES[p] || new PermissionsBitField(p).toArray().join(', ') || String(p));
}

/** Permissions from `required` that `member` does not have, in the given channel. */
function missing(member, required, channel = null) {
  if (!member) return required;
  const resolved = channel ? member.permissionsIn(channel) : member.permissions;
  return required.filter((p) => !resolved.has(p));
}

/** True when the member has every listed permission. */
function has(member, required, channel = null) {
  return missing(member, required, channel).length === 0;
}

/**
 * Full safety check before a moderation action.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').GuildMember|null} target
 * @param {string} action verb used in the message, e.g. 'kick'
 * @param {{ protectedRoles?: string[], allowSelf?: boolean, t?: Function }} [opts]
 * @returns {string|null} an error message, or null when the action is allowed
 */
function checkTarget(interaction, target, action, opts = {}) {
  const t = opts.t || ((key, vars) => fallbackMessage(key, vars));

  if (!target) return t('err.memberNotFound');
  if (!opts.allowSelf && target.id === interaction.user.id) return t('mod.selfTarget', { action });
  if (target.id === interaction.client.user.id) return t('mod.botTarget', { action });
  if (target.id === interaction.guild.ownerId) return t('mod.ownerTarget');

  // A protected role is a server-level opt-in: staff can mark roles that no
  // moderation command may touch, which stops a moderator from banning an admin.
  const protectedRoles = opts.protectedRoles || [];
  if (protectedRoles.length && target.roles.cache.some((r) => protectedRoles.includes(r.id))) {
    return t('mod.protected');
  }

  const me = interaction.guild.members.me;
  if (me && target.roles.highest.position >= me.roles.highest.position) return t('mod.aboveMe');

  // The server owner outranks everyone, including their own role position.
  if (
    interaction.member.id !== interaction.guild.ownerId &&
    target.roles.highest.position >= interaction.member.roles.highest.position
  ) {
    return t('mod.aboveYou');
  }

  return null;
}

/** English fallbacks so this module works without an i18n instance. */
function fallbackMessage(key, vars = {}) {
  const map = {
    'err.memberNotFound': 'Member not found. They may have already left the server.',
    'mod.selfTarget': `You cannot ${vars.action} yourself.`,
    'mod.botTarget': `I will not ${vars.action} myself.`,
    'mod.ownerTarget': 'The server owner cannot be targeted.',
    'mod.protected': 'That member holds a protected role.',
    'mod.aboveMe': 'Their highest role is not below mine, so I lack permission. Move my role higher in the role list.',
    'mod.aboveYou': 'Their highest role is not below yours, so you cannot target them.',
  };
  return map[key] || key;
}

/**
 * Whether the bot can assign or remove a role.
 * Returns an error string or null.
 */
function checkRole(guild, role, { t } = {}) {
  const me = guild.members.me;
  if (!me) return 'I am not a member of this server.';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I am missing the **Manage Roles** permission.';
  if (role.managed) return `**${role.name}** is managed by an integration and cannot be assigned manually.`;
  if (role.id === guild.id) return 'The @everyone role cannot be assigned.';
  if (role.position >= me.roles.highest.position) {
    return `**${role.name}** is at or above my highest role, so I cannot assign it. Move my role higher in the role list.`;
  }
  return null;
}

/**
 * Whether a member may hand out a role. Moderators must not be able to grant a
 * role above their own, which would be a straightforward privilege escalation.
 */
function canGrantRole(member, role) {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return role.position < member.roles.highest.position;
}

/** Channel-level check for the bot: can it actually post here? */
function canSpeak(channel) {
  if (!channel?.guild) return true; // DMs
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  if (!perms) return false;
  return perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages);
}

/** Same, but also requires the ability to send embeds. */
function canEmbed(channel) {
  if (!channel?.guild) return true;
  const perms = channel.permissionsFor(channel.guild.members.me);
  return Boolean(perms?.has(PermissionFlagsBits.EmbedLinks)) && canSpeak(channel);
}

/** True when the member is staff by any reasonable definition. */
function isStaff(member) {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.id === member.guild.ownerId;
}

/** True when the member can moderate others. */
function isModerator(member) {
  if (!member) return false;
  return (
    isStaff(member) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.KickMembers) ||
    member.permissions.has(PermissionFlagsBits.BanMembers)
  );
}

/**
 * Highest role the bot can manage, useful for explaining hierarchy in /help
 * and diagnostics.
 */
function hierarchyReport(guild) {
  const me = guild.members.me;
  if (!me) return null;
  const myTop = me.roles.highest;
  const above = guild.roles.cache.filter((r) => r.position > myTop.position && r.id !== guild.id).size;
  return {
    myHighestRole: myTop.name,
    myPosition: myTop.position,
    rolesAboveMe: above,
    canManageMost: above === 0,
  };
}

module.exports = {
  PERMISSION_NAMES,
  names,
  missing,
  has,
  checkTarget,
  checkRole,
  canGrantRole,
  canSpeak,
  canEmbed,
  isStaff,
  isModerator,
  hierarchyReport,
};
