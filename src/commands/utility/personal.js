'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const { paginate } = require('../../util/pager');
const { parseDuration, formatDuration, fullTimestamp, relative, shortDate, nextBirthday } = require('../../util/time');
const { truncate, number } = require('../../util/text');

/**
 * Personal commands: /remind, /afk, /todo, /birthday.
 *
 * Everything here is per-member state that survives restarts. Reminders in
 * particular go through the persistent scheduler rather than setTimeout, which
 * is the difference between "set a reminder for next Tuesday" working and
 * silently evaporating on the next deploy.
 */

const remind = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set, list and cancel reminders')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set a reminder')
        .addStringOption((o) => o.setName('when').setDescription('Delay, e.g. 30s / 10m / 2h / 3d / 1w').setRequired(true))
        .addStringOption((o) => o.setName('what').setDescription('What to remind you about').setRequired(true))
        .addBooleanOption((o) => o.setName('repeat').setDescription('Repeat at the same interval until cancelled')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List your pending reminders'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Cancel a reminder')
        .addIntegerOption((o) => o.setName('id').setDescription('The id from /remind list').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('clear').setDescription('Cancel every reminder you have set')),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,
  examples: ['/remind set when:2h what:take the pizza out', '/remind list'],

  async execute(ctx) {
    const reminders = ctx.bot.features.reminders;

    switch (ctx.sub) {
      case 'set': {
        const ms = parseDuration(ctx.str('when'));
        if (ms === null) return ctx.tfail('err.badDuration');
        if (ms < 10_000) return ctx.fail('The shortest reminder is 10 seconds.');

        const repeat = ctx.bool('repeat');
        const result = reminders.create({
          userId: ctx.user.id,
          guildId: ctx.i.guildId,
          channelId: ctx.i.channelId,
          text: ctx.str('what'),
          at: Date.now() + ms,
          repeatMs: repeat ? ms : 0,
        });

        if (!result.ok) return ctx.fail(result.error);

        return ctx.ok(
          'Reminder set',
          [
            `I will ping you ${relative(result.task.runAt)} — ${fullTimestamp(result.task.runAt)}.`,
            repeat ? `Repeating every ${formatDuration(ms)}.` : null,
            '',
            `> ${truncate(ctx.str('what'), 500)}`,
            '',
            `Cancel it with \`/remind cancel id:${result.task.id}\`.`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      case 'list': {
        const list = reminders.forUser(ctx.user.id);
        if (!list.length) return ctx.whisper('You have no pending reminders.');

        const pages = paginate(list, 8, (slice, { page, total }) =>
          embeds
            .base(
              'Your reminders',
              slice
                .map(
                  (t) =>
                    `**#${t.id}** — ${relative(t.runAt)}${t.repeatMs ? ` (repeats every ${formatDuration(t.repeatMs)})` : ''}\n> ${truncate(t.data.text, 150)}`,
                )
                .join('\n\n'),
            )
            .setFooter({ text: `Page ${page}/${total} · ${list.length} pending` }),
        );
        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'cancel': {
        const id = ctx.int('id');
        if (!reminders.cancel(ctx.user.id, id)) {
          return ctx.fail(`You have no reminder with id **${id}**. Check \`/remind list\`.`);
        }
        return ctx.ok('Cancelled', `Reminder #${id} will not fire.`, { ephemeral: true });
      }

      case 'clear': {
        const removed = reminders.cancelAll(ctx.user.id);
        if (!removed) return ctx.whisper('You had no reminders to clear.');
        return ctx.ok('Cleared', `Cancelled ${number(removed)} reminder(s).`, { ephemeral: true });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const afk = {
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Mark yourself as away, so mentions get an automatic reply')
    .addStringOption((o) => o.setName('reason').setDescription('Where you are going, shown to anyone who pings you'))
    .addBooleanOption((o) => o.setName('nickname').setDescription('Also prefix your nickname with [AFK]')),
  category: 'utility',
  cooldown: 10,

  async execute(ctx) {
    const feature = ctx.bot.features.afk;
    const existing = feature.get(ctx.i.guildId, ctx.user.id);

    if (existing) {
      feature.clear(ctx.i.guildId, ctx.user.id);
      return ctx.ok('Welcome back', `You are no longer marked away. You were away ${relative(existing.since)}.`, {
        ephemeral: true,
      });
    }

    const reason = ctx.str('reason', 'Away');
    let previousNickname = null;

    if (ctx.bool('nickname')) {
      const me = ctx.guild.members.me;
      // Discord refuses a nickname change on the server owner regardless of
      // permissions, so this is best effort by design.
      if (me.permissions.has('ManageNicknames') && ctx.member.manageable) {
        previousNickname = ctx.member.nickname;
        const next = truncate(`[AFK] ${ctx.member.displayName}`, 32, '');
        await ctx.member.setNickname(next, 'AFK').catch(() => {
          previousNickname = null;
        });
      }
    }

    feature.set(ctx.i.guildId, ctx.user.id, reason, { nickname: previousNickname });

    return ctx.ok(
      'AFK set',
      `Anyone who mentions you will be told: *${truncate(reason, 200)}*\n\nYour next message here clears it automatically.`,
      { ephemeral: true },
    );
  },
};

const todo = {
  data: new SlashCommandBuilder()
    .setName('todo')
    .setDescription('A private to-do list')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add an item')
        .addStringOption((o) => o.setName('item').setDescription('What needs doing').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show your list'))
    .addSubcommand((s) =>
      s
        .setName('done')
        .setDescription('Tick an item off')
        .addIntegerOption((o) => o.setName('number').setDescription('Item number from /todo list').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete an item outright')
        .addIntegerOption((o) => o.setName('number').setDescription('Item number from /todo list').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('clear').setDescription('Delete every item')),
  category: 'utility',
  cooldown: 2,

  async execute(ctx) {
    const record = ctx.record();
    record.todo ??= [];

    switch (ctx.sub) {
      case 'add': {
        if (record.todo.length >= 50) return ctx.fail('Your list is full at 50 items. Clear a few first.');
        record.todo.push({ text: truncate(ctx.str('item'), 200), at: Date.now(), done: false });
        ctx.save();
        return ctx.ok('Added', `**${record.todo.length}.** ${truncate(ctx.str('item'), 200)}`, { ephemeral: true });
      }

      case 'list': {
        if (!record.todo.length) return ctx.whisper('Your to-do list is empty. Add something with `/todo add`.');
        const open = record.todo.filter((t) => !t.done).length;
        const body = record.todo
          .map((t, i) => `${t.done ? '~~' : ''}**${i + 1}.** ${t.text}${t.done ? '~~ ✅' : ''}`)
          .join('\n');
        return ctx.whisper({
          embeds: [
            embeds
              .base('Your to-do list', truncate(body, 4000))
              .setFooter({ text: `${open} open · ${record.todo.length - open} done` }),
          ],
        });
      }

      case 'done': {
        const index = ctx.int('number') - 1;
        if (!record.todo[index]) return ctx.fail('There is no item with that number.');
        record.todo[index].done = !record.todo[index].done;
        ctx.save();
        return ctx.ok(
          record.todo[index].done ? 'Done' : 'Reopened',
          record.todo[index].text,
          { ephemeral: true },
        );
      }

      case 'remove': {
        const index = ctx.int('number') - 1;
        if (!record.todo[index]) return ctx.fail('There is no item with that number.');
        const [removed] = record.todo.splice(index, 1);
        ctx.save();
        return ctx.ok('Removed', removed.text, { ephemeral: true });
      }

      case 'clear': {
        const count = record.todo.length;
        record.todo = [];
        ctx.save();
        return ctx.ok('Cleared', `Removed ${number(count)} item(s).`, { ephemeral: true });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const birthday = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Set your birthday so the server can celebrate it')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set your birthday')
        .addStringOption((o) =>
          o.setName('date').setDescription('MM-DD, or YYYY-MM-DD to include your age').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('clear').setDescription('Remove your birthday'))
    .addSubcommand((s) =>
      s
        .setName('upcoming')
        .setDescription('Show birthdays coming up')
        .addIntegerOption((o) => o.setName('days').setDescription('How far ahead to look, default 30').setMinValue(1).setMaxValue(365)),
    ),
  category: 'utility',
  cooldown: 5,

  async execute(ctx) {
    const reminders = ctx.bot.features.reminders;

    switch (ctx.sub) {
      case 'set': {
        const result = reminders.setBirthday(ctx.i.guildId, ctx.user.id, ctx.str('date'));
        if (!result.ok) return ctx.fail(result.error);

        return ctx.ok(
          'Birthday saved',
          [
            `${shortDate(result.next)} — ${relative(result.next)}.`,
            result.birthday.year ? `Your age will be shown on the day.` : 'No year given, so no age will be shown.',
            '',
            'The announcement goes to the welcome channel, if one is configured.',
          ].join('\n'),
          { ephemeral: true },
        );
      }

      case 'clear': {
        reminders.clearBirthday(ctx.i.guildId, ctx.user.id);
        return ctx.ok('Removed', 'Your birthday is no longer stored.', { ephemeral: true });
      }

      case 'upcoming': {
        const days = ctx.int('days', 30);
        const list = reminders.upcoming(ctx.i.guildId, days);
        if (!list.length) return ctx.whisper(`No birthdays in the next ${days} days.`);

        const body = list
          .slice(0, 25)
          .map((e) => `<@${e.userId}> — ${shortDate(e.at)} (${relative(e.at)})`)
          .join('\n');

        return ctx.send({
          embeds: [
            embeds
              .base(`Birthdays in the next ${days} days`, body)
              .setFooter({ text: `${list.length} total` }),
          ],
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

void nextBirthday;
module.exports = [remind, afk, todo, birthday];
