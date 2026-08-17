'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const items = require('../../data/items');
const { paginate } = require('../../util/pager');
const { number, truncate, table, codeBlock } = require('../../util/text');

/**
 * Shop and inventory: /shop, /buy, /sell, /inventory, /use, /leaderboard.
 *
 * The catalogue is code, not data, so a new item ships with its behaviour
 * attached rather than needing a database migration; a guild can still append
 * its own cosmetic items on top.
 */

const shop = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse the shop')
    .addStringOption((o) =>
      o
        .setName('category')
        .setDescription('Filter by category')
        .addChoices(...items.CATEGORIES.map((c) => ({ name: c, value: c }))),
    ),
  category: 'economy',
  feature: 'economy',
  cooldown: 5,

  async execute(ctx) {
    const category = ctx.str('category');
    const catalogue = ctx.bot.features.economy
      .catalogue(ctx.i.guildId)
      .filter((item) => item.price && (!category || item.category === category));

    if (!catalogue.length) return ctx.fail('Nothing is for sale in that category.');

    const balance = ctx.bot.features.economy.balance(ctx.i.guildId, ctx.user.id);

    const pages = paginate(catalogue, 6, (slice, { page, total }) => {
      const embed = embeds
        .base(
          category ? `Shop — ${category}` : 'Shop',
          `You have **${ctx.money(balance.wallet)}** in your wallet.\nBuy with \`/buy item:<name>\`.`,
        )
        .setFooter({ text: `Page ${page}/${total} · ${catalogue.length} item(s)` });

      for (const item of slice) {
        const affordable = balance.wallet >= item.price ? '' : ' *(too expensive)*';
        embed.addFields({
          name: `${item.emoji} ${item.name} — ${ctx.money(item.price)}${affordable}`,
          value: `${item.description}\n\`${item.id}\`${item.stackLimit ? ` · max ${item.stackLimit}` : ''}`,
        });
      }
      return embed;
    });

    return ctx.paginate(pages);
  },
};

