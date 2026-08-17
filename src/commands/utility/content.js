'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const embeds = require('../../util/embeds');
const components = require('../../util/components');
const perms = require('../../util/perms');
const { paginate } = require('../../util/pager');
const { parseDuration, relative, fullTimestamp } = require('../../util/time');
const { truncate, number, progressBar, pct, closest, stripMentions } = require('../../util/text');

/**
 * Content commands: /poll, /say, /snipe, /tag.
 *
 * /poll is button-driven rather than reaction-driven so that votes can be
 * counted exactly, changed, and closed - none of which reactions support
 * without a paginated fetch of every reactor.
 *
 * /say is the one command here that can be abused, so it is gated on Manage
 * Messages, strips mentions, and records who sent what in the audit log.
 */

const POLL_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Stored poll state lives in the guild store, keyed by message id. */
function pollKey(guildId, messageId) {
  return `${guildId}.pollData.${messageId}`;
}

function renderPoll(bot, data) {
  const totalVotes = Object.values(data.votes).flat().length;
  const voters = new Set(Object.values(data.votes).flat()).size;

  const lines = data.options.map((option, index) => {
    const count = (data.votes[index] || []).length;
    const ratio = totalVotes ? count / totalVotes : 0;
    const bar = progressBar(ratio, 14);
    const share = totalVotes ? pct(count, totalVotes) : '0%';
    return `${POLL_EMOJI[index]} **${option}**\n\`${bar}\` ${count} · ${share}`;
  });

  const embed = embeds
    .base(
      data.closed ? `Poll closed — ${data.question}` : `Poll — ${data.question}`,
      lines.join('\n'),
      data.closed ? embeds.theme.neutral : embeds.theme.primary,
    )
    .setFooter({
      text: `${voters} voter(s) · ${data.multi ? 'multiple choice' : 'single choice'} · started by ${data.hostTag}`,
    });

  if (!data.closed && data.endsAt) {
    embed.addFields({ name: 'Closes', value: `${relative(data.endsAt)}` });
  }
  if (data.closed) {
    const best = data.options
      .map((option, index) => ({ option, count: (data.votes[index] || []).length }))
      .sort((a, b) => b.count - a.count);
    const winners = best.filter((b) => b.count === best[0].count && b.count > 0);
    embed.addFields({
      name: 'Result',
      value: winners.length
        ? winners.length > 1
          ? `Tied: ${winners.map((w) => `**${w.option}**`).join(', ')}`
          : `**${winners[0].option}** with ${winners[0].count} vote(s)`
        : 'Nobody voted.',
    });
  }
  void bot;
  return embed;
}

function pollRows(messageId, data) {
  if (data.closed) return [];
  const buttons = data.options.map((option, index) => ({
    id: components.customId('poll', 'vote', messageId, String(index)),
    label: truncate(option, 40),
    emoji: POLL_EMOJI[index],
    style: 'Secondary',
  }));
  buttons.push({ id: components.customId('poll', 'end', messageId), label: 'Close poll', emoji: '🔒', style: 'Danger' });
  return components.rows(buttons);
}

