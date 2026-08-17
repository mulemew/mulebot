'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Command registry.
 *
 * Walks src/commands recursively and loads every .js file that exports a
 * command module. The contract is:
 *
 *   module.exports = {
 *     data:        SlashCommandBuilder,       // required
 *     category:    'utility',                 // required, groups /help
 *     description: 'longer help text',        // optional
 *     examples:    ['/ping'],                 // optional, shown by /help
 *     cooldown:    3,                         // seconds, optional
 *     guildOnly:   true,                      // default true
 *     ownerOnly:   false,
 *     feature:     'economy',                 // gated on a master switch
 *     userPerms:   [PermissionFlagsBits.X],   // checked before execute
 *     botPerms:    [PermissionFlagsBits.X],
 *     hidden:      false,                     // omit from /help
 *     async execute(ctx) {},                  // required
 *     async autocomplete(ctx) {},             // optional
 *   };
 *
 * Loading is fail-soft: one broken command file logs an error and is skipped
 * rather than preventing the whole bot from starting. A command that fails to
 * load is remembered so /stats can report it.
 */

/** Discord's own limits, enforced here so registration never 400s. */
const LIMITS = {
  commands: 100,
  nameLength: 32,
  descriptionLength: 100,
  options: 25,
};

class Registry {
  constructor({ log, config }) {
    this.log = log;
    this.config = config;
    /** @type {Map<string, object>} name -> command module */
    this.commands = new Map();
    /** @type {Array<{ file: string, error: string }>} */
    this.failures = [];
    this.loadedFiles = 0;
  }

  /** Recursively collects .js files, skipping dotfiles and _prefixed helpers. */
  static walk(dir) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...Registry.walk(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  /**
   * Loads every command under `dir`.
   * @returns {number} how many commands were registered
   */
  load(dir) {
    const files = Registry.walk(dir);
    for (const file of files) {
      this.loadedFiles++;
      let mod;
      try {
        // Delete from cache first so a reload picks up edits.
        delete require.cache[require.resolve(file)];
        mod = require(file);
      } catch (e) {
        this.failures.push({ file: path.relative(dir, file), error: e.message });
        this.log.error(`command file ${path.relative(dir, file)} failed to load: ${e.message}`);
        continue;
      }

      // A file may export one command or an array of them. Related commands
      // (the six economy earning commands, say) read much better together than
      // spread across six nearly identical files.
      for (const command of Array.isArray(mod) ? mod : [mod]) {
        const problems = this.validate(command, file, dir);
        if (problems.length) {
          this.failures.push({ file: path.relative(dir, file), error: problems.join('; ') });
          this.log.error(`command in ${path.relative(dir, file)} is invalid: ${problems.join('; ')}`);
          continue;
        }

        const name = command.data.name;
        if (this.commands.has(name)) {
          this.failures.push({ file: path.relative(dir, file), error: `duplicate command name /${name}` });
          this.log.error(`duplicate command name /${name} in ${path.relative(dir, file)}, keeping the first one`);
          continue;
        }

        // Normalise optional fields once so the dispatcher never has to guess.
        command.guildOnly = command.guildOnly !== false;
        command.cooldown = Number(command.cooldown) || 0;
        command.userPerms = command.userPerms || [];
        command.botPerms = command.botPerms || [];
        command.category = command.category || 'misc';
        command.file = path.relative(dir, file);
        command.uses = 0;

        this.commands.set(name, command);
      }
    }

    if (this.commands.size > LIMITS.commands) {
      this.log.warn(
        `${this.commands.size} top-level commands exceed Discord's limit of ${LIMITS.commands}. ` +
          'Registration will fail until some are merged into subcommands.',
      );
    }
    return this.commands.size;
  }

  /** Returns a list of human-readable problems, empty when the module is fine. */
  validate(mod, file, dir) {
    const rel = path.relative(dir, file);
    const problems = [];
    if (!mod || typeof mod !== 'object') return [`${rel} does not export an object`];
    if (!mod.data) problems.push('missing `data`');
    else if (typeof mod.data.toJSON !== 'function') problems.push('`data` is not a SlashCommandBuilder');
    if (typeof mod.execute !== 'function') problems.push('missing `execute`');

    if (mod.data?.name) {
      const name = mod.data.name;
      if (name.length > LIMITS.nameLength) problems.push(`name "${name}" is longer than ${LIMITS.nameLength}`);
      if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(name)) problems.push(`name "${name}" uses characters Discord rejects`);
      if (name !== name.toLowerCase()) problems.push(`name "${name}" must be lowercase`);
    }
    if (mod.data?.description && mod.data.description.length > LIMITS.descriptionLength) {
      problems.push(`description is ${mod.data.description.length} chars, the limit is ${LIMITS.descriptionLength}`);
    }
    return problems;
  }

  get(name) {
    return this.commands.get(name) || null;
  }

  has(name) {
    return this.commands.has(name);
  }

