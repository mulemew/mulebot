'use strict';

/**
 * Minimal i18n.
 *
 * Scope is deliberate: every string the *framework* produces (permission
 * errors, cooldowns, confirmations, common labels) is translated, because those
 * are the messages a normal member sees most often. Individual command flavour
 * text stays in English so the dictionary does not have to track every new
 * feature to stay correct.
 *
 * A missing key falls back to English, and a missing English key falls back to
 * the key itself - so a typo shows up as a visible key rather than "undefined".
 *
 * Placeholders use {name} and are substituted from the vars object.
 */

const STRINGS = {
  en: {
    // --- framework ---
    'err.generic': 'Something went wrong: {error}',
    'err.guildOnly': 'This command only works inside a server channel.',
    'err.ownerOnly': 'That command is restricted to the bot owner.',
    'err.blacklisted': 'You are blocked from using this bot.',
    'err.disabled': 'That command is disabled on this server.',
    'err.disabledHere': 'That command is disabled in this channel.',
    'err.featureOff': 'The **{feature}** feature is switched off. An admin can enable it with `/config {feature}`.',
    'err.cooldown': 'Slow down - try `/{command}` again {time}.',
    'err.ratelimited': 'You are sending commands too quickly. Try again {time}.',
    'err.userPerms': 'You need the **{perms}** permission to do that.',
    'err.botPerms': 'I am missing the **{perms}** permission.',
    'err.notFound': 'I could not find that.',
    'err.memberNotFound': 'Member not found. They may have already left the server.',
    'err.badDuration': 'Invalid duration. Use formats like `30s` `10m` `2h` `1d`.',
    'err.badNumber': 'That is not a valid number.',
    'err.timedOut': 'Timed out waiting for a response.',
    'err.notYours': 'This is not your interaction.',

    // --- moderation ---
    'mod.selfTarget': 'You cannot {action} yourself.',
    'mod.botTarget': 'I will not {action} myself.',
    'mod.ownerTarget': 'The server owner cannot be targeted.',
    'mod.aboveMe': 'Their highest role is not below mine, so I lack permission. Move my role higher in the role list.',
    'mod.aboveYou': 'Their highest role is not below yours, so you cannot target them.',
    'mod.protected': 'That member holds a protected role.',
    'mod.dmNotice': 'You were {action} in **{server}**. Reason: {reason}',
    'mod.case': 'Case #{id}',
    'mod.reason': 'Reason',
    'mod.moderator': 'Moderator',
    'mod.duration': 'Duration',

    // --- common labels ---
    'label.user': 'User',
    'label.server': 'Server',
    'label.channel': 'Channel',
    'label.role': 'Role',
    'label.none': 'None',
    'label.yes': 'Yes',
    'label.no': 'No',
    'label.enabled': 'Enabled',
    'label.disabled': 'Disabled',
    'label.page': 'Page {page}/{total}',
    'label.total': 'Total',
    'label.unknown': 'Unknown',
    'label.confirm': 'Confirm',
    'label.cancel': 'Cancel',
    'label.cancelled': 'Cancelled.',

    // --- features ---
    'level.up': 'GG {user}, you reached level **{level}**!',
    'eco.insufficient': 'You only have {balance}, which is not enough.',
    'eco.cooldown': 'You can do that again {time}.',
    'game.turn': "It is {user}'s turn.",
    'game.win': '{user} wins!',
    'game.draw': 'It is a draw.',
    'game.expired': 'The game expired from inactivity.',
  },

  'zh-CN': {
    'err.generic': '出错了：{error}',
    'err.guildOnly': '该命令只能在服务器频道中使用。',
    'err.ownerOnly': '该命令仅限机器人所有者使用。',
    'err.blacklisted': '你已被禁止使用此机器人。',
    'err.disabled': '该命令已在本服务器停用。',
    'err.disabledHere': '该命令已在此频道停用。',
    'err.featureOff': '**{feature}** 功能未开启，管理员可用 `/config {feature}` 打开。',
    'err.cooldown': '慢一点 —— {time} 后可以再次使用 `/{command}`。',
    'err.ratelimited': '你的命令发得太快了，{time} 后再试。',
    'err.userPerms': '你需要 **{perms}** 权限才能这么做。',
    'err.botPerms': '我缺少 **{perms}** 权限。',
    'err.notFound': '没有找到。',
    'err.memberNotFound': '找不到该成员，他可能已经退出服务器。',
    'err.badDuration': '时长格式不对，请用 `30s` `10m` `2h` `1d` 这样的写法。',
    'err.badNumber': '这不是一个有效的数字。',
    'err.timedOut': '等待响应超时。',
    'err.notYours': '这不是你发起的操作。',

    'mod.selfTarget': '你不能对自己执行「{action}」。',
    'mod.botTarget': '我不会对自己执行「{action}」。',
    'mod.ownerTarget': '不能对服务器所有者执行该操作。',
    'mod.aboveMe': '对方的最高身份组不低于我的，我没有权限。请把我的身份组往上移。',
    'mod.aboveYou': '对方的最高身份组不低于你的，你不能对其操作。',
    'mod.protected': '该成员拥有受保护的身份组。',
    'mod.dmNotice': '你在 **{server}** 被执行了「{action}」。原因：{reason}',
    'mod.case': '案件 #{id}',
    'mod.reason': '原因',
    'mod.moderator': '执行人',
    'mod.duration': '时长',

    'label.user': '用户',
    'label.server': '服务器',
    'label.channel': '频道',
    'label.role': '身份组',
    'label.none': '无',
    'label.yes': '是',
    'label.no': '否',
    'label.enabled': '已开启',
    'label.disabled': '已关闭',
    'label.page': '第 {page}/{total} 页',
    'label.total': '总计',
    'label.unknown': '未知',
    'label.confirm': '确认',
    'label.cancel': '取消',
    'label.cancelled': '已取消。',

    'level.up': '恭喜 {user}，升到了 **{level}** 级！',
    'eco.insufficient': '你只有 {balance}，还不够。',
    'eco.cooldown': '{time} 后可以再来一次。',
    'game.turn': '轮到 {user} 了。',
    'game.win': '{user} 获胜！',
    'game.draw': '平局。',
    'game.expired': '游戏因长时间无操作已结束。',
  },
};

