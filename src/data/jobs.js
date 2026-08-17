'use strict';

/**
 * Flavour text for the earning commands.
 *
 * Each entry uses {amount} as the payout placeholder. Keeping the copy in a
 * data file means new scenarios can be added without touching the economy
 * logic, and makes it obvious where to translate if that is ever wanted.
 */

/** /work - always pays out, low variance. */
const WORK = [
  'You fixed a printer that was only unplugged and billed {amount} for expertise.',
  'You walked six dogs at once and somehow returned with six dogs. {amount}.',
  'You reviewed a pull request nobody else wanted to touch. {amount} well earned.',
  'You worked a shift at the coffee shop and earned {amount} in wages and tips.',
  'You tutored someone through their algebra homework for {amount}.',
  'You delivered food across town in the rain and made {amount}.',
  'You wrote documentation nobody will read. Still, {amount}.',
  'You fixed a leaking tap for a neighbour and they insisted on paying {amount}.',
  'You spent the afternoon as a extras in a commercial. {amount}.',
  'You sold your old textbooks for {amount}.',
  'You mowed three lawns before noon and pocketed {amount}.',
  'You debugged a production incident at 3am. Hazard pay: {amount}.',
  'You photographed a wedding and survived. {amount}.',
  'You built someone a website out of a template and charged {amount}.',
  'You covered a shift for a colleague and got {amount} for the trouble.',
  'You cleaned out a garage and found {amount} worth of scrap to sell.',
  'You streamed for four hours and made {amount} in donations.',
  'You painted a fence. It was oddly satisfying and paid {amount}.',
  'You did a stock take that should have taken two hours and took six. {amount}.',
  'You translated a document and earned {amount}.',
  'You ran a market stall for a day and cleared {amount}.',
  'You assembled flat-pack furniture professionally. {amount}, and no leftover screws.',
  'You played a gig at a small venue for {amount} and a free drink.',
  'You proofread a thesis and got {amount} plus a headache.',
];

/** /crime - can fail. Success copy. */
const CRIME_SUCCESS = [
  'You sold bridge-shaped NFTs to a stranger and made {amount}.',
  'You "found" an unattended cash register and left with {amount}.',
  'You ran a suspiciously profitable raffle and cleared {amount}.',
  'You convinced a company their printer needed a {amount} service contract.',
  'You resold concert tickets at a markup and made {amount}.',
  'You forged a signature on an expense claim worth {amount}.',
  'You liberated {amount} from a vending machine that owed you.',
  'You ran a fake tech support line for an afternoon. {amount}.',
  'You smuggled contraband snacks into a cinema and sold them for {amount}.',
  'You mined crypto on the office servers and cashed out {amount}.',
  'You sold a bridge you did not own. Somehow, {amount}.',
  'You short-changed a tourist exchange booth and walked out with {amount}.',
];

/** /crime - failure copy. {amount} is the fine. */
const CRIME_FAIL = [
  'Security recognised you from last time. You paid {amount} in fines.',
  'You tripped the alarm within four seconds. {amount} gone.',
  'Your getaway vehicle was a bicycle with a flat tyre. {amount} lost.',
  'You posted about it before doing it. That cost {amount}.',
  'The mark turned out to be an off-duty officer. {amount} fine.',
  'You left your wallet at the scene. Recovering it cost {amount}.',
  'The plan required three people. You brought zero. {amount} lost.',
  'You were caught on four separate cameras. Legal fees: {amount}.',
  'Turns out the safe was a mini fridge. {amount} in damages.',
  'You confessed unprompted to a stranger who was a journalist. {amount}.',
];

/** /rob - success copy. */
const ROB_SUCCESS = [
  'You lifted {amount} from {target} while they were distracted by a notification.',
  'You picked {target}\'s pocket cleanly and took {amount}.',
  'You convinced {target} you were collecting for charity. {amount} richer.',
  'You found {target}\'s wallet exactly where they left it. {amount}.',
  'A perfectly executed distraction relieved {target} of {amount}.',
];

/** /rob - failure copy. */
const ROB_FAIL = [
  '{target} noticed immediately and you paid {amount} to make it go away.',
  'You reached for {target}\'s pocket and grabbed a wasp. {amount} in medical bills.',
  '{target} was faster than you. {amount} lost in the scramble.',
  'You robbed the wrong person entirely. {amount} in compensation.',
  '{target} had nothing but receipts. You dropped {amount} running away.',
];

/** /daily - varies the copy so the command does not feel like a slot machine. */
const DAILY = [
  'Daily deposit received: {amount}.',
  'Your allowance came through: {amount}.',
  'You showed up. That is worth {amount}.',
  'A grateful stranger handed you {amount}.',
  'Your investments paid a dividend of {amount}.',
];

/** Slot machine reels, ordered from common to rare. */
const SLOT_SYMBOLS = [
  { emoji: '🍒', weight: 30, payout: 2 },
  { emoji: '🍋', weight: 25, payout: 3 },
  { emoji: '🍇', weight: 20, payout: 4 },
  { emoji: '🔔', weight: 12, payout: 6 },
  { emoji: '⭐', weight: 8, payout: 10 },
  { emoji: '💎', weight: 4, payout: 20 },
  { emoji: '7️⃣', weight: 1, payout: 50 },
];

module.exports = {
  WORK,
  CRIME_SUCCESS,
  CRIME_FAIL,
  ROB_SUCCESS,
  ROB_FAIL,
  DAILY,
  SLOT_SYMBOLS,
};