const buy = {
  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy something from the shop')
    .addStringOption((o) => o.setName('item').setDescription('Item id or name').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('count').setDescription('How many').setMinValue(1).setMaxValue(100)),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async autocomplete(ctx) {
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = ctx.bot.features.economy
      .catalogue(ctx.i.guildId)
      .filter((i) => i.price && (i.id.includes(focused) || i.name.toLowerCase().includes(focused)))
      .slice(0, 25)
      .map((i) => ({ name: `${i.name} — ${number(i.price)}`, value: i.id }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const result = ctx.bot.features.economy.buy(
      ctx.i.guildId,
      ctx.user.id,
      ctx.str('item').toLowerCase(),
      ctx.int('count', 1),
    );
    if (!result.ok) return ctx.fail(result.reason);

    const balance = ctx.bot.features.economy.balance(ctx.i.guildId, ctx.user.id);
    return ctx.ok(
      'Purchased',
      [
        `${result.count} × ${result.item.emoji} **${result.item.name}** for ${ctx.money(result.cost)}.`,
        '',
        result.item.usable ? `Use it with \`/use item:${result.item.id}\`.` : 'It sits in your inventory.',
        `Wallet: ${ctx.money(balance.wallet)}`,
      ].join('\n'),
    );
  },
};

const sell = {
  data: new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell something back')
    .addStringOption((o) => o.setName('item').setDescription('Item id').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('count').setDescription('How many').setMinValue(1).setMaxValue(999)),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async autocomplete(ctx) {
    const record = ctx.record();
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = Object.entries(record.inventory || {})
      .filter(([id]) => id.includes(focused))
      .slice(0, 25)
      .map(([id, count]) => {
        const item = ctx.bot.features.economy.item(ctx.i.guildId, id);
        return { name: `${item?.name || id} × ${count}`, value: id };
      });
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const result = ctx.bot.features.economy.sell(
      ctx.i.guildId,
      ctx.user.id,
      ctx.str('item').toLowerCase(),
      ctx.int('count', 1),
    );
    if (!result.ok) return ctx.fail(result.reason);

    return ctx.ok(
      'Sold',
      `${result.count} × ${result.item.emoji} **${result.item.name}** for ${ctx.money(result.value)}.`,
    );
  },
};

const inventory = {
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Show what you own')
    .addUserOption((o) => o.setName('user').setDescription('Whose inventory to show')),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async execute(ctx) {
    const target = ctx.userOpt('user', true);
    const record = ctx.record(target.id);
    const owned = Object.entries(record.inventory || {}).filter(([, count]) => count > 0);

    if (!owned.length) {
      return ctx.send({
        embeds: [
          embeds.base(
            `${target.username}'s inventory`,
            target.id === ctx.user.id
              ? 'Empty. Have a look at `/shop`.'
              : 'They own nothing at the moment.',
          ),
        ],
      });
    }

    const rows = owned.map(([id, count]) => {
      const item = ctx.bot.features.economy.item(ctx.i.guildId, id);
      const value = item ? items.sellValue(item) * count : 0;
      return [`${item?.emoji || '?'} ${item?.name || id}`, `×${count}`, number(value)];
    });

    const totalValue = rows.reduce((sum, r) => sum + Number(r[2].replace(/,/g, '')), 0);

    return ctx.send({
      embeds: [
        embeds
          .base(
            `${target.username}'s inventory`,
            codeBlock(table(['item', 'qty', 'sell value'], rows, { align: [null, 'right', 'right'] })),
          )
          .addFields(
            { name: 'Distinct items', value: number(owned.length), inline: true },
            { name: 'Total resale value', value: ctx.money(totalValue), inline: true },
          )
          .setFooter({ text: target.id === ctx.user.id ? 'Use an item with /use' : '' }),
      ],
    });
  },
};

const use = {
  data: new SlashCommandBuilder()
    .setName('use')
    .setDescription('Use an item from your inventory')
    .addStringOption((o) => o.setName('item').setDescription('Item id').setRequired(true).setAutocomplete(true)),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async autocomplete(ctx) {
    const record = ctx.record();
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = Object.entries(record.inventory || {})
      .map(([id, count]) => ({ id, count, item: ctx.bot.features.economy.item(ctx.i.guildId, id) }))
      .filter((e) => e.item?.usable && e.id.includes(focused))
      .slice(0, 25)
      .map((e) => ({ name: `${e.item.name} × ${e.count}`, value: e.id }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const result = ctx.bot.features.economy.use(ctx.i.guildId, ctx.user.id, ctx.str('item').toLowerCase());
    if (!result.ok) return ctx.fail(result.reason);

    const item = ctx.bot.features.economy.item(ctx.i.guildId, ctx.str('item').toLowerCase());
    return ctx.send({
      embeds: [embeds.success(`Used ${item.emoji} ${item.name}`, result.message)],
    });
  },
};

const leaderboard = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Server rankings')
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('What to rank by')
        .addChoices(
          { name: 'coins', value: 'coins' },
          { name: 'level', value: 'level' },
          { name: 'messages', value: 'messages' },
          { name: 'games won', value: 'games' },
          { name: 'voice time', value: 'voice' },
          { name: 'counting', value: 'counting' },
          { name: 'reputation', value: 'reputation' },
        ),
    ),
  category: 'economy',
  cooldown: 10,
  examples: ['/leaderboard type:level', '/leaderboard type:coins'],

  async execute(ctx) {
    const type = ctx.str('type', 'coins');

    const scorers = {
      coins: (r) => (r.coins || 0) + (r.bank || 0),
      level: (r) => r.xp || 0,
      messages: (r) => r.messages || 0,
      games: (r) => r.games?.won || 0,
      voice: (r) => r.voiceMinutes || 0,
      counting: (r) => r.counting || 0,
      reputation: (r) => r.reputation || 0,
    };

    const format = {
      coins: (r) => ctx.money((r.coins || 0) + (r.bank || 0)),
      level: (r) => `level ${ctx.bot.features.leveling.levelFromXp(r.xp)} · ${number(r.xp)} XP`,
      messages: (r) => `${number(r.messages)} messages`,
      games: (r) => `${number(r.games.won)} wins of ${number(r.games.played)}`,
      voice: (r) => `${number(Math.round(r.voiceMinutes / 60))}h ${r.voiceMinutes % 60}m`,
      counting: (r) => `${number(r.counting || 0)} numbers`,
      reputation: (r) => `${number(r.reputation)} rep`,
    };

    if (type === 'coins' && !ctx.settings.economy.enabled) {
      return ctx.fail('The economy is disabled on this server.');
    }
    if (type === 'level' && !ctx.settings.leveling.enabled) {
      return ctx.fail('Levelling is disabled on this server.');
    }

    const board = ctx.db.leaderboard(ctx.i.guildId, scorers[type], 200);
    if (!board.length) return ctx.fail('There is nothing to rank yet.');

    const myIndex = board.findIndex((e) => e.userId === ctx.user.id);

    const pages = paginate(board, 10, (slice, { page, total, offset }) => {
      const medals = ['🥇', '🥈', '🥉'];
      const lines = slice.map((entry, i) => {
        const position = offset + i + 1;
        const badge = medals[position - 1] || `**${position}.**`;
        const you = entry.userId === ctx.user.id ? ' ← you' : '';
        return `${badge} <@${entry.userId}> — ${format[type](entry.rec)}${you}`;
      });

      return embeds
        .base(`${ctx.guild.name} — ${type} leaderboard`, lines.join('\n'))
        .setFooter({
          text:
            `Page ${page}/${total} · ${board.length} ranked` +
            (myIndex >= 0 ? ` · you are #${myIndex + 1}` : ' · you are unranked'),
        })
        .setThumbnail(ctx.guild.iconURL({ size: 128 }) || null);
    });

    // Open on the page containing the caller, which is almost always the page
    // they wanted.
    const startIndex = myIndex >= 0 ? Math.floor(myIndex / 10) : 0;
    return ctx.paginate(pages, { startIndex });
  },
};

void truncate;
module.exports = [shop, buy, sell, inventory, use, leaderboard];
