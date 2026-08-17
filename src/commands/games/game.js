'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const rng = require('../../util/random');
const trivia = require('../../data/trivia');
const minesweeper = require('../../games/minesweeper');
const { number } = require('../../util/text');

/**
 * /game — the single entry point for every interactive game.
 *
 * One command with subcommands rather than ten top-level commands, for two
 * reasons: Discord caps an application at 100 commands and games are the
 * easiest place to waste that budget, and a player looking for "the games" finds
 * them all in one place instead of having to know each name.
 *
 * Shared plumbing lives here: opponent validation, wager checks and the
 * create-send-attach dance that every game needs.
 */

const DIFFICULTY_CHOICES = [
  { name: 'easy', value: 'easy' },
  { name: 'medium', value: 'medium' },
  { name: 'hard', value: 'hard' },
];

/**
 * Validates an opponent and returns the player list, or an error string.
 * A null opponent means "play the bot".
 */
function buildPlayers(ctx, opponent) {
  const me = { id: ctx.user.id, tag: ctx.user.tag };
  if (!opponent) return { players: [me, { id: ctx.client.user.id, tag: ctx.client.user.tag, bot: true }] };
  if (opponent.id === ctx.user.id) return { error: 'You cannot play against yourself.' };
  if (opponent.bot) return { error: 'Pick a human opponent, or leave it empty to play against me.' };
  return { players: [me, { id: opponent.id, tag: opponent.tag }] };
}

/** Checks that a wager is affordable and that the economy is even on. */
function checkWager(ctx, wager, players) {
  if (!wager) return null;
  const settings = ctx.settings;
  if (!settings.economy.enabled) return 'The economy is disabled on this server, so wagers are not available.';
  if (wager > settings.economy.maxBet) return `The maximum bet on this server is ${number(settings.economy.maxBet)}.`;

  const economy = ctx.bot.features.economy;
  for (const player of players) {
    if (player.bot) continue;
    const balance = economy.balance(ctx.i.guildId, player.id);
    if (balance.wallet < wager) {
      return player.id === ctx.user.id
        ? `You only have ${number(balance.wallet)} in your wallet.`
        : `<@${player.id}> does not have enough to cover that wager.`;
    }
  }
  return null;
}

/** Creates a session, sends its first render, and records the message id. */
async function launch(ctx, gameName, { players, state, wager = 0 }) {
  const manager = ctx.bot.features.games;
  if (!manager || manager.disabled) return ctx.fail('Games are disabled on this bot.');

  const session = manager.create(gameName, {
    players,
    state,
    guildId: ctx.i.guildId,
    channelId: ctx.i.channelId,
    wager,
  });

  const game = manager.get(gameName);
  await ctx.send(game.render(session, { manager }));
  const message = await ctx.i.fetchReply();
  manager.attach(session, message.id);
  return session;
}

