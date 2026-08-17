'use strict';

/**
 * Shop catalogue.
 *
 * Items are declared here rather than in the database so a code update can add
 * a new item without a migration, and so an item's *behaviour* lives next to
 * its price. A guild can still append its own cosmetic items through
 * /economy shop add; those are merged on top of this list at runtime.
 *
 * Item shape:
 *   id          stable key stored in a member's inventory
 *   name        display name
 *   emoji       shown in listings
 *   price       cost in coins, null means not purchasable
 *   sell        resale value, defaults to 40% of price
 *   description one line, shown in the shop
 *   category    groups the shop listing
 *   usable      whether /use does something
 *   consumable  whether /use removes one from the inventory
 *   stackLimit  maximum a member may hold
 *   effect      key interpreted by features/economy.js when used
 */

const ITEMS = [
  // ---------- tools ----------
  {
    id: 'fishing_rod',
    name: 'Fishing Rod',
    emoji: '🎣',
    price: 500,
    category: 'tools',
    description: 'Unlocks fishing, a low-risk way to earn on a short cooldown.',
    usable: true,
    consumable: false,
    stackLimit: 1,
    effect: 'fish',
  },
  {
    id: 'pickaxe',
    name: 'Pickaxe',
    emoji: '⛏️',
    price: 750,
    category: 'tools',
    description: 'Mine for ore. Occasionally turns up something genuinely valuable.',
    usable: true,
    consumable: false,
    stackLimit: 1,
    effect: 'mine',
  },
  {
    id: 'laptop',
    name: 'Laptop',
    emoji: '💻',
    price: 2500,
    category: 'tools',
    description: 'Raises the payout of /work by 25% while you own one.',
    usable: false,
    consumable: false,
    stackLimit: 1,
    effect: 'work_bonus',
  },
  {
    id: 'lockpick',
    name: 'Lockpick',
    emoji: '🔓',
    price: 900,
    category: 'tools',
    description: 'Improves the odds on your next /rob attempt. Breaks on use.',
    usable: false,
    consumable: true,
    stackLimit: 5,
    effect: 'rob_bonus',
  },

  // ---------- protection ----------
  {
    id: 'padlock',
    name: 'Padlock',
    emoji: '🔒',
    price: 1000,
    category: 'protection',
    description: 'Blocks the next attempt to rob you, then breaks.',
    usable: true,
    consumable: true,
    stackLimit: 3,
    effect: 'padlock',
  },
  {
    id: 'shield',
    name: 'Bank Shield',
    emoji: '🛡️',
    price: 4000,
    category: 'protection',
    description: 'Protects your wallet from robbery for 24 hours.',
    usable: true,
    consumable: true,
    stackLimit: 2,
    effect: 'shield',
  },

  // ---------- consumables ----------
  {
    id: 'coffee',
    name: 'Coffee',
    emoji: '☕',
    price: 150,
    category: 'consumables',
    description: 'Clears your /work cooldown immediately.',
    usable: true,
    consumable: true,
    stackLimit: 10,
    effect: 'reset_work',
  },
  {
    id: 'energy_drink',
    name: 'Energy Drink',
    emoji: '🥤',
    price: 400,
    category: 'consumables',
    description: 'Clears every economy cooldown at once.',
    usable: true,
    consumable: true,
    stackLimit: 5,
    effect: 'reset_all',
  },
  {
    id: 'lottery_ticket',
    name: 'Lottery Ticket',
    emoji: '🎟️',
    price: 250,
    category: 'consumables',
    description: 'Scratch it for anything between nothing and a small fortune.',
    usable: true,
    consumable: true,
    stackLimit: 25,
    effect: 'lottery',
  },
  {
    id: 'xp_boost',
    name: 'XP Booster',
    emoji: '⚡',
    price: 3000,
    category: 'consumables',
    description: 'Doubles the XP you earn for the next hour.',
    usable: true,
    consumable: true,
    stackLimit: 5,
    effect: 'xp_boost',
  },
  {
    id: 'mystery_box',
    name: 'Mystery Box',
    emoji: '📦',
    price: 1200,
    category: 'consumables',
    description: 'Contains a random item, or coins if luck is not on your side.',
    usable: true,
    consumable: true,
    stackLimit: 10,
    effect: 'mystery',
  },

  // ---------- collectables ----------
  {
    id: 'fish',
    name: 'Fish',
    emoji: '🐟',
    price: null,
    sell: 45,
    category: 'collectables',
    description: 'Caught with a fishing rod. Sells for a modest amount.',
    usable: false,
    consumable: false,
    stackLimit: 999,
  },
  {
    id: 'rare_fish',
    name: 'Golden Koi',
    emoji: '🐠',
    price: null,
    sell: 400,
    category: 'collectables',
    description: 'A rare catch. Worth holding onto or selling high.',
    usable: false,
    consumable: false,
    stackLimit: 999,
  },
  {
    id: 'iron',
    name: 'Iron Ore',
    emoji: '🪨',
    price: null,
    sell: 60,
    category: 'collectables',
    description: 'Mined from the depths. Common but steady income.',
    usable: false,
    consumable: false,
    stackLimit: 999,
  },
  {
    id: 'gold',
    name: 'Gold Nugget',
    emoji: '🥇',
    price: null,
    sell: 350,
    category: 'collectables',
    description: 'A satisfying find at the bottom of a mine shaft.',
    usable: false,
    consumable: false,
    stackLimit: 999,
  },
  {
    id: 'diamond',
    name: 'Diamond',
    emoji: '💎',
    price: 25_000,
    sell: 12_000,
    category: 'collectables',
    description: 'Pure status. Does nothing at all, expensively.',
    usable: false,
    consumable: false,
    stackLimit: 99,
  },
  {
    id: 'trophy',
    name: 'Trophy',
    emoji: '🏆',
    price: 50_000,
    sell: 20_000,
    category: 'collectables',
    description: 'Proof you had more coins than sense.',
    usable: false,
    consumable: false,
    stackLimit: 10,
  },

  // ---------- roles and cosmetics ----------
  {
    id: 'name_color',
    name: 'Name Colour Token',
    emoji: '🎨',
    price: 5000,
    category: 'cosmetics',
    description: 'Redeem to set a custom profile colour with /profile color.',
    usable: true,
    consumable: true,
    stackLimit: 5,
    effect: 'color_token',
  },
  {
    id: 'badge_star',
    name: 'Star Badge',
    emoji: '🌟',
    price: 8000,
    category: 'cosmetics',
    description: 'Adds a star to your /profile.',
    usable: true,
    consumable: true,
    stackLimit: 1,
    effect: 'badge:star',
  },
  {
    id: 'badge_crown',
    name: 'Crown Badge',
    emoji: '👑',
    price: 30_000,
    category: 'cosmetics',
    description: 'Adds a crown to your /profile. Purely for showing off.',
    usable: true,
    consumable: true,
    stackLimit: 1,
    effect: 'badge:crown',
  },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** Loot table for the mystery box, weighted so the good outcomes stay rare. */
const MYSTERY_LOOT = [
  { weight: 30, kind: 'coins', min: 200, max: 800 },
  { weight: 20, kind: 'item', id: 'lottery_ticket', count: 2 },
  { weight: 15, kind: 'item', id: 'coffee', count: 3 },
  { weight: 12, kind: 'coins', min: 1500, max: 3000 },
  { weight: 10, kind: 'item', id: 'padlock', count: 1 },
  { weight: 6, kind: 'item', id: 'energy_drink', count: 1 },
  { weight: 4, kind: 'item', id: 'gold', count: 1 },
  { weight: 2, kind: 'item', id: 'xp_boost', count: 1 },
  { weight: 1, kind: 'item', id: 'diamond', count: 1 },
];

/** Fishing outcomes, from "junk" to "put it on the wall". */
const FISHING_LOOT = [
  { weight: 45, id: 'fish', count: 1, message: 'a decent catch' },
  { weight: 20, id: 'fish', count: 2, message: 'a double catch' },
  { weight: 15, kind: 'coins', min: 20, max: 90, message: 'a waterlogged wallet' },
  { weight: 10, kind: 'nothing', message: 'an old boot' },
  { weight: 7, id: 'rare_fish', count: 1, message: 'a golden koi' },
  { weight: 3, kind: 'coins', min: 400, max: 900, message: 'a sunken treasure chest' },
];

/** Mining outcomes. */
const MINING_LOOT = [
  { weight: 40, id: 'iron', count: 1, message: 'a vein of iron' },
  { weight: 22, id: 'iron', count: 2, message: 'a rich iron seam' },
  { weight: 15, kind: 'nothing', message: 'nothing but gravel' },
  { weight: 12, id: 'gold', count: 1, message: 'a gold nugget' },
  { weight: 8, kind: 'coins', min: 100, max: 400, message: 'a buried coin stash' },
  { weight: 3, id: 'diamond', count: 1, message: 'a diamond' },
];

/** Lottery ticket payouts. */
const LOTTERY_PRIZES = [
  { weight: 50, min: 0, max: 0, label: 'nothing at all' },
  { weight: 25, min: 50, max: 200, label: 'a small win' },
  { weight: 15, min: 300, max: 700, label: 'a decent win' },
  { weight: 7, min: 1000, max: 2500, label: 'a big win' },
  { weight: 2, min: 5000, max: 9000, label: 'a serious win' },
  { weight: 1, min: 20_000, max: 50_000, label: 'the jackpot' },
];

/** Looks up an item by id, including guild-defined extras. */
function get(id, extras = []) {
  const found = BY_ID.get(String(id).toLowerCase());
  if (found) return found;
  return extras.find((i) => i.id === String(id).toLowerCase()) || null;
}

/** Resale value: explicit `sell`, otherwise 40% of the price. */
function sellValue(item) {
  if (item.sell !== undefined && item.sell !== null) return item.sell;
  if (!item.price) return 0;
  return Math.floor(item.price * 0.4);
}

/** Every purchasable item, guild extras included. */
function catalogue(extras = []) {
  return [...ITEMS, ...extras];
}

/** Distinct category names in display order. */
const CATEGORIES = ['tools', 'protection', 'consumables', 'collectables', 'cosmetics'];

module.exports = {
  ITEMS,
  BY_ID,
  CATEGORIES,
  MYSTERY_LOOT,
  FISHING_LOOT,
  MINING_LOOT,
  LOTTERY_PRIZES,
  get,
  sellValue,
  catalogue,
};