const poll = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Start a poll with buttons and live results')
    .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true))
    .addStringOption((o) =>
      o.setName('options').setDescription('Options separated by | — leave empty for Yes/No'),
    )
    .addStringOption((o) => o.setName('duration').setDescription('Auto-close after, e.g. 1h or 2d'))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Allow voting for more than one option')),
  category: 'utility',
  cooldown: 10,
  botPerms: [PermissionFlagsBits.EmbedLinks],
  examples: ['/poll question:Pizza tonight?', '/poll question:Which day? options:Mon|Tue|Wed duration:1d'],

  setup(bot) {
    bot.components.register('poll', async (interaction, parts) => {
      const [action, messageId, indexRaw] = parts;
      const key = pollKey(interaction.guildId, messageId);
      const data = bot.db.stores.guilds.get(key, null);

      if (!data) {
        return interaction.reply({ content: 'This poll is no longer tracked.', flags: MessageFlags.Ephemeral });
      }
      if (data.closed) {
        return interaction.reply({ content: 'This poll is closed.', flags: MessageFlags.Ephemeral });
      }

      if (action === 'end') {
        const isHost = interaction.user.id === data.hostId;
        if (!isHost && !perms.isStaff(interaction.member)) {
          return interaction.reply({
            content: 'Only the poll creator or a server manager can close it.',
            flags: MessageFlags.Ephemeral,
          });
        }
        data.closed = true;
        bot.db.stores.guilds.set(key, data);
        bot.db.settingsCache.delete(interaction.guildId);
        bot.scheduler.cancelWhere((t) => t.type === 'poll_end' && t.data.messageId === messageId);
        return interaction.update({ embeds: [renderPoll(bot, data)], components: [] });
      }

      if (action !== 'vote') return null;

      const index = Number(indexRaw);
      const userId = interaction.user.id;

      // Single-choice polls move the vote; multi-choice toggles it.
      if (!data.multi) {
        for (const key2 of Object.keys(data.votes)) {
          data.votes[key2] = data.votes[key2].filter((id) => id !== userId);
        }
      }
      data.votes[index] ??= [];
      const at = data.votes[index].indexOf(userId);
      let note;
      if (at === -1) {
        data.votes[index].push(userId);
        note = `Voted for **${data.options[index]}**.`;
      } else {
        data.votes[index].splice(at, 1);
        note = 'Vote withdrawn.';
      }

      bot.db.stores.guilds.set(key, data);
      bot.db.settingsCache.delete(interaction.guildId);

      await interaction.update({ embeds: [renderPoll(bot, data)], components: pollRows(messageId, data) });
      return interaction.followUp({ content: note, flags: MessageFlags.Ephemeral });
    });

    bot.scheduler.register('poll_end', async (task) => {
      const guild = bot.client.guilds.cache.get(task.guildId);
      if (!guild) return;
      const key = pollKey(task.guildId, task.data.messageId);
      const data = bot.db.stores.guilds.get(key, null);
      if (!data || data.closed) return;

      data.closed = true;
      bot.db.stores.guilds.set(key, data);
      bot.db.settingsCache.delete(task.guildId);

      const channel = await bot.resolveChannel(guild, data.channelId);
      const message = channel ? await channel.messages.fetch(task.data.messageId).catch(() => null) : null;
      await message?.edit({ embeds: [renderPoll(bot, data)], components: [] }).catch(() => {});
    });
  },

  async execute(ctx) {
    const question = ctx.str('question');
    const raw = ctx.str('options');
    const multi = ctx.bool('multiple');

    const options = raw
      ? raw.split('|').map((s) => s.trim()).filter(Boolean)
      : ['Yes', 'No'];

    if (options.length < 2) return ctx.fail('A poll needs at least 2 options, separated by `|`.');
    if (options.length > 10) return ctx.fail('At most 10 options are supported.');
    if (options.some((o) => o.length > 80)) return ctx.fail('Each option must be under 80 characters.');

    let endsAt = null;
    const durationRaw = ctx.str('duration');
    if (durationRaw) {
      const ms = parseDuration(durationRaw);
      if (ms === null) return ctx.tfail('err.badDuration');
      if (ms > 30 * 86_400_000) return ctx.fail('A poll can run for at most 30 days.');
      endsAt = Date.now() + ms;
    }

    const data = {
      question: truncate(question, 240),
      options,
      votes: {},
      multi,
      closed: false,
      hostId: ctx.user.id,
      hostTag: ctx.user.tag,
      channelId: ctx.i.channelId,
      endsAt,
      createdAt: Date.now(),
    };

    await ctx.send({ embeds: [renderPoll(ctx.bot, data)], components: pollRows('pending', data) });
    const message = await ctx.i.fetchReply();

    ctx.db.stores.guilds.set(pollKey(ctx.i.guildId, message.id), data);
    ctx.db.settingsCache.delete(ctx.i.guildId);
    await ctx.i.editReply({ components: pollRows(message.id, data) });

    if (endsAt) {
      ctx.bot.scheduler.schedule('poll_end', endsAt, { messageId: message.id }, { guildId: ctx.i.guildId });
    }
  },
};

