'use strict';

const embeds = require('../util/embeds');
const { fullTimestamp, nextBirthday, parseBirthday } = require('../util/time');
const { truncate } = require('../util/text');

/**
 * Reminders and birthdays.
 *
 * Both are just scheduled tasks, which is the whole point: the previous version
 * of this bot used a bare setTimeout, so every restart silently dropped every
 * pending reminder and the user never found out. Persisting them means a
 * reminder set for next week survives a panel restart, a redeploy and a crash.
 *
 * Delivery falls back through three routes - channel message, DM, then giving
 * up quietly - because by the time a long reminder fires the original channel
 * may have been deleted or the member may have left.
 */

const MAX_PER_USER = 25;
const MAX_DELAY_MS = 365 * 86_400_000;

function init(bot) {
  const log = bot.log.child('reminders');

  const api = {
    MAX_PER_USER,
    MAX_DELAY_MS,

    /** Reminders belonging to a user, soonest first. */
    forUser(userId) {
      return bot.scheduler.find({ type: 'reminder', userId });
    },

    /**
     * Creates a reminder.
     * @returns {{ ok: boolean, task?: object, error?: string }}
     */
    create({ userId, guildId, channelId, text, at, repeatMs = 0 }) {
      if (at - Date.now() > MAX_DELAY_MS) {
        return { ok: false, error: 'Reminders can be set at most a year ahead.' };
      }
      if (api.forUser(userId).length >= MAX_PER_USER) {
        return { ok: false, error: `You already have ${MAX_PER_USER} reminders pending. Cancel one first.` };
      }

      const task = bot.scheduler.schedule(
        'reminder',
        at,
        { text: truncate(text, 1000), channelId, userId, guildId },
        { guildId, userId, repeatMs },
      );
      return { ok: true, task };
    },

    cancel(userId, id) {
      const task = bot.scheduler.find({ type: 'reminder', userId }).find((t) => t.id === Number(id));
      if (!task) return false;
      return bot.scheduler.cancel(task.id);
    },

    cancelAll(userId) {
      return bot.scheduler.cancelWhere((t) => t.type === 'reminder' && t.userId === userId);
    },

    /** Sets a birthday and schedules its first announcement. */
    setBirthday(guildId, userId, input) {
      const parsed = parseBirthday(input);
      if (!parsed) return { ok: false, error: 'Use the format `MM-DD` or `YYYY-MM-DD`, for example `03-17`.' };

      const record = bot.db.member(guildId, userId);
      record.birthday = parsed;
      bot.db.saveMember();

      // Cancel any previous schedule so changing the date does not leave two.
      bot.scheduler.cancelWhere((t) => t.type === 'birthday' && t.userId === userId && t.guildId === guildId);
      const at = nextBirthday(parsed);
      bot.scheduler.schedule('birthday', at, { userId, guildId }, { guildId, userId });

      return { ok: true, birthday: parsed, next: at };
    },

    clearBirthday(guildId, userId) {
      const record = bot.db.member(guildId, userId);
      record.birthday = null;
      bot.db.saveMember();
      return bot.scheduler.cancelWhere((t) => t.type === 'birthday' && t.userId === userId && t.guildId === guildId);
    },

    /** Everyone with a birthday in the next `days` days. */
    upcoming(guildId, days = 30) {
      const now = Date.now();
      const horizon = now + days * 86_400_000;
      return bot.db
        .members(guildId)
        .filter(([, r]) => r.birthday)
        .map(([userId, r]) => ({ userId, birthday: r.birthday, at: nextBirthday(r.birthday, now) }))
        .filter((e) => e.at <= horizon)
        .sort((a, b) => a.at - b.at);
    },
  };

  // ---------- task handlers ----------

  bot.scheduler.register('reminder', async (task) => {
    const { userId, channelId, text, guildId } = task.data;
    const embed = embeds
      .base('Reminder', `>>> ${text}`)
      .setFooter({ text: `Set ${new Date(task.createdAt).toUTCString()}` });

    // Route 1: the channel it was set in.
    if (channelId) {
      const channel = await bot.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const sent = await channel
          .send({ content: `<@${userId}>`, embeds: [embed], allowedMentions: { users: [userId] } })
          .catch(() => null);
        if (sent) return;
      }
    }

    // Route 2: a direct message.
    const user = await bot.client.users.fetch(userId).catch(() => null);
    if (user) {
      const sent = await user
        .send({ embeds: [embed.setFooter({ text: guildId ? 'The original channel was unavailable.' : 'Reminder' })] })
        .catch(() => null);
      if (sent) return;
    }

    // Route 3: nothing worked. Log it rather than retrying forever.
    log.debug(`reminder ${task.id} for ${userId} could not be delivered`);
  });

  bot.scheduler.register('birthday', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    if (!guild) return;
    const member = await guild.members.fetch(task.data.userId).catch(() => null);

    // Re-arm for next year regardless of whether the announcement lands.
    const record = bot.db.member(task.guildId, task.data.userId);
    if (record.birthday) {
      const at = nextBirthday(record.birthday, Date.now() + 86_400_000);
      bot.scheduler.schedule('birthday', at, task.data, { guildId: task.guildId, userId: task.data.userId });
    }
    if (!member) return;

    const settings = bot.db.settings(guild.id);
    const channelId = settings.welcome.channelId || settings.logging.channelId;
    if (!channelId) return;

    const age = record.birthday?.year ? new Date().getUTCFullYear() - record.birthday.year : null;
    await bot.sendTo(guild, channelId, {
      content: `<@${member.id}>`,
      embeds: [
        embeds.success(
          'Happy birthday',
          `🎂 It is <@${member.id}>'s birthday today${age ? ` — turning **${age}**` : ''}!`,
        ),
      ],
      allowedMentions: { users: [member.id] },
    });
  });

  void fullTimestamp;
  return api;
}

module.exports = { name: 'reminders', init, MAX_PER_USER };
