'use strict';

const rng = require('../util/random');
const items = require('../data/items');
const jobs = require('../data/jobs');
const { number } = require('../util/text');
const { sameDay, daysBetween, formatDuration } = require('../util/time');

/**
 * Economy.
 *
 * Everything that moves coins goes through this module rather than mutating
 * records directly, for three reasons:
 *
 *   1. Balances must never go negative. A single missing check somewhere in a
 *      gambling command is enough to mint infinite currency, and once that has
 *      happened the server's economy is unrecoverable without a full reset.
 *   2. Cooldowns are computed from stored timestamps, not timers, so a restart
 *      cannot hand everyone a free /daily.
 *   3. Every transfer is symmetric: the same helper debits and credits, so a
 *      failed payment cannot leave coins created or destroyed.
 */

function init(bot) {
  const log = bot.log.child('economy');

  /** Guild economy settings. */
  const cfg = (guildId) => bot.db.settings(guildId).economy;

  const api = {
    /** Wallet + bank. */
    balance(guildId, userId) {
      const r = bot.db.member(guildId, userId);
      // A member who has never interacted starts with the configured balance
      // rather than zero, which stops "you have nothing" being the first thing
      // a new member sees.
      if (!r.economyInitialised) {
        r.coins = cfg(guildId).startingBalance || 0;
        r.economyInitialised = true;
        bot.db.saveMember();
      }
      return { wallet: r.coins, bank: r.bank, total: r.coins + r.bank };
    },

    /**
     * Adds (or subtracts) coins from the wallet.
     * @returns {number} the new wallet balance
     */
    add(guildId, userId, amount) {
      const r = bot.db.member(guildId, userId);
      api.balance(guildId, userId); // ensures initialisation
      r.coins = Math.max(0, Math.round(r.coins + amount));
      bot.db.saveMember();
      return r.coins;
    },

    /**
     * Removes coins, refusing when the wallet cannot cover it.
     * @returns {boolean} whether the debit happened
     */
    take(guildId, userId, amount) {
      const r = bot.db.member(guildId, userId);
      api.balance(guildId, userId);
      if (r.coins < amount) return false;
      r.coins -= Math.round(amount);
      bot.db.saveMember();
      return true;
    },

    /** Moves coins between wallet and bank. Direction is 'deposit' or 'withdraw'. */
    move(guildId, userId, amount, direction) {
      const r = bot.db.member(guildId, userId);
      api.balance(guildId, userId);
      if (direction === 'deposit') {
        if (r.coins < amount) return false;
        r.coins -= amount;
        r.bank += amount;
      } else {
        if (r.bank < amount) return false;
        r.bank -= amount;
        r.coins += amount;
      }
      bot.db.saveMember();
      return true;
    },

    /** Atomic-enough transfer between two members. */
    transfer(guildId, fromId, toId, amount) {
      if (amount <= 0) return { ok: false, reason: 'Amount must be positive.' };
      if (fromId === toId) return { ok: false, reason: 'You cannot pay yourself.' };
      if (!api.take(guildId, fromId, amount)) return { ok: false, reason: 'Insufficient funds.' };
      api.add(guildId, toId, amount);
      return { ok: true };
    },

    // ---------- cooldowns ----------

    /**
     * Remaining cooldown in ms for a timed command.
     * @param {'work'|'crime'|'rob'|'daily'|'weekly'} kind
     */
    cooldownLeft(guildId, userId, kind) {
      const r = bot.db.member(guildId, userId);
      const settings = cfg(guildId);
      const now = Date.now();

      switch (kind) {
        case 'work':
          return Math.max(0, (r.lastWork || 0) + (settings.workCooldownMinutes || 60) * 60_000 - now);
        case 'crime':
          return Math.max(0, (r.lastCrime || 0) + (settings.crimeCooldownMinutes || 120) * 60_000 - now);
        case 'rob':
          return Math.max(0, (r.lastRob || 0) + (settings.robCooldownMinutes || 180) * 60_000 - now);
        case 'daily': {
          // Daily resets at local midnight rather than 24h after the last claim,
          // which is what people expect from the word "daily".
          const offset = bot.db.settings(guildId).timezoneOffset || 0;
          if (!r.lastDaily) return 0;
          if (!sameDay(r.lastDaily, now, offset)) return 0;
          const midnight = new Date(now + offset * 3_600_000);
          midnight.setUTCHours(24, 0, 0, 0);
          return midnight.getTime() - (now + offset * 3_600_000);
        }
        case 'weekly':
          return Math.max(0, (r.lastWeekly || 0) + 7 * 86_400_000 - now);
        default:
          return 0;
      }
    },

    // ---------- earning ----------

    /** /daily, with a streak bonus that resets when a day is missed. */
    claimDaily(guildId, userId) {
      const left = api.cooldownLeft(guildId, userId, 'daily');
      if (left > 0) return { ok: false, retryIn: left };

      const r = bot.db.member(guildId, userId);
      const settings = cfg(guildId);
      const offset = bot.db.settings(guildId).timezoneOffset || 0;

      // A gap of exactly one day continues the streak; anything larger resets it.
      const gap = r.lastDaily ? daysBetween(r.lastDaily, Date.now(), offset) : Infinity;
      r.dailyStreak = gap === 1 ? (r.dailyStreak || 0) + 1 : 1;

      const base = rng.inRange(settings.dailyAmount, [200, 400]);
      // Streak bonus caps at +100% so a long-running server does not end up with
      // one member earning six figures a day.
      const bonus = Math.min(1, (r.dailyStreak - 1) * 0.05);
      const amount = Math.round(base * (1 + bonus));

      r.lastDaily = Date.now();
      api.add(guildId, userId, amount);
      bot.db.saveMember();

      return { ok: true, amount, streak: r.dailyStreak, bonusPercent: Math.round(bonus * 100), message: rng.pick(jobs.DAILY) };
    },

    /** /weekly, a larger fixed-cadence payout. */
    claimWeekly(guildId, userId) {
      const left = api.cooldownLeft(guildId, userId, 'weekly');
      if (left > 0) return { ok: false, retryIn: left };

      const r = bot.db.member(guildId, userId);
      const amount = rng.inRange(cfg(guildId).weeklyAmount, [1500, 2500]);
      r.lastWeekly = Date.now();
      api.add(guildId, userId, amount);
      bot.db.saveMember();
      return { ok: true, amount };
    },

    /** /work, which always succeeds. */
    work(guildId, userId) {
      const left = api.cooldownLeft(guildId, userId, 'work');
      if (left > 0) return { ok: false, retryIn: left };

      const r = bot.db.member(guildId, userId);
      let amount = rng.inRange(cfg(guildId).workAmount, [80, 220]);
      // Owning a laptop is a permanent, non-consumable bonus.
      if ((r.inventory?.laptop || 0) > 0) amount = Math.round(amount * 1.25);

      r.lastWork = Date.now();
      api.add(guildId, userId, amount);
      bot.db.saveMember();
      return { ok: true, amount, message: rng.pick(jobs.WORK).replace('{amount}', `**${number(amount)}**`) };
    },

    /** /crime, which can fail and fine the member instead. */
    crime(guildId, userId) {
      const left = api.cooldownLeft(guildId, userId, 'crime');
      if (left > 0) return { ok: false, retryIn: left };

      const settings = cfg(guildId);
      const r = bot.db.member(guildId, userId);
      r.lastCrime = Date.now();

      const failed = rng.chance(settings.crimeFailChance ?? 0.45);
      const amount = rng.inRange(settings.crimeAmount, [200, 600]);

      if (failed) {
        // The fine is capped at the wallet so a failed crime cannot put someone
        // into a hole they can never climb out of.
        const fine = Math.min(r.coins, Math.round(amount * 0.6));
        api.add(guildId, userId, -fine);
        bot.db.saveMember();
        return {
          ok: true,
          success: false,
          amount: fine,
          message: rng.pick(jobs.CRIME_FAIL).replace('{amount}', `**${number(fine)}**`),
        };
      }

      api.add(guildId, userId, amount);
      bot.db.saveMember();
      return {
        ok: true,
        success: true,
        amount,
        message: rng.pick(jobs.CRIME_SUCCESS).replace('{amount}', `**${number(amount)}**`),
      };
    },

    /** /rob, the only command that moves coins between members involuntarily. */
    rob(guildId, robberId, targetId, targetName) {
      const left = api.cooldownLeft(guildId, robberId, 'rob');
      if (left > 0) return { ok: false, retryIn: left };

      const settings = cfg(guildId);
      const robber = bot.db.member(guildId, robberId);
      const target = bot.db.member(guildId, targetId);

      if (target.coins < (settings.robMinimumBalance || 250)) {
        return { ok: false, reason: `They are carrying less than ${number(settings.robMinimumBalance || 250)}, which is not worth the risk.` };
      }
      if (robber.coins < 100) {
        return { ok: false, reason: 'You need at least 100 in your wallet to cover the risk.' };
      }

      // A padlock is consumed to block exactly one attempt.
      if ((target.inventory?.padlock || 0) > 0) {
        target.inventory.padlock--;
        if (target.inventory.padlock <= 0) delete target.inventory.padlock;
        robber.lastRob = Date.now();
        bot.db.saveMember();
        return { ok: true, blocked: true, reason: 'Their padlock held. It broke, but they kept their coins.' };
      }
      if (target.shieldUntil && target.shieldUntil > Date.now()) {
        robber.lastRob = Date.now();
        bot.db.saveMember();
        return { ok: true, blocked: true, reason: 'A bank shield deflected the attempt entirely.' };
      }

      robber.lastRob = Date.now();

      let odds = settings.robSuccessChance ?? 0.4;
      if ((robber.inventory?.lockpick || 0) > 0) {
        robber.inventory.lockpick--;
        if (robber.inventory.lockpick <= 0) delete robber.inventory.lockpick;
        odds = Math.min(0.85, odds + 0.25);
      }

      if (!rng.chance(odds)) {
        const fine = Math.min(robber.coins, Math.round(target.coins * 0.15));
        api.add(guildId, robberId, -fine);
        api.add(guildId, targetId, fine); // the fine goes to the victim, not the void
        bot.db.saveMember();
        return {
          ok: true,
          success: false,
          amount: fine,
          message: rng.pick(jobs.ROB_FAIL).replace('{amount}', `**${number(fine)}**`).replace('{target}', targetName),
        };
      }

      // Never take everything: leaving a floor keeps the victim in the game.
      const stolen = Math.round(target.coins * rng.float() * 0.4 + target.coins * 0.1);
      api.add(guildId, targetId, -stolen);
      api.add(guildId, robberId, stolen);
      bot.db.saveMember();
      return {
        ok: true,
        success: true,
        amount: stolen,
        message: rng.pick(jobs.ROB_SUCCESS).replace('{amount}', `**${number(stolen)}**`).replace('{target}', targetName),
      };
    },

    // ---------- inventory ----------

    /** Full catalogue including guild-defined extras. */
    catalogue(guildId) {
      return items.catalogue(cfg(guildId).shop || []);
    },

    item(guildId, id) {
      return items.get(id, cfg(guildId).shop || []);
    },

    /** Buys `count` of an item. */
    buy(guildId, userId, itemId, count = 1) {
      const item = api.item(guildId, itemId);
      if (!item) return { ok: false, reason: 'No such item.' };
      if (!item.price) return { ok: false, reason: `**${item.name}** is not for sale.` };
      if (count < 1 || count > 100) return { ok: false, reason: 'Buy between 1 and 100 at a time.' };

      const r = bot.db.member(guildId, userId);
      const held = r.inventory[item.id] || 0;
      if (item.stackLimit && held + count > item.stackLimit) {
        return { ok: false, reason: `You can only hold ${item.stackLimit} × **${item.name}**.` };
      }

      const cost = item.price * count;
      if (!api.take(guildId, userId, cost)) {
        const balance = api.balance(guildId, userId);
        return { ok: false, reason: `That costs ${number(cost)} and you have ${number(balance.wallet)}.` };
      }

      r.inventory[item.id] = held + count;
      bot.db.saveMember();
      return { ok: true, item, count, cost };
    },

    /** Sells items back at their resale value. */
    sell(guildId, userId, itemId, count = 1) {
      const item = api.item(guildId, itemId);
      if (!item) return { ok: false, reason: 'No such item.' };

      const r = bot.db.member(guildId, userId);
      const held = r.inventory[item.id] || 0;
      if (held < count) return { ok: false, reason: `You only have ${held} × **${item.name}**.` };

      const value = items.sellValue(item) * count;
      if (value <= 0) return { ok: false, reason: `**${item.name}** has no resale value.` };

      r.inventory[item.id] = held - count;
      if (r.inventory[item.id] <= 0) delete r.inventory[item.id];
      api.add(guildId, userId, value);
      bot.db.saveMember();
      return { ok: true, item, count, value };
    },

    /** Grants an item without charging for it, used by loot and admin tools. */
    give(guildId, userId, itemId, count = 1) {
      const r = bot.db.member(guildId, userId);
      r.inventory[itemId] = (r.inventory[itemId] || 0) + count;
      bot.db.saveMember();
      return r.inventory[itemId];
    },

    /**
     * Uses an item, applying its effect.
     * @returns {{ ok: boolean, message?: string, reason?: string }}
     */
    use(guildId, userId, itemId) {
      const item = api.item(guildId, itemId);
      if (!item) return { ok: false, reason: 'No such item.' };
      if (!item.usable) return { ok: false, reason: `**${item.name}** cannot be used.` };

      const r = bot.db.member(guildId, userId);
      if ((r.inventory[item.id] || 0) < 1) return { ok: false, reason: `You do not own a **${item.name}**.` };

      const result = applyEffect(guildId, userId, item, r);
      if (!result.ok) return result;

      if (item.consumable) {
        r.inventory[item.id]--;
        if (r.inventory[item.id] <= 0) delete r.inventory[item.id];
      }
      bot.db.saveMember();
      return result;
    },

    /** Ranked list by total worth. */
    leaderboard(guildId, limit = 100) {
      return bot.db.leaderboard(guildId, (r) => (r.coins || 0) + (r.bank || 0), limit);
    },

    /** Random coin drop on a message, when the guild has it enabled. */
    maybeDrop(message) {
      const settings = cfg(message.guildId);
      if (!settings.enabled || !settings.messageDrops?.enabled) return null;
      if (!rng.chance(settings.messageDrops.chance ?? 0.02)) return null;
      const amount = rng.inRange(settings.messageDrops.amount, [5, 25]);
      api.add(message.guildId, message.author.id, amount);
      return amount;
    },

    /** Applies daily bank interest, called by a scheduled task. */
    applyInterest(guildId) {
      const settings = cfg(guildId);
      const rate = Number(settings.interestPercent) || 0;
      if (rate <= 0) return 0;
      let paid = 0;
      for (const [userId, record] of bot.db.members(guildId)) {
        if (!record.bank) continue;
        const gain = Math.floor(record.bank * (rate / 100));
        if (gain <= 0) continue;
        record.bank += gain;
        paid += gain;
        void userId;
      }
      if (paid) bot.db.saveMember();
      return paid;
    },
  };

  /** Item effects. Kept separate so the item table stays declarative. */
  function applyEffect(guildId, userId, item, record) {
    switch (item.effect) {
      case 'reset_work':
        record.lastWork = 0;
        return { ok: true, message: 'Your /work cooldown is cleared.' };

      case 'reset_all':
        record.lastWork = 0;
        record.lastCrime = 0;
        record.lastRob = 0;
        return { ok: true, message: 'Every economy cooldown is cleared.' };

      case 'padlock':
        record.inventory.padlock = (record.inventory.padlock || 0);
        // The padlock is "used" by being held, so consuming it here would be
        // wrong; the rob handler consumes it when it actually blocks something.
        return { ok: false, reason: 'A padlock protects you automatically while you hold it - no need to use it.' };

      case 'shield':
        record.shieldUntil = Date.now() + 86_400_000;
        return { ok: true, message: 'Your bank shield is active for 24 hours.' };

      case 'xp_boost':
        record.xpBoostUntil = Date.now() + 3_600_000;
        return { ok: true, message: 'Double XP for the next hour.' };

      case 'lottery': {
        const prize = rng.weighted(items.LOTTERY_PRIZES);
        const amount = rng.int(prize.min, prize.max);
        if (amount > 0) api.add(guildId, userId, amount);
        return {
          ok: true,
          message: amount > 0 ? `You scratched ${prize.label}: **${number(amount)}**.` : 'You scratched it. Nothing. Again.',
        };
      }

      case 'mystery': {
        const loot = rng.weighted(items.MYSTERY_LOOT);
        if (loot.kind === 'coins') {
          const amount = rng.int(loot.min, loot.max);
          api.add(guildId, userId, amount);
          return { ok: true, message: `The box contained **${number(amount)}** coins.` };
        }
        api.give(guildId, userId, loot.id, loot.count);
        const found = api.item(guildId, loot.id);
        return { ok: true, message: `The box contained ${loot.count} × ${found?.emoji || ''} **${found?.name || loot.id}**.` };
      }

      case 'fish': {
        const cooldown = 5 * 60_000;
        if (Date.now() - (record.lastFish || 0) < cooldown) {
          return { ok: false, reason: `The fish are not biting yet. Try again in ${formatDuration(cooldown - (Date.now() - record.lastFish))}.` };
        }
        record.lastFish = Date.now();
        const loot = rng.weighted(items.FISHING_LOOT);
        if (loot.kind === 'coins') {
          const amount = rng.int(loot.min, loot.max);
          api.add(guildId, userId, amount);
          return { ok: true, message: `You reeled in ${loot.message} worth **${number(amount)}**.` };
        }
        if (loot.kind === 'nothing') return { ok: true, message: `You reeled in ${loot.message}. Better luck next cast.` };
        api.give(guildId, userId, loot.id, loot.count);
        return { ok: true, message: `You reeled in ${loot.message}.` };
      }

      case 'mine': {
        const cooldown = 8 * 60_000;
        if (Date.now() - (record.lastMine || 0) < cooldown) {
          return { ok: false, reason: `Your pickaxe needs a rest. Try again in ${formatDuration(cooldown - (Date.now() - record.lastMine))}.` };
        }
        record.lastMine = Date.now();
        const loot = rng.weighted(items.MINING_LOOT);
        if (loot.kind === 'coins') {
          const amount = rng.int(loot.min, loot.max);
          api.add(guildId, userId, amount);
          return { ok: true, message: `You struck ${loot.message} worth **${number(amount)}**.` };
        }
        if (loot.kind === 'nothing') return { ok: true, message: `You found ${loot.message}.` };
        api.give(guildId, userId, loot.id, loot.count);
        return { ok: true, message: `You struck ${loot.message}.` };
      }

      case 'color_token':
        record.colorTokens = (record.colorTokens || 0) + 1;
        return { ok: true, message: 'Redeemed. Set your colour with `/profile color`.' };

      default:
        if (item.effect?.startsWith('badge:')) {
          const badge = item.effect.slice('badge:'.length);
          if (record.badges.includes(badge)) return { ok: false, reason: 'You already have that badge.' };
          record.badges.push(badge);
          return { ok: true, message: `Badge unlocked: **${badge}**.` };
        }
        log.warn(`item ${item.id} has an unknown effect "${item.effect}"`);
        return { ok: false, reason: 'That item does nothing yet.' };
    }
  }

  return api;
}

module.exports = { name: 'economy', init };
