'use strict';

const { init: initManager } = require('../games/manager');

/**
 * Feature wrapper for the game subsystem.
 *
 * The games themselves live under src/games so each one is a self-contained
 * file; this shim exists only so the feature loader picks them up in the normal
 * way and so a deployment can switch every game off with FEATURE_GAMES=false
 * without the loader needing to know anything about them.
 */
function init(bot) {
  if (!bot.config.features.games) {
    bot.log.info('games are disabled by FEATURE_GAMES');
    return { disabled: true, snapshot: () => ({ active: 0, byGame: {}, games: [] }) };
  }
  return initManager(bot);
}

module.exports = { name: 'games', init };
