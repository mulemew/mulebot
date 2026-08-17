'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, AttachmentBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const i18n = require('../../core/i18n');
const { DEFAULT_GUILD } = require('../../core/db');
const { parseDuration, formatDuration } = require('../../util/time');
const { truncate, number, humanList } = require('../../util/text');

/**
 * /config — every per-server setting, grouped by feature.
 *
 * One command with subcommand groups rather than a dozen top-level commands.
 * Discord caps an application at 100 commands and configuration is the easiest
 * way to burn through that; grouping also means an admin who types `/config`
 * discovers everything the bot can do without reading documentation.
 *
 * Two conventions run through the whole file:
 *   - every toggle reports what is *still* missing before the feature will
 *     actually do anything, because "I enabled it and nothing happened" is the
 *     most common support question a configurable bot generates
 *   - nothing is silently clamped; a rejected value says why
 */

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Builds a consistent "here is what is left to do" hint. */
function missingHint(pairs) {
  const missing = pairs.filter(([, ok]) => !ok).map(([label]) => label);
  if (!missing.length) return null;
  return `⚠️ Still needed: ${humanList(missing)}.`;
}

const config = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the bot for this server')

    // ---------- general ----------
    .addSubcommandGroup((g) =>
      g
        .setName('general')
        .setDescription('Language, prefix and overall settings')
        .addSubcommand((s) => s.setName('view').setDescription('Show every current setting'))
        .addSubcommand((s) =>
          s
            .setName('language')
            .setDescription('Language for the bot\'s own messages')
            .addStringOption((o) =>
              o
                .setName('locale')
                .setDescription('Which language')
                .setRequired(true)
                .addChoices({ name: 'English', value: 'en' }, { name: '简体中文', value: 'zh-CN' }),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('prefix')
            .setDescription('Prefix for legacy text commands')
            .addStringOption((o) => o.setName('prefix').setDescription('1-5 characters, e.g. ! or ?').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('timezone')
            .setDescription('Hour offset from UTC, used for daily resets')
            .addIntegerOption((o) =>
              o.setName('offset').setDescription('e.g. 8 for UTC+8').setRequired(true).setMinValue(-12).setMaxValue(14),
            ),
        )
        .addSubcommand((s) => s.setName('export').setDescription('Download this server\'s settings as JSON'))
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Reset settings back to defaults')
            .addStringOption((o) =>
              o.setName('confirm').setDescription('Type the server name to confirm').setRequired(true),
            ),
        ),
    )

    // ---------- welcome ----------
    .addSubcommandGroup((g) =>
      g
        .setName('welcome')
        .setDescription('Greeting new members')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn welcome messages on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('channel')
            .setDescription('Where to post the welcome')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Target channel').addChannelTypes(...CHANNEL_TYPES).setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('message')
            .setDescription('The welcome text')
            .addStringOption((o) =>
              o.setName('text').setDescription('Use {user} {tag} {server} {count}').setRequired(true),
            )
            .addBooleanOption((o) => o.setName('embed').setDescription('Send it as an embed')),
        )
        .addSubcommand((s) =>
          s
            .setName('dm')
            .setDescription('Also send a direct message to new members')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
            .addStringOption((o) => o.setName('text').setDescription('The DM text')),
        )
        .addSubcommand((s) =>
          s
            .setName('goodbye')
            .setDescription('Announce when members leave')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
            .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(...CHANNEL_TYPES))
            .addStringOption((o) => o.setName('text').setDescription('Use {tag} {count}')),
        )
        .addSubcommand((s) => s.setName('test').setDescription('Preview the welcome message on yourself')),
    )

    // ---------- autorole ----------
    .addSubcommandGroup((g) =>
      g
        .setName('autorole')
        .setDescription('Roles given automatically on join')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn autorole on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a role to give on join')
            .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true))
            .addBooleanOption((o) => o.setName('bots').setDescription('Give this to joining bots instead')),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Stop giving a role on join')
            .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('delay')
            .setDescription('Wait before granting, which defeats some raid bots')
            .addStringOption((o) => o.setName('duration').setDescription('e.g. 30s, 5m. Use 0 for immediate').setRequired(true)),
        ),
    )

    // ---------- logging ----------
    .addSubcommandGroup((g) =>
      g
        .setName('logging')
        .setDescription('Server audit log')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn logging on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('channel')
            .setDescription('Where log entries go')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Log channel').addChannelTypes(...CHANNEL_TYPES).setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('event')
            .setDescription('Turn one event category on or off')
            .addStringOption((o) =>
              o
                .setName('name')
                .setDescription('Which event')
                .setRequired(true)
                .addChoices(
                  { name: 'message deletes', value: 'messageDelete' },
                  { name: 'message edits', value: 'messageUpdate' },
                  { name: 'bulk deletes', value: 'messageBulkDelete' },
                  { name: 'member joins', value: 'memberJoin' },
                  { name: 'member leaves', value: 'memberLeave' },
                  { name: 'member updates', value: 'memberUpdate' },
                  { name: 'bans', value: 'memberBan' },
                  { name: 'unbans', value: 'memberUnban' },
                  { name: 'timeouts', value: 'memberTimeout' },
                  { name: 'role changes', value: 'roleUpdate' },
                  { name: 'channel changes', value: 'channelUpdate' },
                  { name: 'voice activity', value: 'voiceJoin' },
                  { name: 'command usage', value: 'commandUse' },
                  { name: 'automod', value: 'automod' },
                ),
            )
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('ignore')
            .setDescription('Never log activity from a channel or member')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel to ignore'))
            .addUserOption((o) => o.setName('user').setDescription('Member to ignore'))
            .addBooleanOption((o) => o.setName('remove').setDescription('Stop ignoring instead')),
        ),
    )

    // ---------- leveling ----------
    .addSubcommandGroup((g) =>
      g
        .setName('leveling')
        .setDescription('XP and levels')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn levelling on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('rate')
            .setDescription('How much XP a message is worth')
            .addIntegerOption((o) => o.setName('min').setDescription('Minimum per message').setRequired(true).setMinValue(1).setMaxValue(500))
            .addIntegerOption((o) => o.setName('max').setDescription('Maximum per message').setRequired(true).setMinValue(1).setMaxValue(500))
            .addIntegerOption((o) => o.setName('cooldown').setDescription('Seconds between awards').setMinValue(0).setMaxValue(3600)),
        )
        .addSubcommand((s) =>
          s
            .setName('announce')
            .setDescription('Level-up announcements')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
            .addChannelOption((o) => o.setName('channel').setDescription('Where to announce, empty means the active channel').addChannelTypes(...CHANNEL_TYPES))
            .addStringOption((o) => o.setName('message').setDescription('Use {user} {level}')),
        )
        .addSubcommand((s) =>
          s
            .setName('reward')
            .setDescription('Give a role at a level')
            .addIntegerOption((o) => o.setName('level').setDescription('The level').setRequired(true).setMinValue(1).setMaxValue(500))
            .addRoleOption((o) => o.setName('role').setDescription('The role to grant').setRequired(true))
            .addBooleanOption((o) => o.setName('remove').setDescription('Remove this reward instead')),
        )
        .addSubcommand((s) =>
          s
            .setName('ignore')
            .setDescription('Stop a channel or role from earning XP')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel to exclude'))
            .addRoleOption((o) => o.setName('role').setDescription('Role to exclude'))
            .addBooleanOption((o) => o.setName('remove').setDescription('Stop excluding instead')),
        )
        .addSubcommand((s) =>
          s
            .setName('voice')
            .setDescription('Earn XP for time spent in voice')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
            .addIntegerOption((o) => o.setName('per_minute').setDescription('XP per minute').setMinValue(1).setMaxValue(100)),
        ),
    )

    // ---------- economy ----------
    .addSubcommandGroup((g) =>
      g
        .setName('economy')
        .setDescription('Currency and payouts')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn the economy on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('currency')
            .setDescription('Name and symbol of the currency')
            .addStringOption((o) => o.setName('symbol').setDescription('An emoji or short symbol').setRequired(true))
            .addStringOption((o) => o.setName('name').setDescription('What one unit is called')),
        )
        .addSubcommand((s) =>
          s
            .setName('rates')
            .setDescription('Payout amounts and cooldowns')
            .addStringOption((o) =>
              o
                .setName('command')
                .setDescription('Which payout')
                .setRequired(true)
                .addChoices(
                  { name: 'daily', value: 'daily' },
                  { name: 'weekly', value: 'weekly' },
                  { name: 'work', value: 'work' },
                  { name: 'crime', value: 'crime' },
                ),
            )
            .addIntegerOption((o) => o.setName('min').setDescription('Minimum payout').setMinValue(0))
            .addIntegerOption((o) => o.setName('max').setDescription('Maximum payout').setMinValue(0))
            .addIntegerOption((o) => o.setName('cooldown').setDescription('Cooldown in minutes').setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName('limits')
            .setDescription('Betting and robbery limits')
            .addIntegerOption((o) => o.setName('max_bet').setDescription('Largest allowed wager').setMinValue(1))
            .addIntegerOption((o) => o.setName('rob_chance').setDescription('Robbery success chance, percent').setMinValue(0).setMaxValue(100))
            .addIntegerOption((o) => o.setName('interest').setDescription('Daily bank interest, percent').setMinValue(0).setMaxValue(20)),
        )
        .addSubcommand((s) =>
          s
            .setName('drops')
            .setDescription('Random coin drops on messages')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
            .addIntegerOption((o) => o.setName('chance').setDescription('Percent chance per message').setMinValue(1).setMaxValue(100)),
        )
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Wipe balances')
            .addUserOption((o) => o.setName('user').setDescription('One member, or leave empty for everyone')),
        ),
    )

    // ---------- starboard ----------
    .addSubcommandGroup((g) =>
      g
        .setName('starboard')
        .setDescription('Highlight popular messages')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn the starboard on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('setup')
            .setDescription('Channel, emoji and threshold')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Where featured messages go').addChannelTypes(...CHANNEL_TYPES).setRequired(true),
            )
            .addStringOption((o) => o.setName('emoji').setDescription('Which reaction counts, default ⭐'))
            .addIntegerOption((o) => o.setName('threshold').setDescription('How many reactions are needed').setMinValue(1).setMaxValue(100)),
        )
        .addSubcommand((s) =>
          s
            .setName('options')
            .setDescription('Fine tuning')
            .addBooleanOption((o) => o.setName('self_star').setDescription('Let authors star their own messages'))
            .addBooleanOption((o) => o.setName('ignore_bots').setDescription('Ignore messages from bots'))
            .addChannelOption((o) => o.setName('ignore_channel').setDescription('Never feature messages from here')),
        ),
    )

    // ---------- tickets ----------
    .addSubcommandGroup((g) =>
      g
        .setName('tickets')
        .setDescription('Private support channels')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn tickets on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('setup')
            .setDescription('Category, staff role and transcripts')
            .addChannelOption((o) =>
              o.setName('category').setDescription('Category for new tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
            )
            .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see every ticket'))
            .addChannelOption((o) => o.setName('transcripts').setDescription('Where closed transcripts are archived').addChannelTypes(...CHANNEL_TYPES)),
        )
        .addSubcommand((s) =>
          s
            .setName('message')
            .setDescription('The greeting inside a new ticket')
            .addStringOption((o) => o.setName('text').setDescription('Shown when a ticket opens').setRequired(true)),
        ),
    )

    // ---------- suggestions ----------
    .addSubcommandGroup((g) =>
      g
        .setName('suggestions')
        .setDescription('Member suggestion board')
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn suggestions on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('channel')
            .setDescription('Where suggestions are posted')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Suggestion channel').addChannelTypes(...CHANNEL_TYPES).setRequired(true),
            )
            .addBooleanOption((o) => o.setName('threads').setDescription('Open a discussion thread per suggestion')),
        ),
    )

    // ---------- counting ----------
    .addSubcommandGroup((g) =>
      g
        .setName('counting')
        .setDescription('The counting channel game')
        .addSubcommand((s) =>
          s
            .setName('setup')
            .setDescription('Pick the counting channel')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Counting channel').addChannelTypes(...CHANNEL_TYPES).setRequired(true),
            )
            .addBooleanOption((o) => o.setName('reset_on_fail').setDescription('Reset to 1 when someone gets it wrong')),
        )
        .addSubcommand((s) =>
          s
            .setName('toggle')
            .setDescription('Turn counting on or off')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Set the count back to zero')
            .addBooleanOption((o) => o.setName('clear_record').setDescription('Also clear the server record')),
        ),
    )

    // ---------- moderation ----------
    .addSubcommandGroup((g) =>
      g
        .setName('moderation')
        .setDescription('Moderation behaviour')
        .addSubcommand((s) =>
          s
            .setName('options')
            .setDescription('DM behaviour, log channel and appeal link')
            .addBooleanOption((o) => o.setName('dm_on_punish').setDescription('Tell members why they were punished'))
            .addChannelOption((o) => o.setName('log_channel').setDescription('Where cases are posted').addChannelTypes(...CHANNEL_TYPES))
            .addStringOption((o) => o.setName('appeal_link').setDescription('Link shown in punishment DMs')),
        )
        .addSubcommand((s) =>
          s
            .setName('threshold')
            .setDescription('Punish automatically at a warning count')
            .addIntegerOption((o) => o.setName('warnings').setDescription('Number of warnings').setRequired(true).setMinValue(1).setMaxValue(50))
            .addStringOption((o) =>
              o
                .setName('action')
                .setDescription('What to do')
                .setRequired(true)
                .addChoices(
                  { name: 'timeout 1 hour', value: 'timeout:1h' },
                  { name: 'timeout 1 day', value: 'timeout:1d' },
                  { name: 'timeout 7 days', value: 'timeout:7d' },
                  { name: 'kick', value: 'kick' },
                  { name: 'ban', value: 'ban' },
                  { name: 'remove this threshold', value: 'none' },
                ),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('protect')
            .setDescription('Mark a role as untouchable by moderation commands')
            .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true))
            .addBooleanOption((o) => o.setName('remove').setDescription('Unprotect it instead')),
        ),
    )

    // ---------- commands ----------
    .addSubcommandGroup((g) =>
      g
        .setName('commands')
        .setDescription('Enable or disable individual commands')
        .addSubcommand((s) =>
          s
            .setName('disable')
            .setDescription('Disable a command on this server')
            .addStringOption((o) => o.setName('command').setDescription('Command name').setRequired(true).setAutocomplete(true))
            .addChannelOption((o) => o.setName('channel').setDescription('Only in this channel')),
        )
        .addSubcommand((s) =>
          s
            .setName('enable')
            .setDescription('Re-enable a command')
            .addStringOption((o) => o.setName('command').setDescription('Command name').setRequired(true).setAutocomplete(true))
            .addChannelOption((o) => o.setName('channel').setDescription('Only in this channel')),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Show what is currently disabled')),
    )

    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  category: 'config',
  cooldown: 3,
  userPerms: [PermissionFlagsBits.ManageGuild],
  examples: ['/config general view', '/config welcome toggle enabled:true'],

  async autocomplete(ctx) {
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = ctx.bot.registry
      .all()
      .filter((c) => c.category !== 'config' && c.data.name.includes(focused))
      .slice(0, 25)
      .map((c) => ({ name: `/${c.data.name}`, value: c.data.name }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const group = ctx.group;
    const sub = ctx.sub;
    const handler = handlers[group];
    if (!handler) return ctx.fail('Unknown configuration group.');
    return handler(ctx, sub);
  },
};

// ---------------------------------------------------------------------------
// Group handlers
// ---------------------------------------------------------------------------

const handlers = {};

handlers.general = async (ctx, sub) => {
  switch (sub) {
    case 'view': {
      const s = ctx.settings;
      const onOff = (v) => (v ? '✅ on' : '⬜ off');

      return ctx.send({
        embeds: [
          embeds
            .base(`Configuration — ${ctx.guild.name}`)
            .addFields(
              {
                name: 'General',
                value: [
                  `Language: **${s.locale || ctx.bot.config.defaultLocale}**`,
                  `Text prefix: \`${s.prefix || ctx.bot.config.defaultPrefix}\``,
                  `Timezone: UTC${s.timezoneOffset >= 0 ? '+' : ''}${s.timezoneOffset}`,
                ].join('\n'),
              },
              {
                name: 'Features',
                value: [
                  `Welcome ${onOff(s.welcome.enabled)}${s.welcome.channelId ? ` → <#${s.welcome.channelId}>` : ''}`,
                  `Goodbye ${onOff(s.goodbye.enabled)}`,
                  `Autorole ${onOff(s.autorole.enabled)} (${s.autorole.roleIds.length} role(s))`,
                  `Logging ${onOff(s.logging.enabled)}${s.logging.channelId ? ` → <#${s.logging.channelId}>` : ''}`,
                  `Automod ${onOff(s.automod.enabled)}`,
                  `Levelling ${onOff(s.leveling.enabled)}`,
                  `Economy ${onOff(s.economy.enabled)}`,
                  `Starboard ${onOff(s.starboard.enabled)}`,
                  `Tickets ${onOff(s.tickets.enabled)}`,
                  `Suggestions ${onOff(s.suggestions.enabled)}`,
                  `Counting ${onOff(s.counting.enabled)}${s.counting.enabled ? ` (at ${s.counting.current})` : ''}`,
                  `Auto-responders ${onOff(s.autoresponder.enabled)} (${s.autoresponder.entries.length})`,
                ].join('\n'),
              },
              {
                name: 'Moderation',
                value: [
                  `DM on punish: ${s.moderation.dmOnPunish ? 'yes' : 'no'}`,
                  `Cases recorded: ${number(ctx.db.cases(ctx.i.guildId).length)}`,
                  `Warn thresholds: ${Object.keys(s.moderation.warnThresholds).length || 'none'}`,
                  `Protected roles: ${s.moderation.protectedRoles.length || 'none'}`,
                ].join('\n'),
              },
              {
                name: 'Disabled commands',
                value: s.disabledCommands.length ? s.disabledCommands.map((c) => `\`${c}\``).join(', ') : 'none',
              },
            )
            .setFooter({ text: 'Use /config <group> <setting> to change any of this' }),
        ],
      });
    }

    case 'language': {
      const locale = i18n.resolveLocale(ctx.str('locale'));
      ctx.setSetting('locale', locale);
      const t = i18n.translator(locale);
      return ctx.ok('Language updated', `${t('label.enabled')} — ${locale}\n\n${t('err.guildOnly')}`);
    }

    case 'prefix': {
      const prefix = ctx.str('prefix').trim();
      if (prefix.length < 1 || prefix.length > 5) return ctx.fail('The prefix must be 1–5 characters.');
      if (/\s/.test(prefix)) return ctx.fail('The prefix cannot contain spaces.');

      ctx.setSetting('prefix', prefix);
      const note = ctx.bot.intents.messageContent
        ? ''
        : '\n\n⚠️ Text commands are currently inactive because the MESSAGE CONTENT intent is off in the developer portal.';
      return ctx.ok('Prefix updated', `Text commands now use \`${prefix}\`, e.g. \`${prefix}ping\`.${note}`);
    }

    case 'timezone': {
      const offset = ctx.int('offset');
      ctx.setSetting('timezoneOffset', offset);
      return ctx.ok(
        'Timezone updated',
        `Daily resets now happen at midnight UTC${offset >= 0 ? '+' : ''}${offset}.`,
      );
    }

    case 'export': {
      // Raw stored settings, not the merged defaults: an export should show
      // what this server actually changed, not a dump of every default.
      const raw = ctx.db.rawSettings(ctx.i.guildId);
      const json = JSON.stringify(raw, null, 2);
      const file = new AttachmentBuilder(Buffer.from(json, 'utf8'), {
        name: `config-${ctx.guild.id}-${new Date().toISOString().slice(0, 10)}.json`,
      });
      return ctx.whisper({
        embeds: [
          embeds.base(
            'Settings export',
            `${number(Object.keys(raw).length)} top-level key(s), ${number(json.length)} bytes.\n\nThis contains channel and role IDs only — no message content.`,
          ),
        ],
        files: [file],
      });
    }

    case 'reset': {
      // A destructive action needs a confirmation that cannot be produced by
      // muscle memory, so it asks for the server's own name.
      if (ctx.str('confirm') !== ctx.guild.name) {
        return ctx.fail(
          `To confirm, run the command again with \`confirm:${ctx.guild.name}\`.\n\nThis clears every setting. Member data (XP, balances, cases) is kept.`,
        );
      }
      ctx.db.resetGuild(ctx.i.guildId);
      return ctx.ok('Settings reset', 'Every setting is back to its default. Member data was not touched.');
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.welcome = async (ctx, sub) => {
  const s = ctx.settings.welcome;

  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('welcome.enabled', enabled);
      if (!enabled) return ctx.ok('Welcome messages off', 'New members will be greeted silently.');

      const hint = missingHint([
        ['a channel (`/config welcome channel`)', Boolean(s.channelId)],
        ['the SERVER MEMBERS intent in the developer portal', ctx.bot.intents.members],
      ]);
      return ctx.ok(
        'Welcome messages on',
        [s.channelId ? `Greetings will post in <#${s.channelId}>.` : 'I will auto-detect a general/welcome channel.', hint]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    case 'channel': {
      const channel = ctx.channelOpt('channel');
      const resolved = await ctx.bot.resolveChannel(ctx.guild, channel.id);
      if (!resolved) return ctx.fail(`I cannot post in ${channel}. Check my View Channel and Send Messages permissions there.`);

      ctx.setSetting('welcome.channelId', channel.id);
      return ctx.ok('Welcome channel set', `Greetings will post in ${channel}.`);
    }

    case 'message': {
      const text = ctx.str('text');
      if (text.length > 1500) return ctx.fail('Keep the welcome message under 1500 characters.');
      ctx.setSetting('welcome.message', text);

      const embedOpt = ctx.i.options.getBoolean('embed');
      if (embedOpt !== null) ctx.setSetting('welcome.embed', embedOpt);

      return ctx.ok(
        'Welcome message updated',
        `Preview with \`/config welcome test\`.\n\nPlaceholders: \`{user}\` \`{tag}\` \`{username}\` \`{server}\` \`{count}\``,
      );
    }

    case 'dm': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('welcome.dm', enabled);
      const text = ctx.str('text');
      if (text) ctx.setSetting('welcome.dmMessage', truncate(text, 1500));

      return ctx.ok(
        enabled ? 'Welcome DM on' : 'Welcome DM off',
        enabled
          ? 'New members will get a direct message. Many people have DMs from servers switched off, so treat it as a bonus rather than the main greeting.'
          : 'No direct messages will be sent.',
      );
    }

    case 'goodbye': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('goodbye.enabled', enabled);

      const channel = ctx.channelOpt('channel');
      if (channel) ctx.setSetting('goodbye.channelId', channel.id);
      const text = ctx.str('text');
      if (text) ctx.setSetting('goodbye.message', truncate(text, 1500));

      return ctx.ok(
        enabled ? 'Goodbye messages on' : 'Goodbye messages off',
        enabled
          ? `Departures will post in ${channel || (ctx.settings.goodbye.channelId ? `<#${ctx.settings.goodbye.channelId}>` : 'the welcome channel')}.`
          : 'Departures will not be announced.',
      );
    }

    case 'test': {
      const payload = ctx.bot.features.welcome.buildWelcome(ctx.member, ctx.settings);
      return ctx.whisper({
        content: `**Preview** — this is what a new member sees:\n${payload.content || ''}`,
        embeds: payload.embeds || [],
        allowedMentions: { parse: [] },
      });
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.autorole = async (ctx, sub) => {
  const perms = require('../../util/perms');

  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('autorole.enabled', enabled);
      const hint = missingHint([
        ['at least one role (`/config autorole add`)', ctx.settings.autorole.roleIds.length > 0],
        ['the SERVER MEMBERS intent', ctx.bot.intents.members],
        ['the Manage Roles permission', ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)],
      ]);
      return ctx.ok(enabled ? 'Autorole on' : 'Autorole off', hint || 'Ready to go.');
    }

    case 'add': {
      const role = ctx.roleOpt('role');
      const problem = perms.checkRole(ctx.guild, role);
      if (problem) return ctx.fail(problem);

      const key = ctx.bool('bots') ? 'autorole.botRoleIds' : 'autorole.roleIds';
      const list = [...(ctx.bool('bots') ? ctx.settings.autorole.botRoleIds : ctx.settings.autorole.roleIds)];
      if (list.includes(role.id)) return ctx.fail('That role is already in the list.');
      if (list.length >= 10) return ctx.fail('At most 10 autoroles.');

      list.push(role.id);
      ctx.setSetting(key, list);
      return ctx.ok('Autorole added', `New ${ctx.bool('bots') ? 'bots' : 'members'} will receive <@&${role.id}>.`);
    }

    case 'remove': {
      const role = ctx.roleOpt('role');
      let removed = false;
      for (const key of ['roleIds', 'botRoleIds']) {
        const list = ctx.settings.autorole[key].filter((id) => id !== role.id);
        if (list.length !== ctx.settings.autorole[key].length) {
          ctx.setSetting(`autorole.${key}`, list);
          removed = true;
        }
      }
      if (!removed) return ctx.fail('That role was not configured as an autorole.');
      return ctx.ok('Autorole removed', `<@&${role.id}> will no longer be granted automatically.`);
    }

    case 'delay': {
      const ms = parseDuration(ctx.str('duration'));
      if (ctx.str('duration').trim() === '0') {
        ctx.setSetting('autorole.delaySeconds', 0);
        return ctx.ok('Delay removed', 'Roles are granted immediately on join.');
      }
      if (ms === null) return ctx.tfail('err.badDuration');
      if (ms > 86_400_000) return ctx.fail('The maximum delay is 24 hours.');

      ctx.setSetting('autorole.delaySeconds', Math.round(ms / 1000));
      return ctx.ok(
        'Delay set',
        `Roles are granted ${formatDuration(ms)} after joining. A raid bot that joins and leaves quickly never receives them.`,
      );
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.logging = async (ctx, sub) => {
  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('logging.enabled', enabled);
      const hint = missingHint([['a log channel (`/config logging channel`)', Boolean(ctx.settings.logging.channelId)]]);
      return ctx.ok(enabled ? 'Logging on' : 'Logging off', hint || 'Events will be recorded.');
    }

    case 'channel': {
      const channel = ctx.channelOpt('channel');
      const resolved = await ctx.bot.resolveChannel(ctx.guild, channel.id);
      if (!resolved) return ctx.fail(`I cannot post in ${channel}.`);
      ctx.setSetting('logging.channelId', channel.id);
      return ctx.ok(
        'Log channel set',
        `Entries go to ${channel}.\n\nActivity inside that channel is never logged, so there is no feedback loop.`,
      );
    }

    case 'event': {
      const name = ctx.str('name');
      const enabled = ctx.bool('enabled');

      // The voice choice covers three related events at once, since nobody
      // wants to toggle join, leave and move separately.
      const keys = name === 'voiceJoin' ? ['voiceJoin', 'voiceLeave', 'voiceMove'] : [name];
      for (const key of keys) ctx.setSetting(`logging.events.${key}`, enabled);

      return ctx.ok('Event updated', `\`${keys.join('`, `')}\` → **${enabled ? 'logged' : 'ignored'}**`);
    }

    case 'ignore': {
      const channel = ctx.channelOpt('channel');
      const user = ctx.userOpt('user');
      const remove = ctx.bool('remove');
      if (!channel && !user) return ctx.fail('Pick a channel or a member.');

      const results = [];
      if (channel) {
        const list = [...ctx.settings.logging.ignoredChannels];
        const index = list.indexOf(channel.id);
        if (remove) {
          if (index === -1) results.push(`${channel} was not ignored.`);
          else {
            list.splice(index, 1);
            results.push(`${channel} is logged again.`);
          }
        } else if (index !== -1) results.push(`${channel} is already ignored.`);
        else {
          list.push(channel.id);
          results.push(`${channel} will be ignored.`);
        }
        ctx.setSetting('logging.ignoredChannels', list);
      }
      if (user) {
        const list = [...ctx.settings.logging.ignoredUsers];
        const index = list.indexOf(user.id);
        if (remove) {
          if (index !== -1) list.splice(index, 1);
          results.push(`<@${user.id}> is logged again.`);
        } else if (index === -1) {
          list.push(user.id);
          results.push(`<@${user.id}> will be ignored.`);
        } else results.push(`<@${user.id}> is already ignored.`);
        ctx.setSetting('logging.ignoredUsers', list);
      }

      return ctx.ok('Ignore list updated', results.join('\n'));
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.leveling = async (ctx, sub) => {
  const perms = require('../../util/perms');

  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('leveling.enabled', enabled);
      if (!enabled) return ctx.ok('Levelling off', 'XP is no longer awarded. Existing XP is kept.');

      const hint = missingHint([['the MESSAGE CONTENT intent', ctx.bot.intents.messageContent]]);
      return ctx.ok(
        'Levelling on',
        [
          `Members earn ${ctx.settings.leveling.xpPerMessage.join('–')} XP per message, at most once every ${ctx.settings.leveling.cooldownSeconds}s.`,
          hint,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    case 'rate': {
      const min = ctx.int('min');
      const max = ctx.int('max');
      if (min > max) return ctx.fail('The minimum cannot be larger than the maximum.');

      ctx.setSetting('leveling.xpPerMessage', [min, max]);
      const cooldown = ctx.i.options.getInteger('cooldown');
      if (cooldown !== null) ctx.setSetting('leveling.cooldownSeconds', cooldown);

      const leveling = ctx.bot.features.leveling;
      const average = (min + max) / 2;
      const toTen = leveling.totalXpFor(10);
      return ctx.ok(
        'XP rate updated',
        [
          `**${min}–${max}** XP per message, at most once every **${ctx.settings.leveling.cooldownSeconds}s**.`,
          '',
          `At that rate, level 10 takes roughly **${Math.round(toTen / average)}** qualifying messages.`,
        ].join('\n'),
      );
    }

    case 'announce': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('leveling.announce', enabled);

      const channel = ctx.channelOpt('channel');
      if (channel) ctx.setSetting('leveling.announceChannelId', channel.id);
      const message = ctx.str('message');
      if (message) ctx.setSetting('leveling.announceMessage', truncate(message, 500));

      return ctx.ok(
        enabled ? 'Level-up announcements on' : 'Level-up announcements off',
        enabled
          ? `Posted in ${channel ? `${channel}` : 'the channel where the level-up happened'}.\nPlaceholders: \`{user}\` \`{level}\` \`{server}\``
          : 'Members level up silently. Reward roles are still granted.',
      );
    }

    case 'reward': {
      const level = ctx.int('level');
      const role = ctx.roleOpt('role');
      const rewards = { ...ctx.settings.leveling.rewards };

      if (ctx.bool('remove')) {
        const list = (rewards[String(level)] || []).filter((id) => id !== role.id);
        if (list.length) rewards[String(level)] = list;
        else delete rewards[String(level)];
        ctx.setSetting('leveling.rewards', rewards);
        return ctx.ok('Reward removed', `<@&${role.id}> is no longer granted at level ${level}.`);
      }

      const problem = perms.checkRole(ctx.guild, role);
      if (problem) return ctx.fail(problem);

      rewards[String(level)] = [...new Set([...(rewards[String(level)] || []), role.id])];
      ctx.setSetting('leveling.rewards', rewards);

      const all = Object.keys(rewards)
        .map(Number)
        .sort((a, b) => a - b)
        .map((l) => `**${l}** → ${rewards[String(l)].map((id) => `<@&${id}>`).join(' ')}`);

      return ctx.ok('Reward added', `Members reaching level **${level}** get <@&${role.id}>.\n\n${all.join('\n')}`);
    }

    case 'ignore': {
      const channel = ctx.channelOpt('channel');
      const role = ctx.roleOpt('role');
      const remove = ctx.bool('remove');
      if (!channel && !role) return ctx.fail('Pick a channel or a role.');

      const results = [];
      if (channel) {
        const list = [...ctx.settings.leveling.noXpChannels];
        const index = list.indexOf(channel.id);
        if (remove && index !== -1) list.splice(index, 1);
        else if (!remove && index === -1) list.push(channel.id);
        ctx.setSetting('leveling.noXpChannels', list);
        results.push(`${channel} ${remove ? 'earns XP again' : 'no longer earns XP'}.`);
      }
      if (role) {
        const list = [...ctx.settings.leveling.noXpRoles];
        const index = list.indexOf(role.id);
        if (remove && index !== -1) list.splice(index, 1);
        else if (!remove && index === -1) list.push(role.id);
        ctx.setSetting('leveling.noXpRoles', list);
        results.push(`<@&${role.id}> ${remove ? 'earns XP again' : 'no longer earns XP'}.`);
      }
      return ctx.ok('Exclusions updated', results.join('\n'));
    }

    case 'voice': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('leveling.voiceXp', enabled);
      const perMinute = ctx.i.options.getInteger('per_minute');
      if (perMinute !== null) ctx.setSetting('leveling.voiceXpPerMinute', perMinute);

      return ctx.ok(
        enabled ? 'Voice XP on' : 'Voice XP off',
        enabled
          ? `Members earn **${ctx.settings.leveling.voiceXpPerMinute}** XP per minute in voice.\n\nTime alone in a channel, and time while self-deafened, does not count.`
          : 'Voice time no longer earns XP.',
      );
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.economy = async (ctx, sub) => {
  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('economy.enabled', enabled);
      return ctx.ok(
        enabled ? 'Economy on' : 'Economy off',
        enabled
          ? `Members start with **${ctx.settings.economy.startingBalance}** ${ctx.settings.economy.currency}. Try \`/daily\`, \`/work\` and \`/shop\`.`
          : 'Economy commands are hidden. Balances are kept.',
      );
    }

    case 'currency': {
      const symbol = ctx.str('symbol').trim();
      if (symbol.length > 10) return ctx.fail('The symbol must be 10 characters or fewer.');
      ctx.setSetting('economy.currency', symbol);
      const name = ctx.str('name');
      if (name) ctx.setSetting('economy.currencyName', truncate(name, 30));
      return ctx.ok('Currency updated', `Balances now show as ${symbol} 1,234.`);
    }

    case 'rates': {
      const command = ctx.str('command');
      const min = ctx.i.options.getInteger('min');
      const max = ctx.i.options.getInteger('max');
      const cooldown = ctx.i.options.getInteger('cooldown');

      const amountKey = `economy.${command}Amount`;
      const current = ctx.settings.economy[`${command}Amount`];
      const next = [min ?? current[0], max ?? current[1]];
      if (next[0] > next[1]) return ctx.fail('The minimum cannot exceed the maximum.');
      ctx.setSetting(amountKey, next);

      if (cooldown !== null && (command === 'work' || command === 'crime')) {
        ctx.setSetting(`economy.${command}CooldownMinutes`, cooldown);
      }

      return ctx.ok(
        `${command} updated`,
        [
          `Payout: **${next[0]}–${next[1]}** ${ctx.settings.economy.currency}`,
          command === 'work' || command === 'crime'
            ? `Cooldown: **${ctx.settings.economy[`${command}CooldownMinutes`]} minutes**`
            : command === 'daily'
              ? 'Resets at local midnight.'
              : 'Resets 7 days after each claim.',
        ].join('\n'),
      );
    }

    case 'limits': {
      const changes = [];
      const maxBet = ctx.i.options.getInteger('max_bet');
      if (maxBet !== null) {
        ctx.setSetting('economy.maxBet', maxBet);
        changes.push(`Max wager: **${number(maxBet)}**`);
      }
      const robChance = ctx.i.options.getInteger('rob_chance');
      if (robChance !== null) {
        ctx.setSetting('economy.robSuccessChance', robChance / 100);
        changes.push(`Robbery success: **${robChance}%**`);
      }
      const interest = ctx.i.options.getInteger('interest');
      if (interest !== null) {
        ctx.setSetting('economy.interestPercent', interest);
        changes.push(
          interest
            ? `Bank interest: **${interest}% daily** — this compounds, so keep it low.`
            : 'Bank interest disabled.',
        );
      }
      if (!changes.length) return ctx.fail('Nothing to change. Pass at least one option.');
      return ctx.ok('Limits updated', changes.join('\n'));
    }

    case 'drops': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('economy.messageDrops.enabled', enabled);
      const chance = ctx.i.options.getInteger('chance');
      if (chance !== null) ctx.setSetting('economy.messageDrops.chance', chance / 100);

      return ctx.ok(
        enabled ? 'Coin drops on' : 'Coin drops off',
        enabled
          ? `Roughly **${Math.round(ctx.settings.economy.messageDrops.chance * 100)}%** of messages drop a few coins. The message gets a reaction when it happens.`
          : 'Messages no longer drop coins.',
      );
    }

    case 'reset': {
      const user = ctx.userOpt('user');
      if (user) {
        const record = ctx.record(user.id);
        record.coins = ctx.settings.economy.startingBalance;
        record.bank = 0;
        record.inventory = {};
        ctx.save();
        return ctx.ok('Balance reset', `<@${user.id}> is back to the starting balance with an empty inventory.`);
      }

      let count = 0;
      for (const [, record] of ctx.db.members(ctx.i.guildId)) {
        if (!record.coins && !record.bank && !Object.keys(record.inventory || {}).length) continue;
        record.coins = ctx.settings.economy.startingBalance;
        record.bank = 0;
        record.inventory = {};
        count++;
      }
      ctx.save();
      return ctx.ok('Economy reset', `Reset **${number(count)}** member(s). This cannot be undone.`);
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.starboard = async (ctx, sub) => {
  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('starboard.enabled', enabled);
      const hint = missingHint([['a channel (`/config starboard setup`)', Boolean(ctx.settings.starboard.channelId)]]);
      return ctx.ok(enabled ? 'Starboard on' : 'Starboard off', hint || 'Ready.');
    }

    case 'setup': {
      const channel = ctx.channelOpt('channel');
      const resolved = await ctx.bot.resolveChannel(ctx.guild, channel.id);
      if (!resolved) return ctx.fail(`I cannot post in ${channel}.`);

      ctx.setSetting('starboard.channelId', channel.id);

      const emoji = ctx.str('emoji');
      if (emoji) {
        // A custom emoji from another server cannot be matched reliably, so it
        // is rejected rather than silently never firing.
        const custom = emoji.match(/<a?:(\w+):(\d+)>/);
        if (custom && !ctx.guild.emojis.cache.has(custom[2])) {
          return ctx.fail('That custom emoji is not from this server, so I cannot match reactions with it reliably.');
        }
        ctx.setSetting('starboard.emoji', emoji.trim());
      }

      const threshold = ctx.i.options.getInteger('threshold');
      if (threshold !== null) ctx.setSetting('starboard.threshold', threshold);

      return ctx.ok(
        'Starboard configured',
        `Messages with **${ctx.settings.starboard.threshold}× ${ctx.settings.starboard.emoji}** are mirrored to ${channel}.`,
      );
    }

    case 'options': {
      const changes = [];
      const selfStar = ctx.i.options.getBoolean('self_star');
      if (selfStar !== null) {
        ctx.setSetting('starboard.selfStar', selfStar);
        changes.push(`Self-starring: **${selfStar ? 'allowed' : 'not counted'}**`);
      }
      const ignoreBots = ctx.i.options.getBoolean('ignore_bots');
      if (ignoreBots !== null) {
        ctx.setSetting('starboard.ignoreBots', ignoreBots);
        changes.push(`Bot messages: **${ignoreBots ? 'ignored' : 'eligible'}**`);
      }
      const channel = ctx.channelOpt('ignore_channel');
      if (channel) {
        const list = [...ctx.settings.starboard.ignoredChannels];
        const index = list.indexOf(channel.id);
        if (index === -1) list.push(channel.id);
        else list.splice(index, 1);
        ctx.setSetting('starboard.ignoredChannels', list);
        changes.push(`${channel}: **${index === -1 ? 'ignored' : 'eligible again'}**`);
      }
      if (!changes.length) return ctx.fail('Nothing to change.');
      return ctx.ok('Starboard options updated', changes.join('\n'));
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.tickets = async (ctx, sub) => {
  switch (sub) {
    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('tickets.enabled', enabled);
      const hint = missingHint([
        ['a category (`/config tickets setup`)', Boolean(ctx.settings.tickets.categoryId)],
        ['the Manage Channels permission', ctx.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)],
      ]);
      return ctx.ok(
        enabled ? 'Tickets on' : 'Tickets off',
        hint || 'Post a panel with `/ticket panel`.',
      );
    }

    case 'setup': {
      const category = ctx.channelOpt('category');
      ctx.setSetting('tickets.categoryId', category.id);

      const staffRole = ctx.roleOpt('staff_role');
      if (staffRole) {
        const list = [...new Set([...ctx.settings.tickets.supportRoleIds, staffRole.id])];
        ctx.setSetting('tickets.supportRoleIds', list);
      }
      const transcripts = ctx.channelOpt('transcripts');
      if (transcripts) ctx.setSetting('tickets.transcriptChannelId', transcripts.id);

      // Discord caps a category at 50 channels; hitting that is the usual cause
      // of "the ticket button stopped working".
      const used = ctx.guild.channels.cache.filter((c) => c.parentId === category.id).size;

      return ctx.ok(
        'Tickets configured',
        [
          `Category: **${category.name}** (${used}/50 channels used)`,
          staffRole ? `Support role: <@&${staffRole.id}>` : null,
          transcripts ? `Transcripts: ${transcripts}` : 'No transcript channel — closed tickets are only DMed to the opener.',
          '',
          'Post the panel with `/ticket panel`.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    case 'message': {
      ctx.setSetting('tickets.openMessage', truncate(ctx.str('text'), 1500));
      return ctx.ok('Ticket greeting updated', 'New tickets will open with that message.');
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.suggestions = async (ctx, sub) => {
  if (sub === 'toggle') {
    const enabled = ctx.bool('enabled');
    ctx.setSetting('suggestions.enabled', enabled);
    const hint = missingHint([['a channel (`/config suggestions channel`)', Boolean(ctx.settings.suggestions.channelId)]]);
    return ctx.ok(enabled ? 'Suggestions on' : 'Suggestions off', hint || 'Members can now use `/suggest`.');
  }

  if (sub === 'channel') {
    const channel = ctx.channelOpt('channel');
    const resolved = await ctx.bot.resolveChannel(ctx.guild, channel.id);
    if (!resolved) return ctx.fail(`I cannot post in ${channel}.`);
    ctx.setSetting('suggestions.channelId', channel.id);

    const threads = ctx.i.options.getBoolean('threads');
    if (threads !== null) ctx.setSetting('suggestions.threads', threads);

    return ctx.ok('Suggestion channel set', `Suggestions will post in ${channel}.`);
  }

  return ctx.fail('Unknown subcommand.');
};

handlers.counting = async (ctx, sub) => {
  switch (sub) {
    case 'setup': {
      const channel = ctx.channelOpt('channel');
      const resolved = await ctx.bot.resolveChannel(ctx.guild, channel.id);
      if (!resolved) return ctx.fail(`I cannot post in ${channel}.`);

      ctx.setSetting('counting.channelId', channel.id);
      ctx.setSetting('counting.enabled', true);
      const resetOnFail = ctx.i.options.getBoolean('reset_on_fail');
      if (resetOnFail !== null) ctx.setSetting('counting.resetOnFail', resetOnFail);

      return ctx.ok(
        'Counting set up',
        [
          `${channel} is the counting channel. Start at **${ctx.settings.counting.current + 1}**.`,
          '',
          'Rules: one number per message, no counting twice in a row, and arithmetic is allowed (`7*6` counts as 42).',
          ctx.settings.counting.resetOnFail ? 'A wrong number resets the count.' : 'A wrong number is just rejected.',
        ].join('\n'),
      );
    }

    case 'toggle': {
      const enabled = ctx.bool('enabled');
      ctx.setSetting('counting.enabled', enabled);
      return ctx.ok(enabled ? 'Counting on' : 'Counting off', enabled ? `Currently at **${ctx.settings.counting.current}**.` : null);
    }

    case 'reset': {
      const clearRecord = ctx.bool('clear_record');
      ctx.bot.features.counting.reset(ctx.i.guildId, { keepBest: !clearRecord });
      return ctx.ok(
        'Counting reset',
        `Back to **1**.${clearRecord ? ' The record was cleared too.' : ` The record of **${ctx.settings.counting.best}** stands.`}`,
      );
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.moderation = async (ctx, sub) => {
  switch (sub) {
    case 'options': {
      const changes = [];
      const dm = ctx.i.options.getBoolean('dm_on_punish');
      if (dm !== null) {
        ctx.setSetting('moderation.dmOnPunish', dm);
        changes.push(
          dm
            ? 'Members will be told why they were punished.'
            : 'Members will not be told. They will simply find themselves unable to talk, which generates support tickets.',
        );
      }
      const channel = ctx.channelOpt('log_channel');
      if (channel) {
        ctx.setSetting('moderation.logChannelId', channel.id);
        changes.push(`Cases post to ${channel}.`);
      }
      const appeal = ctx.str('appeal_link');
      if (appeal) {
        if (!/^https?:\/\//i.test(appeal)) return ctx.fail('The appeal link must start with http:// or https://.');
        ctx.setSetting('moderation.appealLink', appeal);
        changes.push('Appeal link added to punishment DMs.');
      }
      if (!changes.length) return ctx.fail('Nothing to change.');
      return ctx.ok('Moderation options updated', changes.join('\n'));
    }

    case 'threshold': {
      const warnings = ctx.int('warnings');
      const action = ctx.str('action');
      const thresholds = { ...ctx.settings.moderation.warnThresholds };

      if (action === 'none') {
        delete thresholds[String(warnings)];
        ctx.setSetting('moderation.warnThresholds', thresholds);
        return ctx.ok('Threshold removed', `Nothing automatic happens at ${warnings} warnings.`);
      }

      thresholds[String(warnings)] = action;
      ctx.setSetting('moderation.warnThresholds', thresholds);

      const all = Object.entries(thresholds)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([count, act]) => `**${count}** warnings → ${act.replace(':', ' ')}`);

      return ctx.ok('Threshold set', all.join('\n'));
    }

    case 'protect': {
      const role = ctx.roleOpt('role');
      const list = [...ctx.settings.moderation.protectedRoles];
      const index = list.indexOf(role.id);

      if (ctx.bool('remove')) {
        if (index === -1) return ctx.fail('That role is not protected.');
        list.splice(index, 1);
        ctx.setSetting('moderation.protectedRoles', list);
        return ctx.ok('Protection removed', `<@&${role.id}> can be targeted by moderation commands again.`);
      }

      if (index !== -1) return ctx.fail('That role is already protected.');
      list.push(role.id);
      ctx.setSetting('moderation.protectedRoles', list);
      return ctx.ok(
        'Role protected',
        `Nobody with <@&${role.id}> can be kicked, banned, warned or timed out through my commands — including by an admin using them.`,
      );
    }

    default:
      return ctx.fail('Unknown subcommand.');
  }
};

handlers.commands = async (ctx, sub) => {
  if (sub === 'list') {
    const s = ctx.settings;
    const perChannel = Object.entries(s.disabledChannels || {})
      .filter(([, list]) => list.length)
      .map(([channelId, list]) => `<#${channelId}>: ${list.map((c) => `\`${c}\``).join(', ')}`);

    return ctx.send({
      embeds: [
        embeds
          .base('Disabled commands')
          .addFields(
            {
              name: 'Server wide',
              value: s.disabledCommands.length ? s.disabledCommands.map((c) => `\`${c}\``).join(', ') : 'none',
            },
            { name: 'Per channel', value: perChannel.join('\n') || 'none' },
          )
          .setFooter({ text: 'Anyone with Manage Server can still use disabled commands.' }),
      ],
    });
  }

  const name = ctx.str('command').toLowerCase().replace(/^\//, '');
  const command = ctx.bot.registry.get(name);
  if (!command) return ctx.fail(`There is no command called \`${name}\`.`);
  if (command.category === 'config') return ctx.fail('Configuration commands cannot be disabled — that would lock you out.');

  const channel = ctx.channelOpt('channel');
  const disable = sub === 'disable';

  if (channel) {
    const map = { ...(ctx.settings.disabledChannels || {}) };
    const list = [...(map[channel.id] || [])];
    const index = list.indexOf(name);

    if (disable) {
      if (index !== -1) return ctx.fail(`\`/${name}\` is already disabled in ${channel}.`);
      list.push(name);
    } else {
      if (index === -1) return ctx.fail(`\`/${name}\` is not disabled in ${channel}.`);
      list.splice(index, 1);
    }
    map[channel.id] = list;
    ctx.setSetting('disabledChannels', map);
    return ctx.ok(
      disable ? 'Command disabled here' : 'Command enabled here',
      `\`/${name}\` ${disable ? 'cannot be used' : 'works again'} in ${channel}.`,
    );
  }

  const list = [...ctx.settings.disabledCommands];
  const index = list.indexOf(name);
  if (disable) {
    if (index !== -1) return ctx.fail(`\`/${name}\` is already disabled.`);
    list.push(name);
  } else {
    if (index === -1) return ctx.fail(`\`/${name}\` is not disabled.`);
    list.splice(index, 1);
  }
  ctx.setSetting('disabledCommands', list);

  return ctx.ok(
    disable ? 'Command disabled' : 'Command enabled',
    `\`/${name}\` ${disable ? 'is now unavailable to members' : 'works again'}.\n\nIt still appears in the command list — Discord does not let a bot hide a command per server.`,
  );
};

void DEFAULT_GUILD;
module.exports = config;
