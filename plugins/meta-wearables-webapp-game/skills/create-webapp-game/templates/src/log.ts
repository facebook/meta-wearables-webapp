/**
 * The game's shared logger. This is GAME code — edit it freely.
 *
 * Import it anywhere and call it instead of `console.*` (which `npm run validate` rejects in game
 * code):
 *
 * ```ts
 * import { log } from '@/log';
 *
 * log.info('level started', { level: 3 });
 * const audioLog = log.child('audio');   // tags records with a subsystem
 * ```
 *
 * The level comes from `?log=` (see the plugin's docs/logging.md); with no flag it is `warn`, so
 * a shipped build stays quiet. Sinks — console, the `?logview` on-screen overlay, and the remote
 * sink — are attached in `main.ts`, which is also where the consent gate decides whether anything
 * leaves the device.
 *
 * In a hot path, guard instead of formatting a message you are about to throw away:
 *
 * ```ts
 * if (log.isEnabled('debug')) {
 *   log.debug('tick', { entities: entities.length });
 * }
 * ```
 */

import { DEFAULT_LOG_LEVEL, Logger, logLevelFromSearch } from '@/framework/debug/Logger';

/** The query string, or `''` under the node test env where there is no `window`. */
export const search = typeof window === 'undefined' ? '' : window.location.search;

export const log = new Logger({ level: logLevelFromSearch(search) ?? DEFAULT_LOG_LEVEL });
