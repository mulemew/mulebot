'use strict';

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');

/**
 * Reaction roles, in both flavours.
 *
 * Classic reaction-based panels are supported because that is what most servers
 * already have, but new panels default to buttons: buttons cannot be triggered
 * by a member who cannot see the message, they work without the message content
 * intent, and they give immediate ephemeral feedback rather than silently
 * failing when the bot lacks permission to assign the role.
 *
 * Modes:
 *   normal   any number of roles
 *   unique   picking one removes the others in the panel
 *   verify   grants once, never removes
 */

function init(bot) {
  const log = bot.log.child('reactionroles');

  function emojiKey(emoji) {
    if (typeof emoji === 'string') return emoji;
    return emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
  }

  /** Shared guard: can the bot actually hand out this role? */
  function roleProblem(guild, roleId) {
    const role = guild.roles.cache.get(roleId);
    if (!role) return 'That role no longer exists.';
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I am missing the Manage Roles permission.';
    if (role.managed) return `**${role.name}** is managed by an integration and cannot be assigned.`;
    if (role.position >= me.roles.highest.position) {
      return `**${role.name}** is above my highest role, so I cannot assign it.`;
    }
    return null;
  }

  const api = {
    /** Stored panel for a message, or null. */
    panel(guildId, messageId) {
      return bot.db.settings(guildId).reactionRoles?.[messageId] || null;
    },

    /** Creates or replaces a panel. */
    savePanel(guildId, messageId, panel) {
      bot.db.setSetting(guildId, `reactionRoles.${messageId}`, panel);
      return panel;
    },

    deletePanel(guildId, messageId) {
      return bot.db.resetSetting(guildId, `reactionRoles.${messageId}`);
    },

    /** Every panel in a guild as [messageId, panel] pairs. */
    panels(guildId) {
      return Object.entries(bot.db.settings(guildId).reactionRoles || {});
    },

    /** Builds the button rows for a panel. */
    buildButtons(messageId, panel) {
      return components.rows(
        panel.pairs.map((pair, index) => ({
          id: components.customId('rr', 'toggle', messageId, String(index)),
          label: pair.label || undefined,
          emoji: pair.emoji || undefined,
          style: pair.style || 'Secondary',
        })),
      );
    },

    /** Builds the panel embed. */
    buildEmbed(guild, panel) {
      const lines = panel.pairs.map((pair) => {
        const role = guild.roles.cache.get(pair.roleId);
        return `${pair.emoji || '•'} ${role ? `<@&${role.id}>` : '(deleted role)'}${pair.description ? ` — ${pair.description}` : ''}`;
      });
      const modeNote = {
        unique: 'Pick one. Choosing another swaps it.',
        verify: 'Click once to opt in. This cannot be undone here.',
        normal: 'Click to add or remove a role.',
      }[panel.mode || 'normal'];

      return embeds
        .base(panel.title || 'Roles', `${panel.description ? `${panel.description}\n\n` : ''}${lines.join('\n')}\n\n*${modeNote}*`)
        .setFooter({ text: `${panel.pairs.length} role(s)` });
    },

    /**
     * Reaction-based panel handling.
     * @param {import('discord.js').MessageReaction} reaction
     * @param {import('discord.js').User} user
     * @param {'add'|'remove'} kind
     */
    async onReaction(reaction, user, kind) {
      if (user.bot) return;
      if (reaction.partial) {
        const ok = await reaction.fetch().then(() => true).catch(() => false);
        if (!ok) return;
      }
      const message = reaction.message;
      if (!message.guild) return;

      const panel = api.panel(message.guild.id, message.id);
      if (!panel || panel.style === 'buttons') return;

      const key = emojiKey(reaction.emoji);
      const pair = panel.pairs.find((p) => p.emoji === key);
      if (!pair) return;

      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      const problem = roleProblem(message.guild, pair.roleId);
      if (problem) {
        log.debug(`reaction role skipped: ${problem}`);
        return;
      }

      if (kind === 'add') {
        if (panel.mode === 'unique') {
          for (const other of panel.pairs) {
            if (other.roleId !== pair.roleId && member.roles.cache.has(other.roleId)) {
              await member.roles.remove(other.roleId, 'Reaction role (unique mode)').catch(() => {});
            }
          }
        }
        await member.roles.add(pair.roleId, 'Reaction role').catch(() => {});
      } else if (panel.mode !== 'verify') {
        await member.roles.remove(pair.roleId, 'Reaction role removed').catch(() => {});
      }
    },

    /** Button-based panel handling, routed from the component router. */
    async onButton(interaction, parts) {
      const [action, messageId, indexRaw] = parts;
      if (action !== 'toggle') return;

      const panel = api.panel(interaction.guildId, messageId);
      if (!panel) {
        return interaction.reply({
          content: 'This role panel no longer exists. Ask an admin to recreate it.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const pair = panel.pairs[Number(indexRaw)];
      if (!pair) {
        return interaction.reply({ content: 'That button is no longer mapped to a role.', flags: MessageFlags.Ephemeral });
      }

      const problem = roleProblem(interaction.guild, pair.roleId);
      if (problem) return interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });

      const member = interaction.member;
      const role = interaction.guild.roles.cache.get(pair.roleId);
      const has = member.roles.cache.has(pair.roleId);

      try {
        if (has) {
          if (panel.mode === 'verify') {
            return interaction.reply({ content: `You already have **${role.name}**.`, flags: MessageFlags.Ephemeral });
          }
          await member.roles.remove(role, 'Reaction role button');
          return interaction.reply({ content: `Removed **${role.name}**.`, flags: MessageFlags.Ephemeral });
        }

        if (panel.mode === 'unique') {
          const others = panel.pairs.filter((p) => p.roleId !== pair.roleId && member.roles.cache.has(p.roleId));
          for (const other of others) await member.roles.remove(other.roleId, 'Reaction role (unique)').catch(() => {});
        }

        await member.roles.add(role, 'Reaction role button');
        return interaction.reply({ content: `Added **${role.name}**.`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        log.warn(`role toggle failed: ${e.message}`);
        return interaction.reply({
          content: 'Discord refused that role change. My role may have been moved below it.',
          flags: MessageFlags.Ephemeral,
        });
      }
    },

    /** Drops panels whose message or roles have disappeared. */
    async prune(guild) {
      let removed = 0;
      for (const [messageId, panel] of api.panels(guild.id)) {
        const channel = guild.channels.cache.get(panel.channelId);
        const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
        if (!message) {
          api.deletePanel(guild.id, messageId);
          removed++;
        }
      }
      return removed;
    },
  };

  bot.components.register('rr', (interaction, parts) => api.onButton(interaction, parts));

  return api;
}

module.exports = { name: 'reactionroles', init };
