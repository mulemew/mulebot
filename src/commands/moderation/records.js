'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const perms = require('../../util/perms');
const { paginate } = require('../../util/pager');
const { fullTimestamp, relative } = require('../../util/time');
const { truncate, number } = require('../../util/text');

/**
 * The moderation record: /warn, /case, /note.
 *
 * Warnings and every other punishment share one case log, numbered per server.
 * That matters when a moderator asks "what has this member done before" - two
 * parallel histories (warnings here, bans there) means the answer is always
 * incomplete, which is how repeat offenders slip through.
 */

const warn = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member and record it')
    .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('What they did').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(ctx) {
    const user = ctx.userOpt('user');
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);

    const problem = perms.checkTarget(ctx.i, member, 'warn', {
      protectedRoles: ctx.settings.moderation.protectedRoles,
      t: ctx.t,
    });
    if (problem) return ctx.fail(problem);

    const reason = ctx.str('reason');
    const entry = await ctx.bot.features.moderation.record(ctx.guild, {
      type: 'warn',
      user,
      moderator: ctx.user,
      reason,
    });

    const total = ctx.bot.features.moderation.warnCount(ctx.i.guildId, user.id);

    // Thresholds run after the warning is recorded, so the count they see
    // includes this one.
    const escalation = await ctx.bot.features.moderation.runThresholds(ctx.guild, member, ctx.user);

    const embed = embeds
      .success('Member warned', `**${user.tag}** has been warned.`)
      .addFields(
        { name: 'Reason', value: reason },
        { name: 'Total warnings', value: number(total), inline: true },
        { name: 'Case', value: `#${entry.id}`, inline: true },
      );

    if (escalation) {
      embed.addFields({
        name: '⚠️ Threshold reached',
        value: `They were automatically **${escalation}** for reaching ${total} warnings.`,
      });
    }

    return ctx.send({ embeds: [embed] });
  },
};