  /**
   * Adds a command at runtime. Used by plugins, which are loaded after the
   * initial directory scan.
   * @returns {{ ok: boolean, error?: string }}
   */
  add(command, { source = 'plugin' } = {}) {
    const problems = this.validate(command, source, '');
    if (problems.length) return { ok: false, error: problems.join('; ') };

    const name = command.data.name;
    if (this.commands.has(name)) return { ok: false, error: `/${name} is already registered` };

    command.guildOnly = command.guildOnly !== false;
    command.cooldown = Number(command.cooldown) || 0;
    command.userPerms = command.userPerms || [];
    command.botPerms = command.botPerms || [];
    command.category = command.category || 'plugin';
    command.file = source;
    command.uses = command.uses || 0;

    this.commands.set(name, command);
    return { ok: true };
  }

  /** Removes a command. Used when a plugin is unloaded. */
  remove(name) {
    return this.commands.delete(name);
  }

  get size() {
    return this.commands.size;
  }

  /** All commands, optionally filtered by category. */
  all(category = null) {
    const list = [...this.commands.values()];
    return category ? list.filter((c) => c.category === category) : list;
  }

  /** Category name -> commands, with hidden commands removed. */
  byCategory({ includeHidden = false } = {}) {
    const out = new Map();
    for (const cmd of this.commands.values()) {
      if (cmd.hidden && !includeHidden) continue;
      if (!out.has(cmd.category)) out.set(cmd.category, []);
      out.get(cmd.category).push(cmd);
    }
    for (const list of out.values()) list.sort((a, b) => a.data.name.localeCompare(b.data.name));
    return out;
  }

  /**
   * Serialises every command for the REST registration call.
   * Commands whose master feature switch is off are left out entirely, so a
   * server with the economy disabled does not show economy commands at all.
   */
  toJSON({ features = {} } = {}) {
    const body = [];
    for (const cmd of this.commands.values()) {
      if (cmd.feature && features[cmd.feature] === false) continue;
      try {
        body.push(cmd.data.toJSON());
      } catch (e) {
        this.log.error(`command /${cmd.data.name} could not be serialised: ${e.message}`);
      }
    }
    return body;
  }

  /** Fuzzy lookup used by /help and the prefix bridge. */
  search(query) {
    const q = String(query).toLowerCase().trim();
    if (!q) return [];
    const exact = this.get(q);
    if (exact) return [exact];
    return this.all()
      .filter((c) => c.data.name.includes(q) || (c.aliases || []).some((a) => a.includes(q)))
      .slice(0, 25);
  }

  /** Resolves an alias registered by a command (used by prefix commands). */
  resolveAlias(alias) {
    const a = String(alias).toLowerCase();
    for (const cmd of this.commands.values()) {
      if (cmd.data.name === a) return cmd;
      if ((cmd.aliases || []).includes(a)) return cmd;
    }
    return null;
  }

  stats() {
    return {
      commands: this.commands.size,
      files: this.loadedFiles,
      failures: this.failures.length,
      categories: [...this.byCategory().keys()].length,
      top: [...this.commands.values()]
        .sort((a, b) => b.uses - a.uses)
        .slice(0, 10)
        .map((c) => ({ name: c.data.name, uses: c.uses })),
    };
  }
}

/**
 * Component router.
 *
 * Buttons, select menus and modals are matched by the first segment of their
 * custom id, e.g. "ttt:move:4" routes to the handler registered as "ttt". This
 * replaces per-message collectors, which leak when a bot is restarted while a
 * game is open and stop working after 15 minutes.
 */
class ComponentRouter {
  constructor({ log }) {
    this.log = log;
    this.routes = new Map();
  }

  /**
   * @param {string} namespace first segment of the custom id
   * @param {(interaction: object, parts: string[], ctx: object) => Promise<void>} handler
   */
  register(namespace, handler) {
    if (this.routes.has(namespace)) this.log.warn(`component namespace "${namespace}" registered twice`);
    this.routes.set(namespace, handler);
    return this;
  }

  /** Removes a route, so an unloaded plugin stops answering its own buttons. */
  unregister(namespace) {
    return this.routes.delete(namespace);
  }

  has(namespace) {
    return this.routes.has(namespace);
  }

  /** Builds a custom id from parts, guarding Discord's 100 character limit. */
  static id(...parts) {
    const id = parts.join(':');
    if (id.length > 100) throw new Error(`custom id too long (${id.length}): ${id}`);
    return id;
  }

  /** Dispatches an interaction. Returns true when a route handled it. */
  async dispatch(interaction, ctx) {
    const raw = interaction.customId || '';
    const parts = raw.split(':');
    const handler = this.routes.get(parts[0]);
    if (!handler) return false;
    await handler(interaction, parts.slice(1), ctx);
    return true;
  }

  get namespaces() {
    return [...this.routes.keys()];
  }
}

module.exports = { Registry, ComponentRouter, LIMITS };
