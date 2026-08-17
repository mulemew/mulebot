'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const embeds = require('../../util/embeds');
const componentsUtil = require('../../util/components');
const perms = require('../../util/perms');
const { paginate } = require('../../util/pager');
const { parseDuration, formatDuration, relative, fullTimestamp } = require('../../util/time');
const { truncate, number, humanList } = require('../../util/text');

/**
 * Feature operation commands: /giveaway, /ticket, /reactionrole, /starboard,
 * /autoresponder.
 *
 * These are the day-to-day operations rather than the one-time configuration in
 * /config: starting a giveaway, posting a ticket panel, building a role menu.
 */

const giveaway = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run a giveaway')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('How long it runs, e.g. 1h, 3d').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many winners, default 1').setMinValue(1).setMaxValue(20))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('description').setDescription('Extra details'))
        .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role may enter'))
        .addIntegerOption((o) => o.setName('min_level').setDescription('Minimum level to enter').setMinValue(1))
        .addIntegerOption((o) => o.setName('min_account_days').setDescription('Minimum account age in days').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('End a giveaway now and draw the winners')
        .addStringOption((o) => o.setName('message_id').setDescription('The giveaway message id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Draw new winners for a finished giveaway')
        .addStringOption((o) => o.setName('message_id').setDescription('The giveaway message id').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many to redraw').setMinValue(1).setMaxValue(20)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show running giveaways'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'config',
  feature: 'giveaways',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageGuild],
  examples: ['/giveaway start prize:Nitro duration:1d winners:2'],

  async execute(ctx) {
    const giveaways = ctx.bot.features.giveaways;

    switch (ctx.sub) {
      case 'start': {
        const durationMs = parseDuration(ctx.str('duration'));
        if (durationMs === null) return ctx.tfail('err.badDuration');
        if (durationMs < 30_000) return ctx.fail('A giveaway must run for at least 30 seconds.');
        if (durationMs > 60 * 86_400_000) return ctx.fail('A giveaway can run for at most 60 days.');

        const channel = ctx.channelOpt('channel') || ctx.channel;
        if (!perms.canEmbed(channel)) return ctx.fail(`I need View Channel, Send Messages and Embed Links in ${channel}.`);

        await ctx.defer({ ephemeral: true });

        const { message } = await giveaways.start(ctx.i, {
          prize: truncate(ctx.str('prize'), 200),
          description: ctx.str('description'),
          durationMs,
          winners: ctx.int('winners', 1),
          channel,
          requiredRoleId: ctx.roleOpt('required_role')?.id,
          minLevel: ctx.int('min_level', 0),
          minAccountDays: ctx.int('min_account_days', 0),
        });

        return ctx.send({
          embeds: [
            embeds.success(
              'Giveaway started',
              [
                `[Jump to the giveaway](${message.url})`,
                `Ends ${relative(Date.now() + durationMs)}.`,
                '',
                `End it early with \`/giveaway end message_id:${message.id}\`.`,
              ].join('\n'),
            ),
          ],
        });
      }

      case 'end': {
        const id = ctx.str('message_id').trim();
        const existing = giveaways.get(id);
        if (!existing) return ctx.fail('No giveaway with that message id. Right-click the message → Copy Message ID.');
        if (existing.guildId !== ctx.i.guildId) return ctx.fail('That giveaway belongs to another server.');
        if (existing.ended) return ctx.fail('That giveaway has already ended. Use `/giveaway reroll` instead.');

        await ctx.defer({ ephemeral: true });
        const result = await giveaways.endEarly(id);
        return ctx.ok(
          'Giveaway ended',
          result?.winners.length
            ? `Winners: ${result.winners.map((w) => `<@${w}>`).join(', ')} from ${result.entries} entries.`
            : 'Nobody entered, so there is no winner.',
        );
      }

      case 'reroll': {
        const id = ctx.str('message_id').trim();
        await ctx.defer({ ephemeral: true });
        const result = await giveaways.reroll(id, ctx.int('winners', 1));
        if (!result) return ctx.fail('No giveaway with that message id.');
        if (result.error) return ctx.fail(result.error);
        return ctx.ok(
          'Rerolled',
          result.winners.length ? `New winners: ${result.winners.map((w) => `<@${w}>`).join(', ')}` : 'No eligible entrants remain.',
        );
      }

      case 'list': {
        const list = giveaways.forGuild(ctx.i.guildId);
        if (!list.length) return ctx.whisper('No giveaways are running.');

        return ctx.whisper({
          embeds: [
            embeds.base(
              'Running giveaways',
              list
                .map(
                  (g) =>
                    `**${truncate(g.prize, 60)}** in <#${g.channelId}>\n` +
                    `${g.entries.length} entries · ${g.winnerCount} winner(s) · ends ${relative(g.endsAt)}\n` +
                    `\`${g.messageId}\``,
                )
                .join('\n\n'),
            ),
          ],
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const ticket = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Support ticket operations')
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Post the panel members click to open a ticket')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('title').setDescription('Panel heading'))
        .addStringOption((o) => o.setName('description').setDescription('Panel text')),
    )
    .addSubcommand((s) => s.setName('close').setDescription('Close the ticket you are in'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add someone to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Who to add').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove someone from this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Who to remove').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List open tickets')),
  category: 'config',
  feature: 'tickets',
  cooldown: 5,

  async execute(ctx) {
    const tickets = ctx.bot.features.tickets;

    switch (ctx.sub) {
      case 'panel': {
        if (!perms.isStaff(ctx.member)) return ctx.fail('Posting a panel requires the Manage Server permission.');
        if (!ctx.settings.tickets.enabled) {
          return ctx.fail('Tickets are off. Run `/config tickets toggle enabled:true` and `/config tickets setup` first.');
        }

        const channel = ctx.channelOpt('channel') || ctx.channel;
        if (!perms.canEmbed(channel)) return ctx.fail(`I cannot post an embed in ${channel}.`);

        await channel.send(
          tickets.buildPanel(ctx.guild, { title: ctx.str('title'), description: ctx.str('description') }),
        );
        return ctx.ok('Panel posted', `Members can open tickets from ${channel}.`, { ephemeral: true });
      }

      case 'close': {
        const record = tickets.ticketFor(ctx.i.guildId, ctx.i.channelId);
        if (!record) return ctx.fail('This is not a ticket channel.');
        return tickets.close(ctx.i, ctx.i.channelId);
      }

      case 'add':
      case 'remove': {
        const record = tickets.ticketFor(ctx.i.guildId, ctx.i.channelId);
        if (!record) return ctx.fail('This is not a ticket channel.');

        const isStaff =
          perms.isStaff(ctx.member) ||
          (ctx.settings.tickets.supportRoleIds || []).some((r) => ctx.member.roles.cache.has(r));
        if (!isStaff && record.userId !== ctx.user.id) {
          return ctx.fail('Only the ticket opener or support staff can change who is in a ticket.');
        }

        const user = ctx.userOpt('user');
        const ok = await tickets.setAccess(ctx.channel, user, ctx.sub === 'add' ? true : null);
        if (!ok) return ctx.fail('I could not change the channel permissions.');

        return ctx.ok(
          ctx.sub === 'add' ? 'Added' : 'Removed',
          `<@${user.id}> ${ctx.sub === 'add' ? 'can now see this ticket' : 'no longer has access'}.`,
        );
      }

      case 'list': {
        if (!perms.isStaff(ctx.member)) return ctx.fail('Listing tickets requires the Manage Server permission.');
        const open = tickets.open(ctx.i.guildId);
        const entries = Object.entries(open);
        if (!entries.length) return ctx.whisper('No tickets are open.');

        return ctx.whisper({
          embeds: [
            embeds.base(
              `Open tickets (${entries.length})`,
              entries
                .map(
                  ([channelId, t]) =>
                    `<#${channelId}> — #${String(t.number).padStart(4, '0')} by <@${t.userId}>, opened ${relative(t.openedAt)}` +
                    (t.claimedBy ? `\n   claimed by <@${t.claimedBy}>` : ''),
                )
                .join('\n'),
            ),
          ],
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const reactionrole = {
  data: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Self-assignable role panels')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Create a role panel')
        .addStringOption((o) => o.setName('title').setDescription('Panel heading').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('How roles behave')
            .addChoices(
              { name: 'normal — any number of roles', value: 'normal' },
              { name: 'unique — one role at a time', value: 'unique' },
              { name: 'verify — grant once, never remove', value: 'verify' },
            ),
        )
        .addStringOption((o) => o.setName('description').setDescription('Text above the roles'))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a role to a panel')
        .addStringOption((o) => o.setName('message_id').setDescription('The panel message id').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Button label'))
        .addStringOption((o) => o.setName('emoji').setDescription('Button emoji'))
        .addStringOption((o) => o.setName('description').setDescription('One-line explanation')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a role from a panel')
        .addStringOption((o) => o.setName('message_id').setDescription('The panel message id').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List the panels on this server'))
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Stop tracking a panel')
        .addStringOption((o) => o.setName('message_id').setDescription('The panel message id').setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  category: 'config',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageRoles],
  botPerms: [PermissionFlagsBits.ManageRoles],

  async execute(ctx) {
    const feature = ctx.bot.features.reactionroles;

    switch (ctx.sub) {
      case 'create': {
        const channel = ctx.channelOpt('channel') || ctx.channel;
        if (!perms.canEmbed(channel)) return ctx.fail(`I cannot post an embed in ${channel}.`);

        const panel = {
          title: truncate(ctx.str('title'), 200),
          description: ctx.str('description') || null,
          mode: ctx.str('mode', 'normal'),
          style: 'buttons',
          channelId: channel.id,
          pairs: [],
        };

        const message = await channel.send({
          embeds: [feature.buildEmbed(ctx.guild, panel)],
          components: [],
        });
        feature.savePanel(ctx.i.guildId, message.id, panel);

        return ctx.ok(
          'Panel created',
          [
            `[Jump to the panel](${message.url})`,
            '',
            `Add roles with:\n\`/reactionrole add message_id:${message.id} role:@Role\``,
          ].join('\n'),
          { ephemeral: true },
        );
      }

      case 'add': {
        const messageId = ctx.str('message_id').trim();
        const panel = feature.panel(ctx.i.guildId, messageId);
        if (!panel) return ctx.fail('No panel with that message id. Create one with `/reactionrole create`.');

        const role = ctx.roleOpt('role');
        const problem = perms.checkRole(ctx.guild, role);
        if (problem) return ctx.fail(problem);
        if (!perms.canGrantRole(ctx.member, role)) {
          return ctx.fail('That role is at or above your highest role, so you cannot put it on a panel.');
        }
        if (panel.pairs.some((p) => p.roleId === role.id)) return ctx.fail('That role is already on the panel.');
        if (panel.pairs.length >= 25) return ctx.fail('A panel holds at most 25 roles.');

        panel.pairs.push({
          roleId: role.id,
          label: ctx.str('label') || role.name,
          emoji: ctx.str('emoji') || null,
          description: ctx.str('description') || null,
        });
        feature.savePanel(ctx.i.guildId, messageId, panel);

        const channel = ctx.guild.channels.cache.get(panel.channelId);
        const message = await channel?.messages.fetch(messageId).catch(() => null);
        if (!message) return ctx.fail('The panel message was deleted. Create a new panel.');

        await message.edit({
          embeds: [feature.buildEmbed(ctx.guild, panel)],
          components: feature.buildButtons(messageId, panel),
        });

        return ctx.ok('Role added', `<@&${role.id}> is on the panel (${panel.pairs.length} role(s)).`, { ephemeral: true });
      }

      case 'remove': {
        const messageId = ctx.str('message_id').trim();
        const panel = feature.panel(ctx.i.guildId, messageId);
        if (!panel) return ctx.fail('No panel with that message id.');

        const role = ctx.roleOpt('role');
        const before = panel.pairs.length;
        panel.pairs = panel.pairs.filter((p) => p.roleId !== role.id);
        if (panel.pairs.length === before) return ctx.fail('That role is not on the panel.');

        feature.savePanel(ctx.i.guildId, messageId, panel);

        const channel = ctx.guild.channels.cache.get(panel.channelId);
        const message = await channel?.messages.fetch(messageId).catch(() => null);
        await message?.edit({
          embeds: [feature.buildEmbed(ctx.guild, panel)],
          components: panel.pairs.length ? feature.buildButtons(messageId, panel) : [],
        });

        return ctx.ok('Role removed', `<@&${role.id}> is off the panel.`, { ephemeral: true });
      }

      case 'list': {
        const panels = feature.panels(ctx.i.guildId);
        if (!panels.length) return ctx.whisper('No role panels are configured.');

        return ctx.whisper({
          embeds: [
            embeds.base(
              'Role panels',
              panels
                .map(
                  ([messageId, panel]) =>
                    `**${truncate(panel.title || 'Roles', 50)}** in <#${panel.channelId}>\n` +
                    `${panel.pairs.length} role(s) · mode ${panel.mode} · \`${messageId}\``,
                )
                .join('\n\n'),
            ),
          ],
        });
      }

      case 'delete': {
        const messageId = ctx.str('message_id').trim();
        if (!feature.deletePanel(ctx.i.guildId, messageId)) return ctx.fail('No panel with that message id.');
        return ctx.ok(
          'Panel untracked',
          'The buttons will no longer do anything. Delete the message itself if you want it gone.',
          { ephemeral: true },
        );
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const starboard = {
  data: new SlashCommandBuilder()
    .setName('starboard')
    .setDescription('Starboard information')
    .addSubcommand((s) =>
      s
        .setName('top')
        .setDescription('The most starred messages on this server')
        .addIntegerOption((o) => o.setName('limit').setDescription('How many to show').setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((s) => s.setName('stats').setDescription('Starboard statistics')),
  category: 'config',
  feature: 'starboard',
  cooldown: 10,

  async execute(ctx) {
    const feature = ctx.bot.features.starboard;

    if (ctx.sub === 'top') {
      const top = feature.top(ctx.i.guildId, ctx.int('limit', 10));
      if (!top.length) return ctx.fail('Nothing has made it onto the starboard yet.');

      const emoji = ctx.settings.starboard.emoji;
      return ctx.send({
        embeds: [
          embeds.base(
            'Most starred messages',
            top
              .map(
                (entry, i) =>
                  `**${i + 1}.** ${emoji} ${entry.count} — [jump](https://discord.com/channels/${ctx.i.guildId}/${entry.channelId}/${entry.messageId}) · ${relative(entry.at)}`,
              )
              .join('\n'),
          ),
        ],
      });
    }

    const all = ctx.db.stores.starboard.get(ctx.i.guildId, {});
    const entries = Object.values(all);
    const total = entries.reduce((sum, e) => sum + e.count, 0);

    return ctx.send({
      embeds: [
        embeds
          .base(`Starboard — ${ctx.guild.name}`)
          .addFields(
            { name: 'Featured messages', value: number(entries.length), inline: true },
            { name: 'Total stars', value: number(total), inline: true },
            {
              name: 'Average',
              value: entries.length ? (total / entries.length).toFixed(1) : '0',
              inline: true,
            },
            {
              name: 'Configuration',
              value: ctx.settings.starboard.enabled
                ? `${ctx.settings.starboard.threshold}× ${ctx.settings.starboard.emoji} → <#${ctx.settings.starboard.channelId}>`
                : 'Disabled',
            },
          ),
      ],
    });
  },
};

const autoresponder = {
  data: new SlashCommandBuilder()
    .setName('autoresponder')
    .setDescription('Automatic replies to message triggers')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add an auto-response')
        .addStringOption((o) => o.setName('trigger').setDescription('What to look for').setRequired(true))
        .addStringOption((o) => o.setName('response').setDescription('What to reply').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('match')
            .setDescription('How to match')
            .addChoices(
              { name: 'contains', value: 'contains' },
              { name: 'exact message', value: 'exact' },
              { name: 'starts with', value: 'starts' },
              { name: 'ends with', value: 'ends' },
              { name: 'whole word', value: 'word' },
              { name: 'regular expression', value: 'regex' },
            ),
        )
        .addIntegerOption((o) => o.setName('chance').setDescription('Percent chance of firing').setMinValue(1).setMaxValue(100))
        .addBooleanOption((o) => o.setName('delete_trigger').setDescription('Delete the triggering message')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove an auto-response')
        .addStringOption((o) => o.setName('trigger').setDescription('The exact trigger').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List the auto-responses'))
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn auto-responses on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'config',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ManageGuild],

  async execute(ctx) {
    const feature = ctx.bot.features.autoresponder;

    switch (ctx.sub) {
      case 'add': {
        const result = feature.add(ctx.i.guildId, {
          trigger: ctx.str('trigger'),
          response: ctx.str('response'),
          match: ctx.str('match', 'contains'),
          chance: ctx.int('chance', 100) / 100,
          deleteTrigger: ctx.bool('delete_trigger'),
          createdBy: ctx.user.id,
        });
        if (!result.ok) return ctx.fail(result.error);

        const note = ctx.settings.autoresponder.enabled
          ? ''
          : '\n\n⚠️ Auto-responders are switched off. Run `/autoresponder toggle enabled:true`.';
        const intentNote = ctx.bot.intents.messageContent
          ? ''
          : '\n\n⚠️ The MESSAGE CONTENT intent is off, so I cannot read messages to match against.';

        return ctx.ok(
          'Auto-response added',
          `When a message ${ctx.str('match', 'contains')} \`${truncate(ctx.str('trigger'), 100)}\`, I will reply.${note}${intentNote}`,
        );
      }

      case 'remove': {
        if (!feature.remove(ctx.i.guildId, ctx.str('trigger'))) {
          return ctx.fail('No auto-response with that exact trigger. Check `/autoresponder list`.');
        }
        return ctx.ok('Removed', 'That auto-response is gone.');
      }

      case 'list': {
        const list = ctx.settings.autoresponder.entries;
        if (!list.length) return ctx.whisper('No auto-responses configured.');

        const pages = paginate(list, 6, (slice, { page, total }) => {
          const embed = embeds
            .base(
              `Auto-responses (${list.length})`,
              ctx.settings.autoresponder.enabled ? 'Currently active.' : '⚠️ Currently disabled.',
            )
            .setFooter({ text: `Page ${page}/${total}` });
          for (const entry of slice) {
            embed.addFields({
              name: `${entry.match} · ${truncate(entry.trigger, 60)}`,
              value: truncate(
                `${entry.response}\n*${Math.round((entry.chance ?? 1) * 100)}% chance · used ${number(entry.uses || 0)} time(s)*`,
                1024,
              ),
            });
          }
          return embed;
        });
        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'toggle': {
        const enabled = ctx.bool('enabled');
        ctx.setSetting('autoresponder.enabled', enabled);
        feature.invalidate(ctx.i.guildId);
        return ctx.ok(
          enabled ? 'Auto-responses on' : 'Auto-responses off',
          `${ctx.settings.autoresponder.entries.length} configured.`,
        );
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

void componentsUtil;
void formatDuration;
void fullTimestamp;
void humanList;
module.exports = [giveaway, ticket, reactionrole, starboard, autoresponder];
