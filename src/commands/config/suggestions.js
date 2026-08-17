'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const { paginate } = require('../../util/pager');
const { truncate, number } = require('../../util/text');
const { relative } = require('../../util/time');

/**
 * /suggest and /suggestion — the member-facing and staff-facing halves of the
 * suggestion board.
 *
 * They are separate commands on purpose. /suggest carries no permission
 * requirement so it appears for everyone, while /suggestion is gated on Manage
 * Server so Discord itself hides it from members rather than showing them a
 * command that always refuses.
 */

const suggest = {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit a suggestion for the server')
    .addStringOption((o) => o.setName('idea').setDescription('Your suggestion').setRequired(true)),
  category: 'social',
  feature: 'suggestions',
  cooldown: 60,

  async execute(ctx) {
    const idea = ctx.str('idea').trim();
    if (idea.length < 10) return ctx.fail('Give a bit more detail — at least 10 characters.');
    if (idea.length > 1500) return ctx.fail('Keep it under 1500 characters.');

    const result = await ctx.bot.features.suggestions.submit(ctx.i, idea);
    if (!result.ok) return ctx.fail(result.error);

    return ctx.ok(
      'Suggestion posted',
      `Suggestion **#${result.number}** is up for voting.\n[Jump to it](${result.message.url})`,
      { ephemeral: true },
    );
  },
};

const suggestion = {
  data: new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Manage submitted suggestions')
    .addSubcommand((s) =>
      s
        .setName('approve')
        .setDescription('Mark a suggestion approved')
        .addStringOption((o) => o.setName('message_id').setDescription('The suggestion message id').setRequired(true))
        .addStringOption((o) => o.setName('note').setDescription('A response shown on the suggestion')),
    )
    .addSubcommand((s) =>
      s
        .setName('deny')
        .setDescription('Mark a suggestion denied')
        .addStringOption((o) => o.setName('message_id').setDescription('The suggestion message id').setRequired(true))
        .addStringOption((o) => o.setName('note').setDescription('A reason shown on the suggestion')),
    )
    .addSubcommand((s) =>
      s
        .setName('implemented')
        .setDescription('Mark a suggestion as done')
        .addStringOption((o) => o.setName('message_id').setDescription('The suggestion message id').setRequired(true))
        .addStringOption((o) => o.setName('note').setDescription('Anything to add')),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Browse suggestions')
        .addStringOption((o) =>
          o
            .setName('status')
            .setDescription('Filter by status')
            .addChoices(
              { name: 'open', value: 'open' },
              { name: 'approved', value: 'approved' },
              { name: 'denied', value: 'denied' },
              { name: 'implemented', value: 'implemented' },
            ),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'config',
  feature: 'suggestions',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ManageGuild],

  async execute(ctx) {
    const feature = ctx.bot.features.suggestions;

    if (ctx.sub === 'list') {
      const list = feature.list(ctx.i.guildId, { status: ctx.str('status') });
      if (!list.length) return ctx.whisper('No suggestions match that filter.');

      const pages = paginate(list, 8, (slice, { page, total }) =>
        embeds
          .base(
            'Suggestions',
            slice
              .map(
                (s) =>
                  `**#${s.number}** \`${s.status}\` — 👍 ${s.up.length} 👎 ${s.down.length}\n` +
                  `${truncate(s.body, 120)}\n*by <@${s.authorId}>, ${relative(s.createdAt)} · \`${s.messageId}\`*`,
              )
              .join('\n\n'),
          )
          .setFooter({ text: `Page ${page}/${total} · ${number(list.length)} suggestion(s)` }),
      );
      return ctx.paginate(pages, { ephemeral: true });
    }

    const statusMap = { approve: 'approved', deny: 'denied', implemented: 'implemented' };
    const status = statusMap[ctx.sub];
    if (!status) return ctx.fail('Unknown subcommand.');

    const result = await feature.resolve(ctx.guild, ctx.str('message_id').trim(), status, {
      note: ctx.str('note'),
      staff: ctx.user,
    });
    if (!result.ok) return ctx.fail(result.error);

    return ctx.ok(
      `Suggestion #${result.data.number} ${status}`,
      `The author has been notified.${ctx.str('note') ? `\n\nYour note: ${truncate(ctx.str('note'), 500)}` : ''}`,
      { ephemeral: true },
    );
  },
};

module.exports = [suggest, suggestion];