/** Discord locale codes that should map onto one of our dictionaries. */
const ALIASES = {
  zh: 'zh-CN',
  'zh-TW': 'zh-CN',
  'zh-HK': 'zh-CN',
  'zh-Hans': 'zh-CN',
  'en-US': 'en',
  'en-GB': 'en',
};

const SUPPORTED = Object.keys(STRINGS);

/** Normalises any locale-ish string to a supported dictionary name. */
function resolveLocale(input, fallback = 'en') {
  if (!input) return fallback;
  const raw = String(input).trim();
  if (STRINGS[raw]) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  const base = raw.split('-')[0];
  if (STRINGS[base]) return base;
  if (ALIASES[base]) return ALIASES[base];
  return fallback;
}

/** Substitutes {placeholders}. Unknown placeholders are left intact on purpose. */
function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/**
 * Translates a key.
 * @param {string} locale
 * @param {string} key
 * @param {object} [vars]
 */
function translate(locale, key, vars) {
  const dict = STRINGS[resolveLocale(locale)] || STRINGS.en;
  const template = dict[key] ?? STRINGS.en[key] ?? key;
  return interpolate(template, vars);
}

/** Builds a bound t() for one locale, which is what commands actually receive. */
function translator(locale) {
  const resolved = resolveLocale(locale);
  const t = (key, vars) => translate(resolved, key, vars);
  t.locale = resolved;
  return t;
}

module.exports = { translate, translator, resolveLocale, interpolate, SUPPORTED, STRINGS };