const game = {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Play a game')
    .addSubcommand((s) =>
      s
        .setName('tictactoe')
        .setDescription('Tic-tac-toe against a member or me')
        .addUserOption((o) => o.setName('opponent').setDescription('Leave empty to play me'))
        .addStringOption((o) => o.setName('difficulty').setDescription('How hard I play').addChoices(...DIFFICULTY_CHOICES))
        .addIntegerOption((o) => o.setName('wager').setDescription('Coins each player stakes').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('connect4')
        .setDescription('Connect Four against a member or me')
        .addUserOption((o) => o.setName('opponent').setDescription('Leave empty to play me'))
        .addStringOption((o) => o.setName('difficulty').setDescription('How hard I play').addChoices(...DIFFICULTY_CHOICES))
        .addIntegerOption((o) => o.setName('wager').setDescription('Coins each player stakes').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('rps')
        .setDescription('Rock paper scissors, best of N')
        .addUserOption((o) => o.setName('opponent').setDescription('Leave empty to play me'))
        .addIntegerOption((o) =>
          o.setName('rounds').setDescription('Best of, must be odd (1-9)').setMinValue(1).setMaxValue(9),
        )
        .addIntegerOption((o) => o.setName('wager').setDescription('Coins each player stakes').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('hangman')
        .setDescription('Hangman — anyone in the channel can guess')
        .addStringOption((o) => o.setName('word').setDescription('Set your own word (it is never shown in chat)')),
    )
    .addSubcommand((s) =>
      s
        .setName('wordle')
        .setDescription('Guess the five letter word in six tries')
        .addBooleanOption((o) => o.setName('hard').setDescription('Hard mode: revealed hints must be reused')),
    )
    .addSubcommand((s) =>
      s
        .setName('minesweeper')
        .setDescription('Minesweeper, playable or as a spoiler grid')
        .addStringOption((o) => o.setName('difficulty').setDescription('Board difficulty').addChoices(...DIFFICULTY_CHOICES))
        .addBooleanOption((o) => o.setName('spoiler').setDescription('Post a static spoiler grid instead')),
    )
    .addSubcommand((s) =>
      s
        .setName('blackjack')
        .setDescription('Blackjack against the dealer')
        .addIntegerOption((o) => o.setName('wager').setDescription('Coins to stake').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('slots')
        .setDescription('Spin the slot machine')
        .addIntegerOption((o) => o.setName('wager').setDescription('Coins per spin').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('trivia')
        .setDescription('Trivia, single question or a quiz')
        .addStringOption((o) =>
          o
            .setName('category')
            .setDescription('Question category')
            .addChoices(...trivia.CATEGORIES.map((c) => ({ name: c, value: c }))),
        )
        .addStringOption((o) => o.setName('difficulty').setDescription('Question difficulty').addChoices(...DIFFICULTY_CHOICES))
        .addIntegerOption((o) => o.setName('rounds').setDescription('How many questions (1-10)').setMinValue(1).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('guess')
        .setDescription('Guess the number I am thinking of')
        .addStringOption((o) => o.setName('difficulty').setDescription('Range size').addChoices(...DIFFICULTY_CHOICES)),
    )
    .addSubcommand((s) => s.setName('stats').setDescription('Your game record on this server')),
  category: 'games',
  cooldown: 5,
  feature: 'games',
  botPerms: [PermissionFlagsBits.EmbedLinks],
  examples: ['/game tictactoe', '/game wordle hard:true', '/game blackjack wager:500'],

  async execute(ctx) {
    const manager = ctx.bot.features.games;
    if (!manager || manager.disabled) return ctx.fail('Games are disabled on this bot.');

    switch (ctx.sub) {
      // ---------- two player board games ----------
      case 'tictactoe':
      case 'connect4':
      case 'rps': {
        const key = { tictactoe: 'ttt', connect4: 'c4', rps: 'rps' }[ctx.sub];
        const built = buildPlayers(ctx, ctx.userOpt('opponent'));
        if (built.error) return ctx.fail(built.error);

        const wager = ctx.int('wager', 0);
        const wagerProblem = checkWager(ctx, wager, built.players);
        if (wagerProblem) return ctx.fail(wagerProblem);

        const state = manager.get(key).start({
          difficulty: ctx.str('difficulty', 'hard'),
          bestOf: ctx.int('rounds', 3),
        });

        await launch(ctx, key, { players: built.players, state, wager });

        if (built.players[1].bot) return;
        return ctx.i.followUp({
          content: `<@${built.players[1].id}>, you have been challenged.`,
          allowedMentions: { users: [built.players[1].id] },
        });
      }

      // ---------- solo and group games ----------
      case 'hangman': {
        const custom = ctx.str('word');
        if (custom) {
          if (!/^[a-zA-Z]{3,20}$/.test(custom)) return ctx.fail('A custom word must be 3–20 letters, no spaces.');
          // The word arrives as a slash-command option, which is only visible to
          // the person who typed it - so setting one does not leak it.
        }
        const state = manager.get('hm').start({ word: custom });
        return launch(ctx, 'hm', { players: [{ id: ctx.user.id, tag: ctx.user.tag }], state });
      }

      case 'wordle': {
        const state = manager.get('wd').start({ hardMode: ctx.bool('hard') });
        return launch(ctx, 'wd', { players: [{ id: ctx.user.id, tag: ctx.user.tag }], state });
      }

      case 'minesweeper': {
        const difficulty = ctx.str('difficulty', 'medium');

        if (ctx.bool('spoiler')) {
          const preset = minesweeper.DIFFICULTIES[difficulty] || minesweeper.DIFFICULTIES.medium;
          // The spoiler grid is bigger than the interactive one, since it is not
          // limited by Discord's five-by-five component grid.
          const size = { easy: 6, medium: 8, hard: 10 }[difficulty] || 8;
          const mines = Math.round(size * size * (preset.mines / 25));
          return ctx.send({
            embeds: [
              embeds
                .base(
                  'Minesweeper',
                  `${size}×${size}, ${mines} mines. Click the spoilers to reveal.\n\n${minesweeper.renderSpoiler(size, mines)}`,
                )
                .setFooter({ text: 'Static grid — use /game minesweeper without spoiler for the playable version' }),
            ],
          });
        }

        const state = manager.get('ms').start({ difficulty });
        return launch(ctx, 'ms', { players: [{ id: ctx.user.id, tag: ctx.user.tag }], state });
      }

      case 'blackjack':
      case 'slots': {
        const key = ctx.sub === 'blackjack' ? 'bj' : 'sl';
        const wager = ctx.int('wager', 0);
        const players = [{ id: ctx.user.id, tag: ctx.user.tag }];

        const problem = checkWager(ctx, wager, players);
        if (problem) return ctx.fail(problem);

        // Blackjack takes the stake up front; slots take it per spin.
        if (key === 'bj' && wager) {
          if (!ctx.bot.features.economy.take(ctx.i.guildId, ctx.user.id, wager)) {
            return ctx.fail('You could not cover that wager.');
          }
        }

        const state = manager.get(key).start({ wager });
        const session = await launch(ctx, key, { players, state, wager });

        // A natural blackjack is decided before the player can act, so settle it
        // immediately rather than showing an unusable board.
        if (key === 'bj' && state.result === 'natural') {
          await manager.get('bj').settle(session, manager);
          manager.end(session.id);
          await ctx.i.editReply(manager.get('bj').render(session));
        }
        return session;
      }

      case 'trivia': {
        const state = manager.get('tv').start({
          category: ctx.str('category'),
          difficulty: ctx.str('difficulty'),
          rounds: ctx.int('rounds', 1),
        });
        return launch(ctx, 'tv', { players: [{ id: ctx.user.id, tag: ctx.user.tag }], state });
      }

      case 'guess': {
        const state = manager.get('gs').start({ difficulty: ctx.str('difficulty', 'medium') });
        return launch(ctx, 'gs', { players: [{ id: ctx.user.id, tag: ctx.user.tag }], state });
      }

      case 'stats': {
        const record = ctx.record();
        const g = record.games;
        const total = g.played || 0;
        const winRate = total ? Math.round((g.won / total) * 100) : 0;

        const embed = embeds
          .base(`${ctx.user.username}'s game record`)
          .setThumbnail(ctx.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: 'Played', value: number(total), inline: true },
            { name: 'Won', value: number(g.won), inline: true },
            { name: 'Lost', value: number(g.lost), inline: true },
            { name: 'Drawn', value: number(g.drawn), inline: true },
            { name: 'Win rate', value: `${winRate}%`, inline: true },
          );

        if (record.gambling.wagered) {
          const net = record.gambling.won - record.gambling.lost;
          embed.addFields({
            name: 'Gambling',
            value: [
              `Wagered: ${number(record.gambling.wagered)}`,
              `Net: ${net >= 0 ? '+' : ''}${number(net)}`,
              net < 0 ? '\nThe house edge is doing its job.' : '',
            ].join('\n'),
          });
        }

        const active = manager.snapshot();
        embed.setFooter({ text: `${active.active} game session(s) running right now` });
        return ctx.send({ embeds: [embed] });
      }

      default:
        return ctx.fail('Unknown game.');
    }
  },
};

void rng;
module.exports = game;
