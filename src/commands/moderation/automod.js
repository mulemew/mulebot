'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const { RULE_ORDER } = require('../../features/automod');
const { truncate, humanList, number } = require('../../util/text');

/**
 * /automod — configure the message filters.
 *
 * Every rule shares the same shape (enabled + action + a couple of parameters),
 * which means one generic `rule` subcommand can configure all twelve rather
 * than twelve near-identical subcommands. The trade-off is that the parameter
 * option is generic, so the command explains per rule what it means.
 */

const ACTIONS = [
  { name: 'delete the message', value: 'delete' },
  { name: 'delete and warn', value: 'warn' },
  { name: 'delete and time out', value: 'timeout' },
  { name: 'delete and kick', value: 'kick' },
  { name: 'delete and ban', value: 'ban' },
  { name: 'log only', value: 'none' },
];

/** What the numeric parameter means for each rule, shown in the reply. */
const PARAMETER_HELP = {
  mentions: 'maximum mentions allowed in one message (default 5)',
  caps: 'percentage of capital letters that trips it (default 70)',
  spam: 'messages allowed inside the window (default 5)',
  duplicates: 'repeats of the same message allowed (default 3)',
  emoji: 'maximum emoji in one message (default 10)',
  walls: 'maximum lines in one message (default 12)',
  newAccount: 'minimum account age in hours (default 24)',
  invites: 'no parameter — use `allow` to permit specific invite codes',
  links: 'no parameter — use `allow` or `block` for domains',
  words: 'no parameter — use `/automod words` to manage the list',
  zalgo: 'no parameter',
  attachments: 'no parameter — blocked extensions are configured in code',
};

const RULE_DESCRIPTIONS = {
  invites: 'Removes Discord invite links to other servers',
  links: 'Controls which links may be posted',
  mentions: 'Catches mass-mention messages',
  caps: 'Catches SHOUTING',
  spam: 'Catches rapid repeated messages from one member',
  duplicates: 'Catches the same message posted over and over',
  words: 'Blocks a custom word list, with lookalike character normalisation',
  emoji: 'Catches emoji walls',
  zalgo: 'Catches combining-character spam',
  attachments: 'Blocks dangerous file extensions',
  newAccount: 'Flags messages from brand-new accounts',
  walls: 'Catches very tall messages',
};