const caseCmd = {
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('Browse the moderation record')
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription('Show one case')
        .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('history')
        .setDescription('Every case against a member')
        .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Filter by type')
            .addChoices(
              { name: 'warn', value: 'warn' },
              { name: 'timeout', value: 'timeout' },
              { name: 'kick', value: 'kick' },
              { name: 'ban', value: 'ban' },
              { name: 'note', value: 'note' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('recent')
        .setDescription('The most recent cases on this server')
        .addIntegerOption((o) => o.setName('limit').setDescription('How many, default 25').setMinValue(1).setMaxValue(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('reason')
        .setDescription('Change a case reason')
        .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('The corrected reason').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Remove a case from the record')
        .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('clear')
        .setDescription('Remove every case against a member')
        .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Only clear one type')
            .addChoices({ name: 'warn', value: 'warn' }, { name: 'note', value: 'note' }),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ModerateMembers],
  examples: ['/case history user:@member', '/case view id:12'],

  async execute(ctx) {
    const moderation = ctx.bot.features.moderation;

    switch (ctx.sub) {
      case 'view': {
        const entry = ctx.db.getCase(ctx.i.guildId, ctx.int('id'));
        if (!entry) return ctx.fail(`There is no case #${ctx.int('id')} on this server.`);
        return ctx.send({ embeds: [moderation.renderCase(entry)] });
      }

      case 'history': {
        const user = ctx.userOpt('user');
        const type = ctx.str('type');
        const list = ctx.db.casesFor(ctx.i.guildId, user.id, type).slice().reverse();

        if (!list.length) {
          return ctx.send({
            embeds: [
              embeds.success('Clean record', `**${user.tag}** has no ${type ? `${type} ` : ''}cases on record.`),
            ],
          });
        }

        const counts = {};
        for (const c of list) counts[c.type] = (counts[c.type] || 0) + 1;

        const pages = paginate(list, 6, (slice, { page, total }) => {
          const embed = embeds
            .base(
              `Record for ${user.tag}`,
              `${list.length} case(s) — ${Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(' · ')}`,
            )
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .setFooter({ text: `Page ${page}/${total}` });

          for (const entry of slice) {
            embed.addFields({
              name: `#${entry.id} · ${entry.type} · ${new Date(entry.at).toDateString()}`,
              value: truncate(
                `${entry.reason}\n*by ${entry.moderatorTag || 'unknown'} — ${relative(entry.at)}*`,
                1024,
              ),
            });
          }
          return embed;
        });

        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'recent': {
        const limit = ctx.int('limit', 25);
        const list = ctx.db.cases(ctx.i.guildId).slice(-limit).reverse();
        if (!list.length) return ctx.fail('No cases have been recorded on this server yet.');

        const pages = paginate(list, 10, (slice, { page, total }) =>
          embeds
            .base(
              `Recent cases in ${ctx.guild.name}`,
              slice
                .map(
                  (c) =>
                    `**#${c.id}** \`${c.type}\` <@${c.userId}> — ${truncate(c.reason, 60)}\n*by ${c.moderatorTag || 'automod'}, ${relative(c.at)}*`,
                )
                .join('\n\n'),
            )
            .setFooter({ text: `Page ${page}/${total} · ${list.length} shown` }),
        );
        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'reason': {
        const id = ctx.int('id');
        const updated = ctx.db.updateCase(ctx.i.guildId, id, {
          reason: truncate(ctx.str('reason'), 500),
          editedBy: ctx.user.tag,
          editedAt: Date.now(),
        });
        if (!updated) return ctx.fail(`There is no case #${id}.`);
        return ctx.ok('Case updated', `Case #${id} now reads: ${updated.reason}`);
      }

      case 'delete': {
        // Deleting history is itself a moderation action, so it is restricted
        // above the normal moderator level and logged.
        if (!perms.isStaff(ctx.member)) {
          return ctx.fail('Deleting a case requires the Manage Server permission.');
        }
        const id = ctx.int('id');
        const entry = ctx.db.getCase(ctx.i.guildId, id);
        if (!entry) return ctx.fail(`There is no case #${id}.`);

        ctx.db.deleteCase(ctx.i.guildId, id);
        await ctx.bot.features.logging?.post(
          ctx.guild,
          'automod',
          embeds
            .base('Case deleted', `Case #${id} against <@${entry.userId}> was removed.`, embeds.theme.warning)
            .addFields(
              { name: 'Original reason', value: truncate(entry.reason, 500) },
              { name: 'Deleted by', value: `<@${ctx.user.id}>`, inline: true },
            ),
        );
        return ctx.ok('Case deleted', `Case #${id} has been removed from the record.`);
      }

      case 'clear': {
        if (!perms.isStaff(ctx.member)) {
          return ctx.fail('Clearing a record requires the Manage Server permission.');
        }
        const user = ctx.userOpt('user');
        const type = ctx.str('type');
        const removed = ctx.db.clearCases(ctx.i.guildId, user.id, type);
        if (!removed) return ctx.fail(`**${user.tag}** had no ${type ? `${type} ` : ''}cases to clear.`);
        return ctx.ok('Record cleared', `Removed **${removed}** case(s) against <@${user.id}>.`);
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const note = {
  data: new SlashCommandBuilder()
    .setName('note')
    .setDescription('Attach a private staff note to a member')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a note — the member is never told')
        .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('The note').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Show notes on a member')
        .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(ctx) {
    const user = ctx.userOpt('user');

    if (ctx.sub === 'add') {
      const entry = await ctx.bot.features.moderation.record(ctx.guild, {
        type: 'note',
        user,
        moderator: ctx.user,
        reason: ctx.str('text'),
        // A note is for staff only; DMing the member would defeat the point.
        notify: false,
      });
      return ctx.ok('Note added', `Note #${entry.id} on **${user.tag}**. They were not notified.`, {
        ephemeral: true,
      });
    }

    const list = ctx.db.casesFor(ctx.i.guildId, user.id, 'note');
    if (!list.length) return ctx.whisper(`No notes on **${user.tag}**.`);

    return ctx.whisper({
      embeds: [
        embeds
          .base(
            `Notes on ${user.tag}`,
            list
              .map((n) => `**#${n.id}** ${truncate(n.reason, 300)}\n*${n.moderatorTag} — ${fullTimestamp(n.at)}*`)
              .join('\n\n'),
          )
          .setFooter({ text: 'Visible to staff only' }),
      ],
    });
  },
};

module.exports = [warn, caseCmd, note];
