'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { truncate, LIMITS } = require('./text');

/**
 * Component builders.
 *
 * Discord's component limits are strict and unforgiving (5 rows, 5 buttons per
 * row, 80 character labels, 100 character custom ids, 25 select options). Every
 * helper here clamps to those limits rather than letting the API reject the
 * whole message.
 *
 * Custom ids follow "namespace:action:arg1:arg2". The ComponentRouter in
 * core/registry.js dispatches on the namespace, which is what lets game boards
 * and paginators keep working after a restart instead of dying with their
 * collector.
 */

const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_SELECT_OPTIONS = 25;

/** Joins custom id parts and asserts the length limit early, where it is debuggable. */
function customId(...parts) {
  const id = parts.filter((p) => p !== undefined && p !== null).join(':');
  if (id.length > LIMITS.customId) {
    throw new Error(`custom id "${id}" is ${id.length} characters, the limit is ${LIMITS.customId}`);
  }
  return id;
}

/**
 * One button.
 * @param {{ id?: string, label?: string, emoji?: string, style?: keyof typeof ButtonStyle,
 *           disabled?: boolean, url?: string }} opts
 */
function button(opts) {
  const b = new ButtonBuilder();
  if (opts.url) {
    b.setStyle(ButtonStyle.Link).setURL(opts.url);
  } else {
    b.setCustomId(opts.id).setStyle(ButtonStyle[opts.style || 'Secondary']);
  }
  if (opts.label) b.setLabel(truncate(opts.label, LIMITS.buttonLabel));
  if (opts.emoji) b.setEmoji(opts.emoji);
  if (opts.disabled) b.setDisabled(true);
  // A button with neither label nor emoji is rejected by the API; a space is a
  // valid placeholder and is what game boards use for empty cells.
  if (!opts.label && !opts.emoji) b.setLabel('​');
  return b;
}

/**
 * Accepts either a plain spec object or an already-built ButtonBuilder, so
 * callers can mix the two without every layout helper caring which it got.
 */
function toButton(entry) {
  return entry instanceof ButtonBuilder ? entry : button(entry);
}

/** Wraps buttons into rows of at most 5, capped at 5 rows. */
function rows(buttons) {
  const out = [];
  for (let i = 0; i < buttons.length && out.length < MAX_ROWS; i += MAX_BUTTONS_PER_ROW) {
    out.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + MAX_BUTTONS_PER_ROW).map(toButton)));
  }
  return out;
}

/** A single row from a list of button option objects. */
function buttonRow(...specs) {
  return new ActionRowBuilder().addComponents(specs.slice(0, MAX_BUTTONS_PER_ROW).map(toButton));
}

/**
 * Grid layout used by board games: a flat array of cell specs turned into rows
 * of a fixed width.
 */
function grid(cells, width) {
  const out = [];
  for (let i = 0; i < cells.length && out.length < MAX_ROWS; i += width) {
    out.push(new ActionRowBuilder().addComponents(cells.slice(i, i + width).map(toButton)));
  }
  return out;
}

/**
 * String select menu.
 * @param {{ id: string, placeholder?: string, options: Array<{label: string, value: string,
 *          description?: string, emoji?: string, default?: boolean}>,
 *          min?: number, max?: number, disabled?: boolean }} opts
 */
function select(opts) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(opts.id)
    .setPlaceholder(truncate(opts.placeholder || 'Choose an option', LIMITS.selectLabel));
  if (opts.min !== undefined) menu.setMinValues(opts.min);
  if (opts.max !== undefined) menu.setMaxValues(Math.min(opts.max, MAX_SELECT_OPTIONS));
  if (opts.disabled) menu.setDisabled(true);

  const options = opts.options.slice(0, MAX_SELECT_OPTIONS).map((o) => {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(truncate(o.label, LIMITS.selectLabel))
      .setValue(String(o.value).slice(0, 100));
    if (o.description) opt.setDescription(truncate(o.description, LIMITS.selectDescription));
    if (o.emoji) opt.setEmoji(o.emoji);
    if (o.default) opt.setDefault(true);
    return opt;
  });
  menu.addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

/**
 * Confirm / cancel pair. The caller owns the namespace so two features cannot
 * accidentally answer each other's confirmations.
 */
function confirmRow(namespace, token, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return buttonRow(
    { id: customId(namespace, 'yes', token), label: confirmLabel, style: danger ? 'Danger' : 'Success', emoji: '✅' },
    { id: customId(namespace, 'no', token), label: cancelLabel, style: 'Secondary', emoji: '✖️' },
  );
}

/** Disables every component on an existing message payload. */
function disableAll(components) {
  return components.map((row) => {
    const json = row.toJSON ? row.toJSON() : row;
    return {
      ...json,
      components: json.components.map((c) => ({ ...c, disabled: true })),
    };
  });
}

/**
 * Modal with up to 5 text inputs.
 * @param {{ id: string, title: string, inputs: Array<{ id: string, label: string,
 *          style?: 'Short'|'Paragraph', value?: string, placeholder?: string,
 *          required?: boolean, min?: number, max?: number }> }} opts
 */
function modal(opts) {
  const m = new ModalBuilder().setCustomId(opts.id).setTitle(truncate(opts.title, 45));
  for (const input of opts.inputs.slice(0, 5)) {
    const ti = new TextInputBuilder()
      .setCustomId(input.id)
      .setLabel(truncate(input.label, 45))
      .setStyle(TextInputStyle[input.style || 'Short'])
      .setRequired(input.required !== false);
    if (input.value) ti.setValue(truncate(input.value, LIMITS.modalValue));
    if (input.placeholder) ti.setPlaceholder(truncate(input.placeholder, 100));
    if (input.min !== undefined) ti.setMinLength(input.min);
    if (input.max !== undefined) ti.setMaxLength(input.max);
    m.addComponents(new ActionRowBuilder().addComponents(ti));
  }
  return m;
}

/** Link button row, e.g. "Invite me" / "Support server". */
function linkRow(links) {
  return new ActionRowBuilder().addComponents(
    links.slice(0, MAX_BUTTONS_PER_ROW).map((l) => button({ url: l.url, label: l.label, emoji: l.emoji })),
  );
}

module.exports = {
  customId,
  button,
  toButton,
  rows,
  buttonRow,
  grid,
  select,
  confirmRow,
  disableAll,
  modal,
  linkRow,
  ButtonStyle,
  MAX_ROWS,
  MAX_BUTTONS_PER_ROW,
  MAX_SELECT_OPTIONS,
};