const automod = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure automatic message filtering')
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn automod on or off entirely')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Show the current automod configuration'))
    .addSubcommand((s) =>
      s
        .setName('rule')
        .setDescription('Enable, disable or tune one rule')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Which rule')
            .setRequired(true)
            .addChoices(...RULE_ORDER.map((r) => ({ name: r, value: r }))),
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('Turn this rule on or off'))
        .addStringOption((o) => o.setName('action').setDescription('What to do when it trips').addChoices(...ACTIONS))
        .addIntegerOption((o) => o.setName('parameter').setDescription('The rule threshold — see /automod status')),
    )
    .addSubcommand((s) =>
      s
        .setName('words')
        .setDescription('Manage the blocked word list')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What to do')
            .setRequired(true)
            .addChoices(
              { name: 'add', value: 'add' },
              { name: 'remove', value: 'remove' },
              { name: 'list', value: 'list' },
              { name: 'clear', value: 'clear' },
            ),
        )
        .addStringOption((o) => o.setName('word').setDescription('The word, for add and remove')),
    )
    .addSubcommand((s) =>
      s
        .setName('exempt')
        .setDescription('Exempt a role, channel or member from automod')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Add or remove the exemption')
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }),
        )
        .addRoleOption((o) => o.setName('role').setDescription('Role to exempt'))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel to exempt'))
        .addUserOption((o) => o.setName('user').setDescription('Member to exempt')),
    )
    .addSubcommand((s) =>
      s
        .setName('escalation')
        .setDescription('Punish repeat offenders automatically')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
        .addIntegerOption((o) => o.setName('strikes').setDescription('Violations before escalating').setMinValue(2).setMaxValue(20))
        .addIntegerOption((o) => o.setName('window').setDescription('Window in minutes').setMinValue(1).setMaxValue(1440))
        .addStringOption((o) => o.setName('action').setDescription('What to do').addChoices(...ACTIONS.slice(2)))
        .addIntegerOption((o) => o.setName('minutes').setDescription('Timeout length, if timing out').setMinValue(1)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'moderation',
  cooldown: 3,
  feature: 'automod',
  userPerms: [PermissionFlagsBits.ManageGuild],
  examples: ['/automod toggle enabled:true', '/automod rule name:invites enabled:true action:delete'],

  async execute(ctx) {
    switch (ctx.sub) {
      case 'toggle': {
        const enabled = ctx.bool('enabled');
        ctx.setSetting('automod.enabled', enabled);

        if (!enabled) return ctx.ok('Automod off', 'No messages will be filtered.');

        const active = Object.entries(ctx.settings.automod.rules).filter(([, r]) => r.enabled);
        return ctx.ok(
          'Automod on',
          active.length
            ? `Active rules: ${humanList(active.map(([name]) => `\`${name}\``))}.`
            : 'No rules are enabled yet — switch one on with `/automod rule`. Nothing will be filtered until you do.',
        );
      }

      case 'status': {
        const settings = ctx.settings.automod;
        const rows = RULE_ORDER.map((name) => {
          const rule = settings.rules[name];
          const state = rule.enabled ? `✅ ${rule.action}` : '⬜ off';
          const detail = [];
          if (rule.limit !== undefined) detail.push(`limit ${rule.limit}`);
          if (rule.percent !== undefined) detail.push(`${rule.percent}%`);
          if (rule.messages !== undefined) detail.push(`${rule.messages}/${rule.seconds}s`);
          if (rule.lines !== undefined) detail.push(`${rule.lines} lines`);
          if (rule.minAgeHours !== undefined) detail.push(`${rule.minAgeHours}h`);
          if (rule.list?.length) detail.push(`${rule.list.length} words`);
          return `\`${name.padEnd(12)}\` ${state}${detail.length ? ` — ${detail.join(', ')}` : ''}`;
        });

        const esc = settings.escalation;
        const embed = embeds
          .base(
            `Automod — ${settings.enabled ? 'enabled' : 'disabled'}`,
            rows.join('\n'),
            settings.enabled ? embeds.theme.success : embeds.theme.neutral,
          )
          .addFields(
            {
              name: 'Escalation',
              value: esc.enabled
                ? `After **${esc.strikes}** violations in ${esc.windowMinutes} minutes → **${esc.action}**${esc.action === 'timeout' ? ` for ${esc.timeoutMinutes}m` : ''}`
                : 'Off',
            },
            {
              name: 'Exemptions',
              value: [
                `Roles: ${settings.exemptRoles.map((r) => `<@&${r}>`).join(' ') || 'none'}`,
                `Channels: ${settings.exemptChannels.map((c) => `<#${c}>`).join(' ') || 'none'}`,
                `Members: ${settings.exemptUsers.length ? number(settings.exemptUsers.length) : 'none'}`,
              ].join('\n'),
            },
          )
          .setFooter({ text: 'Anyone with Manage Messages is always exempt — automod polices members, not staff.' });

        return ctx.send({ embeds: [embed] });
      }

      case 'rule': {
        const name = ctx.str('name');
        const rule = { ...ctx.settings.automod.rules[name] };
        const changes = [];

        const enabled = ctx.i.options.getBoolean('enabled');
        if (enabled !== null) {
          rule.enabled = enabled;
          changes.push(`enabled: **${enabled}**`);
        }

        const action = ctx.str('action');
        if (action) {
          rule.action = action;
          changes.push(`action: **${action}**`);
        }

        const parameter = ctx.i.options.getInteger('parameter');
        if (parameter !== null) {
          // Each rule stores its threshold under a different key; map it here so
          // the user only has to think about one "parameter".
          const key = {
            mentions: 'limit',
            emoji: 'limit',
            caps: 'percent',
            spam: 'messages',
            duplicates: 'limit',
            walls: 'lines',
            newAccount: 'minAgeHours',
          }[name];

          if (!key) {
            return ctx.fail(`The **${name}** rule has no numeric parameter. ${PARAMETER_HELP[name]}`);
          }
          rule[key] = parameter;
          changes.push(`${key}: **${parameter}**`);
        }

        if (!changes.length) {
          return ctx.send({
            embeds: [
              embeds
                .base(`Rule: ${name}`, RULE_DESCRIPTIONS[name])
                .addFields(
                  { name: 'State', value: rule.enabled ? `enabled → ${rule.action}` : 'disabled', inline: true },
                  { name: 'Parameter', value: PARAMETER_HELP[name] },
                )
                .setFooter({ text: 'Pass enabled, action or parameter to change it.' }),
            ],
          });
        }

        ctx.setSetting(`automod.rules.${name}`, rule);

        const warning =
          rule.enabled && !ctx.settings.automod.enabled
            ? '\n\n⚠️ Automod itself is still off — run `/automod toggle enabled:true`.'
            : '';

        return ctx.ok(`Rule updated: ${name}`, `${changes.join('\n')}${warning}`);
      }

      case 'words': {
        const action = ctx.str('action');
        const rule = { ...ctx.settings.automod.rules.words };
        rule.list ??= [];

        if (action === 'list') {
          if (!rule.list.length) return ctx.whisper('The blocked word list is empty.');
          // The list is only ever shown ephemerally: printing it into a channel
          // publishes exactly the words the server is trying to suppress.
          return ctx.whisper({
            embeds: [
              embeds
                .base(`Blocked words (${rule.list.length})`, truncate(rule.list.map((w) => `\`${w}\``).join(', '), 4000))
                .setFooter({ text: 'Only you can see this.' }),
            ],
          });
        }

        if (action === 'clear') {
          const count = rule.list.length;
          rule.list = [];
          ctx.setSetting('automod.rules.words', rule);
          return ctx.ok('Word list cleared', `Removed ${count} word(s).`, { ephemeral: true });
        }

        const word = ctx.str('word')?.trim().toLowerCase();
        if (!word) return ctx.fail('Provide a word with the `word` option.');

        if (action === 'add') {
          if (rule.list.includes(word)) return ctx.fail('That word is already on the list.');
          if (rule.list.length >= 500) return ctx.fail('The list is capped at 500 words.');
          rule.list.push(word);
          ctx.setSetting('automod.rules.words', rule);
          return ctx.ok(
            'Word added',
            `The list now has ${rule.list.length} word(s).\n\nMatching normalises lookalikes, so \`fr33\` and \`f-r-e-e\` both match \`free\`.`,
            { ephemeral: true },
          );
        }

        const before = rule.list.length;
        rule.list = rule.list.filter((w) => w !== word);
        if (rule.list.length === before) return ctx.fail('That word is not on the list.');
        ctx.setSetting('automod.rules.words', rule);
        return ctx.ok('Word removed', `The list now has ${rule.list.length} word(s).`, { ephemeral: true });
      }

      case 'exempt': {
        const action = ctx.str('action');
        const role = ctx.roleOpt('role');
        const channel = ctx.channelOpt('channel');
        const user = ctx.userOpt('user');

        if (action === 'list') {
          const s = ctx.settings.automod;
          return ctx.send({
            embeds: [
              embeds
                .base('Automod exemptions')
                .addFields(
                  { name: 'Roles', value: s.exemptRoles.map((r) => `<@&${r}>`).join('\n') || 'none' },
                  { name: 'Channels', value: s.exemptChannels.map((c) => `<#${c}>`).join('\n') || 'none' },
                  { name: 'Members', value: s.exemptUsers.map((u) => `<@${u}>`).join('\n') || 'none' },
                ),
            ],
          });
        }

        if (!role && !channel && !user) return ctx.fail('Pick a role, channel or member to exempt.');

        const apply = (key, id, label) => {
          const list = [...ctx.settings.automod[key]];
          const index = list.indexOf(id);
          if (action === 'add') {
            if (index !== -1) return `${label} is already exempt.`;
            list.push(id);
          } else {
            if (index === -1) return `${label} was not exempt.`;
            list.splice(index, 1);
          }
          ctx.setSetting(`automod.${key}`, list);
          return `${label} ${action === 'add' ? 'is now exempt' : 'is no longer exempt'}.`;
        };

        const results = [];
        if (role) results.push(apply('exemptRoles', role.id, `<@&${role.id}>`));
        if (channel) results.push(apply('exemptChannels', channel.id, `<#${channel.id}>`));
        if (user) results.push(apply('exemptUsers', user.id, `<@${user.id}>`));

        return ctx.ok('Exemptions updated', results.join('\n'));
      }

      case 'escalation': {
        const esc = { ...ctx.settings.automod.escalation };
        const changes = [];

        const enabled = ctx.i.options.getBoolean('enabled');
        if (enabled !== null) {
          esc.enabled = enabled;
          changes.push(`enabled: **${enabled}**`);
        }
        const strikes = ctx.i.options.getInteger('strikes');
        if (strikes !== null) {
          esc.strikes = strikes;
          changes.push(`strikes: **${strikes}**`);
        }
        const window = ctx.i.options.getInteger('window');
        if (window !== null) {
          esc.windowMinutes = window;
          changes.push(`window: **${window} minutes**`);
        }
        const action = ctx.str('action');
        if (action) {
          esc.action = action;
          changes.push(`action: **${action}**`);
        }
        const minutes = ctx.i.options.getInteger('minutes');
        if (minutes !== null) {
          esc.timeoutMinutes = minutes;
          changes.push(`timeout: **${minutes} minutes**`);
        }

        if (!changes.length) {
          return ctx.send({
            embeds: [
              embeds.base(
                'Escalation',
                esc.enabled
                  ? `After **${esc.strikes}** automod violations within **${esc.windowMinutes} minutes**, the member is **${esc.action}**${esc.action === 'timeout' ? ` for ${esc.timeoutMinutes} minutes` : ''}.`
                  : 'Escalation is off. A member can trip automod indefinitely without further consequence.',
              ),
            ],
          });
        }

        ctx.setSetting('automod.escalation', esc);
        return ctx.ok('Escalation updated', changes.join('\n'));
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

module.exports = automod;