const say = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message as the bot')
    .addStringOption((o) => o.setName('message').setDescription('What to send').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Where to send it, defaults to here'))
    .addBooleanOption((o) => o.setName('embed').setDescription('Send it inside an embed'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: 'utility',
  cooldown: 5,
  userPerms: [PermissionFlagsBits.ManageMessages],

  async execute(ctx) {
    const body = ctx.str('message');
    const channel = ctx.channelOpt('channel', true);
    const asEmbed = ctx.bool('embed');

    if (!channel.isTextBased()) return ctx.fail('That channel cannot receive messages.');
    if (!perms.canSpeak(channel)) return ctx.fail(`I cannot post in ${channel}.`);

    // Mentions are stripped rather than merely disallowed, so the message text
    // itself cannot be quoted elsewhere to ping the server.
    const safe = stripMentions(body).replace(/\\n/g, '\n');

    const payload = asEmbed
      ? { embeds: [embeds.base(null, truncate(safe, 4000))] }
      : { content: truncate(safe, 2000) };
    payload.allowedMentions = { parse: [] };

    await channel.send(payload);

    // The audit trail matters: an anonymous bot message is a moderation problem
    // waiting to happen, so who sent it is always recorded.
    await ctx.bot.features.logging?.post(
      ctx.guild,
      'commandUse',
      embeds
        .base('/say used', truncate(safe, 1500), embeds.theme.warning)
        .addFields(
          { name: 'By', value: `<@${ctx.user.id}> (\`${ctx.user.id}\`)`, inline: true },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
        ),
    );

    return ctx.ok('Sent', `Message posted in ${channel}.`, { ephemeral: true });
  },
};

const snipe = {
  data: new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Show a recently deleted or edited message in this channel')
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Deleted or edited')
        .addChoices({ name: 'deleted', value: 'delete' }, { name: 'edited', value: 'edit' }),
    )
    .addIntegerOption((o) =>
      o.setName('index').setDescription('How far back, 1 is the most recent').setMinValue(1).setMaxValue(5),
    )
    .addBooleanOption((o) => o.setName('forget').setDescription('Delete your own captured messages instead')),
  category: 'utility',
  cooldown: 5,

  async execute(ctx) {
    const feature = ctx.bot.features.snipe;

    if (ctx.bool('forget')) {
      const removed = feature.forget(ctx.user.id);
      return ctx.ok('Forgotten', `Removed ${number(removed)} captured message(s) of yours.`, { ephemeral: true });
    }

    const kind = ctx.str('type', 'delete');
    const index = ctx.int('index', 1) - 1;

    const embed = feature.render(ctx.i.channelId, { kind, index });
    if (!embed) {
      const counts = feature.count(ctx.i.channelId);
      return ctx.fail(
        `Nothing stored at that position. This channel has ${counts.deleted} deleted and ${counts.edited} edited message(s) buffered.\n\n` +
          'Captures are kept in memory for 30 minutes only, and bot messages and age-restricted channels are never captured.',
      );
    }
    return ctx.send({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

const tag = {
  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Saved snippets of text for the whole server')
    .addSubcommand((s) =>
      s
        .setName('show')
        .setDescription('Show a tag')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Create a tag')
        .addStringOption((o) => o.setName('name').setDescription('Tag name, one word').setRequired(true))
        .addStringOption((o) => o.setName('content').setDescription('What the tag says').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Change a tag you own')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('content').setDescription('New content').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Delete a tag')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List every tag on this server'))
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Who made a tag and how often it is used')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true)),
    ),
  category: 'utility',
  cooldown: 3,
  examples: ['/tag show name:rules', '/tag create name:rules content:Be nice.'],

  async autocomplete(ctx) {
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = ctx.db
      .tags(ctx.i.guildId)
      .filter(([name]) => name.includes(focused))
      .slice(0, 25)
      .map(([name]) => ({ name, value: name }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const name = ctx.str('name')?.toLowerCase().trim();

    switch (ctx.sub) {
      case 'show': {
        const found = ctx.db.tag(ctx.i.guildId, name);
        if (!found) {
          const suggestion = closest(name, ctx.db.tags(ctx.i.guildId).map(([n]) => n));
          return ctx.fail(suggestion ? `No tag called \`${name}\`. Did you mean \`${suggestion}\`?` : `No tag called \`${name}\`.`);
        }
        found.uses = (found.uses || 0) + 1;
        ctx.db.setTag(ctx.i.guildId, name, found);
        return ctx.send({ content: truncate(found.content, 2000), allowedMentions: { parse: [] } });
      }

      case 'create': {
        if (!perms.isModerator(ctx.member) && !ctx.settings.tagsOpen) {
          // Tags are server-wide content, so creation is staff-only by default.
          return ctx.fail('Only moderators can create tags on this server.');
        }
        if (!/^[\w-]{1,32}$/.test(name)) {
          return ctx.fail('Tag names must be 1–32 characters, letters, numbers, dashes and underscores only.');
        }
        if (ctx.db.tag(ctx.i.guildId, name)) return ctx.fail(`A tag called \`${name}\` already exists.`);
        if (ctx.db.tags(ctx.i.guildId).length >= 200) return ctx.fail('This server has reached the 200 tag limit.');

        ctx.db.setTag(ctx.i.guildId, name, {
          content: truncate(ctx.str('content'), 1900),
          authorId: ctx.user.id,
          authorTag: ctx.user.tag,
          createdAt: Date.now(),
          uses: 0,
        });
        return ctx.ok('Tag created', `Show it with \`/tag show name:${name}\`.`);
      }

      case 'edit': {
        const found = ctx.db.tag(ctx.i.guildId, name);
        if (!found) return ctx.fail(`No tag called \`${name}\`.`);
        if (found.authorId !== ctx.user.id && !perms.isStaff(ctx.member)) {
          return ctx.fail('You can only edit tags you created.');
        }
        found.content = truncate(ctx.str('content'), 1900);
        found.editedAt = Date.now();
        ctx.db.setTag(ctx.i.guildId, name, found);
        return ctx.ok('Tag updated', `\`${name}\` now says something new.`);
      }

      case 'delete': {
        const found = ctx.db.tag(ctx.i.guildId, name);
        if (!found) return ctx.fail(`No tag called \`${name}\`.`);
        if (found.authorId !== ctx.user.id && !perms.isStaff(ctx.member)) {
          return ctx.fail('You can only delete tags you created.');
        }
        ctx.db.deleteTag(ctx.i.guildId, name);
        return ctx.ok('Tag deleted', `\`${name}\` is gone.`);
      }

      case 'list': {
        const all = ctx.db.tags(ctx.i.guildId).sort((a, b) => (b[1].uses || 0) - (a[1].uses || 0));
        if (!all.length) return ctx.whisper('This server has no tags yet.');

        const pages = paginate(all, 15, (slice, { page, total }) =>
          embeds
            .base(
              `Tags in ${ctx.guild.name}`,
              slice.map(([n, t]) => `\`${n}\` — ${number(t.uses || 0)} use(s)`).join('\n'),
            )
            .setFooter({ text: `Page ${page}/${total} · ${all.length} tag(s)` }),
        );
        return ctx.paginate(pages);
      }

      case 'info': {
        const found = ctx.db.tag(ctx.i.guildId, name);
        if (!found) return ctx.fail(`No tag called \`${name}\`.`);
        return ctx.send({
          embeds: [
            embeds
              .base(`Tag: ${name}`, truncate(found.content, 1000))
              .addFields(
                { name: 'Created by', value: found.authorTag || 'unknown', inline: true },
                { name: 'Uses', value: number(found.uses || 0), inline: true },
                { name: 'Created', value: found.createdAt ? fullTimestamp(found.createdAt) : 'unknown' },
              ),
          ],
          allowedMentions: { parse: [] },
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

module.exports = [poll, say, snipe, tag];
