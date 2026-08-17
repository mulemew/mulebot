'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../util/embeds');
const components = require('../util/components');
const rng = require('../util/random');
const bank = require('../data/trivia');
const { number, progressBar } = require('../util/text');
const { relative } = require('../util/time');

/**
 * Trivia, single question or multi-round.
 *
 * Everyone in the channel can answer, once each. The scoreboard is kept on the
 * session, and the question closes either when the timer expires or when every
 * participant has answered - waiting out a full timer after everyone has voted
 * makes a quiz feel much slower than it is.
 *
 * Answers are shuffled per question, and the correct index is stored rather
 * than the text, so a duplicate option string cannot break the grading.
 */

const LETTERS = ['🇦', '🇧', '🇨', '🇩'];

function buildQuestion({ category, difficulty }) {
  const pool = bank.filter({ category, difficulty });
  const question = rng.pick(pool.length ? pool : bank.QUESTIONS);
  const options = rng.shuffle(question.a.map((text, index) => ({ text, correct: index === 0 })));
  return {
    prompt: question.q,
    options,
    correctIndex: options.findIndex((o) => o.correct),
    category: question.c,
    difficulty: question.d,
    points: bank.POINTS[question.d] || 10,
    endsAt: Date.now() + (bank.TIME_LIMIT[question.d] || 25) * 1000,
  };
}

module.exports = {
  name: 'tv',
  title: 'Trivia',
  openToAll: true,

  start({ category = null, difficulty = null, rounds = 1 } = {}) {
    return {
      category,
      difficulty,
      rounds: Math.min(10, Math.max(1, rounds)),
      round: 1,
      question: buildQuestion({ category, difficulty }),
      answers: {}, // userId -> chosen index
      scores: {}, // userId -> points
      closed: false,
      finished: false,
    };
  },

  render(session) {
    const { state } = session;
    const q = state.question;
    const answered = Object.keys(state.answers).length;

    const lines = q.options.map((option, index) => {
      if (!state.closed) return `${LETTERS[index]} ${option.text}`;
      const mark = index === q.correctIndex ? '✅' : '❌';
      const votes = Object.values(state.answers).filter((a) => a === index).length;
      return `${mark} ${option.text} — ${votes} vote(s)`;
    });

    const header = state.rounds > 1 ? `Round ${state.round} of ${state.rounds}` : `${q.category} · ${q.difficulty}`;

    const embed = embeds
      .base(
        `Trivia — ${header}`,
        [
          `**${q.prompt}**`,
          '',
          lines.join('\n'),
          '',
          state.closed
            ? `The answer was **${q.options[q.correctIndex].text}**.`
            : `${answered} answered · closes ${relative(q.endsAt)} · worth ${q.points} points`,
        ].join('\n'),
        state.closed ? embeds.theme.info : embeds.theme.primary,
      )
      .setFooter({ text: `${q.category} · ${q.difficulty}` });

    if (state.closed) {
      const board = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
      if (board.length) {
        embed.addFields({
          name: 'Scores',
          value: board
            .slice(0, 10)
            .map(([userId, points], i) => `${i + 1}. <@${userId}> — **${number(points)}**`)
            .join('\n'),
        });
      }
    }

    if (state.finished) return { embeds: [embed], components: [] };

    if (state.closed) {
      // Between rounds, only the host advances, so a fast clicker cannot skip
      // the answer reveal for everyone else.
      return {
        embeds: [embed],
        components: [
          components.buttonRow({
            id: components.customId('g', 'tv', 'next', session.id),
            label: state.round >= state.rounds ? 'Finish' : 'Next question',
            emoji: '➡️',
            style: 'Primary',
          }),
        ],
      };
    }

    const buttons = q.options.map((option, index) => ({
      id: components.customId('g', 'tv', 'answer', session.id, String(index)),
      emoji: LETTERS[index],
      style: 'Secondary',
    }));
    buttons.push({
      id: components.customId('g', 'tv', 'close', session.id),
      label: 'Reveal',
      emoji: '⏱️',
      style: 'Danger',
    });

    return { embeds: [embed], components: components.rows(buttons) };
  },

  async action(session, interaction, { action, extra, manager }) {
    const { state } = session;

    if (action === 'answer') {
      if (state.closed) {
        await interaction.reply({ content: 'This question is closed.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return { handled: true };
      }
      if (interaction.user.id in state.answers) {
        await interaction
          .reply({ content: 'You already answered this one.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return { handled: true };
      }

      const index = Number(extra[0]);
      state.answers[interaction.user.id] = index;

      const correct = index === state.question.correctIndex;
      if (correct) {
        state.scores[interaction.user.id] = (state.scores[interaction.user.id] || 0) + state.question.points;
      }

      // Feedback goes only to the answerer, so nobody can read the room.
      await interaction
        .reply({
          content: correct ? `Locked in. That is correct — +${state.question.points}.` : 'Locked in.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});

      // Refresh the public message so the "N answered" counter moves.
      await interaction.message.edit(module.exports.render(session)).catch(() => {});
      return { handled: true };
    }

    if (action === 'close') {
      if (interaction.user.id !== session.players[0].id) {
        await interaction
          .reply({ content: 'Only the person who started the quiz can reveal early.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return { handled: true };
      }
      state.closed = true;
      await module.exports.award(session, manager);
      return {};
    }

    if (action === 'next') {
      if (interaction.user.id !== session.players[0].id) {
        await interaction
          .reply({ content: 'Only the quiz host can advance.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return { handled: true };
      }
      if (state.round >= state.rounds) {
        state.finished = true;
        return { finished: true };
      }
      state.round++;
      state.question = buildQuestion({ category: state.category, difficulty: state.difficulty });
      state.answers = {};
      state.closed = false;
      return {};
    }

    return {};
  },

  /** Credits the economy for correct answers in this round. */
  async award(session, manager) {
    if (!session.guildId) return;
    const economy = manager.bot.features.economy;
    const enabled = manager.bot.db.settings(session.guildId).economy.enabled;

    for (const [userId, index] of Object.entries(session.state.answers)) {
      const correct = index === session.state.question.correctIndex;
      manager.recordResult(session.guildId, userId, correct ? 'win' : 'loss');
      if (correct && economy && enabled) {
        economy.add(session.guildId, userId, session.state.question.points * 4);
      }
    }
  },

  buildQuestion,
  LETTERS,
  progressBar,
};
