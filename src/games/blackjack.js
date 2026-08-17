'use strict';

const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const { number } = require('../util/text');

/**
 * Blackjack against the dealer.
 *
 * Rules implemented: dealer stands on all 17s, blackjack pays 3:2, double down
 * on the first two cards only, and no splitting. Those are stated in the embed
 * footer, because a gambling game that does not tell you its rules will
 * eventually be accused of cheating and there is no way to disprove it.
 *
 * The wager is taken from the wallet up front and the payout returned at the
 * end, so a crash mid-hand costs the player their stake rather than letting
 * them replay a losing hand.
 */

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck(decks = 4) {
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
  }
  return rng.shuffle(cards);
}

/** Best total for a hand, treating aces as 11 until that would bust. */
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') {
      aces++;
      total += 11;
    } else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

const isBlackjack = (hand) => hand.length === 2 && handValue(hand) === 21;
const showHand = (hand) => hand.map((c) => `\`${c.rank}${c.suit}\``).join(' ');

module.exports = {
  name: 'bj',
  title: 'Blackjack',

  start({ wager = 0 } = {}) {
    const deck = buildDeck();
    const player = [deck.pop(), deck.pop()];
    const dealer = [deck.pop(), deck.pop()];

    return {
      deck,
      player,
      dealer,
      wager,
      doubled: false,
      // A natural blackjack resolves immediately; there is nothing to decide.
      result: isBlackjack(player) || isBlackjack(dealer) ? 'natural' : null,
      payout: 0,
    };
  },

  render(session) {
    const { state } = session;
    const done = Boolean(state.result);
    const playerTotal = handValue(state.player);
    const dealerTotal = handValue(state.dealer);

    const dealerLine = done
      ? `${showHand(state.dealer)}  **${dealerTotal}**`
      : `${showHand([state.dealer[0]])} \`??\``;

    let outcome = '';
    if (done) {
      const map = {
        win: '**You win.**',
        lose: '**Dealer wins.**',
        push: '**Push** — your stake is returned.',
        blackjack: '**Blackjack!** Paid 3:2.',
        bust: '**Bust.**',
        dealer_bust: '**Dealer busts — you win.**',
      };
      outcome = map[state.result] || '';
      if (state.payout > 0) outcome += `\nYou won ${number(state.payout)}.`;
      else if (state.wager) outcome += `\nYou lost ${number(state.wager * (state.doubled ? 2 : 1))}.`;
    }

    const embed = embeds
      .base(
        'Blackjack',
        [
          `**Dealer**\n${dealerLine}`,
          '',
          `**${session.players[0].tag}**\n${showHand(state.player)}  **${playerTotal}**`,
          state.wager ? `\nWager: ${number(state.wager * (state.doubled ? 2 : 1))}` : '',
          outcome ? `\n${outcome}` : '',
        ].join('\n'),
        done
          ? ['win', 'blackjack', 'dealer_bust'].includes(state.result)
            ? embeds.theme.success
            : state.result === 'push'
              ? embeds.theme.warning
              : embeds.theme.danger
          : embeds.theme.primary,
      )
      .setFooter({ text: 'Dealer stands on all 17s · blackjack pays 3:2 · no splitting' });

    if (done) return { embeds: [embed], components: [] };

    const canDouble = state.player.length === 2 && !state.doubled;
    return {
      embeds: [embed],
      components: [
        components.buttonRow(
          { id: components.customId('g', 'bj', 'hit', session.id), label: 'Hit', emoji: '🃏', style: 'Primary' },
          { id: components.customId('g', 'bj', 'stand', session.id), label: 'Stand', emoji: '✋', style: 'Secondary' },
          {
            id: components.customId('g', 'bj', 'double', session.id),
            label: 'Double',
            emoji: '💰',
            style: 'Success',
            disabled: !canDouble,
          },
        ),
      ],
    };
  },

  async action(session, interaction, { action, manager }) {
    const { state } = session;
    if (state.result) return { finished: true };

    if (action === 'hit') {
      state.player.push(state.deck.pop());
      if (handValue(state.player) > 21) {
        state.result = 'bust';
        await module.exports.settle(session, manager);
        return { finished: true };
      }
      return {};
    }

    if (action === 'double') {
      if (state.player.length !== 2 || state.doubled) return {};
      // The extra stake is taken now so a doubled hand cannot be free.
      const economy = manager.bot.features.economy;
      if (state.wager && economy && !economy.take(session.guildId, session.players[0].id, state.wager)) {
        return { followUp: 'You do not have enough to double down.' };
      }
      state.doubled = true;
      state.player.push(state.deck.pop());
      if (handValue(state.player) > 21) state.result = 'bust';
      else module.exports.playDealer(state);
      await module.exports.settle(session, manager);
      return { finished: true };
    }

    if (action === 'stand') {
      module.exports.playDealer(state);
      await module.exports.settle(session, manager);
      return { finished: true };
    }

    return {};
  },

  /** Dealer draws to 17, standing on soft 17 as well. */
  playDealer(state) {
    while (handValue(state.dealer) < 17) state.dealer.push(state.deck.pop());

    const player = handValue(state.player);
    const dealer = handValue(state.dealer);

    if (dealer > 21) state.result = 'dealer_bust';
    else if (player > dealer) state.result = 'win';
    else if (player < dealer) state.result = 'lose';
    else state.result = 'push';
  },

  /** Works out the payout and credits the wallet. */
  async settle(session, manager) {
    const { state } = session;
    const player = session.players[0];
    const stake = state.wager * (state.doubled ? 2 : 1);

    if (state.result === 'natural') {
      // Resolve the immediate blackjack cases now that both hands are known.
      const playerBJ = isBlackjack(state.player);
      const dealerBJ = isBlackjack(state.dealer);
      if (playerBJ && dealerBJ) state.result = 'push';
      else if (playerBJ) state.result = 'blackjack';
      else state.result = 'lose';
    }

    switch (state.result) {
      case 'blackjack':
        state.payout = Math.round(stake * 2.5); // stake back plus 3:2
        break;
      case 'win':
      case 'dealer_bust':
        state.payout = stake * 2;
        break;
      case 'push':
        state.payout = stake;
        break;
      default:
        state.payout = 0;
    }

    if (!session.guildId) return;

    const outcome = state.payout > stake ? 'win' : state.payout === stake ? 'draw' : 'loss';
    manager.recordResult(session.guildId, player.id, outcome);

    const record = manager.bot.db.member(session.guildId, player.id);
    record.gambling.wagered += stake;
    if (state.payout > stake) record.gambling.won += state.payout - stake;
    else record.gambling.lost += stake - state.payout;
    manager.bot.db.saveMember();

    const economy = manager.bot.features.economy;
    if (economy && state.payout > 0) economy.add(session.guildId, player.id, state.payout);
  },

  handValue,
  buildDeck,
  isBlackjack,
};
