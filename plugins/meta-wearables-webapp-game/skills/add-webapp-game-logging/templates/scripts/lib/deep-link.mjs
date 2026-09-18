/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Builds the URLs used to launch a debug session on the glasses — the deterministic core behind
 * `debug-url.mjs`.
 *
 * The whole reason this is a script rather than a copy-paste snippet is ONE encoding rule that is
 * easy to get wrong and fails silently:
 *
 *   fb-viewapp://web_app_deep_link?appName=<name>&appUrl=<url>
 *
 * `appUrl` is a *value inside another query string*, so the game URL's own `?` and `&` must be
 * percent-encoded (`%3F`, `%26`). If they aren't, the deep-link parser reads `&log=debug` as a
 * parameter of the DEEP LINK, drops it from `appUrl`, and registers the plain URL. Nothing errors
 * — you just never get logs, and there is no way to tell from the device.
 *
 *   WRONG: …&appUrl=https%3A%2F%2Fgame.example/?log=debug&logkey=k3j9
 *   RIGHT: …&appUrl=https%3A%2F%2Fgame.example%2F%3Flog%3Ddebug%26logkey%3Dk3j9
 *
 * Dependency-free (Node built-ins only) so it runs inside a scaffolded game with no install step.
 */

/** The deep-link scheme the Meta AI app handles to register a webapp on the glasses. */
export const DEEP_LINK_BASE = 'fb-viewapp://web_app_deep_link';

/**
 * Add debug flags to a game URL. Existing query parameters on `baseUrl` are preserved; flags with
 * a `false`/`null`/`undefined` value are omitted rather than written as empty.
 *
 * @param {string} baseUrl e.g. `https://my-game.vercel.app`
 * @param {{ level?: string, logkey?: string, logview?: boolean, stats?: boolean, lng?: string }} flags
 * @returns {string} the fully-formed game URL
 */
export function buildGameUrl(baseUrl, flags = {}) {
  const url = new URL(baseUrl);
  if (flags.level) {
    url.searchParams.set('log', flags.level);
  }
  if (flags.logkey) {
    url.searchParams.set('logkey', flags.logkey);
  }
  if (flags.logview) {
    url.searchParams.set('logview', '1');
  }
  if (flags.stats) {
    url.searchParams.set('stats', '1');
  }
  if (flags.lng) {
    url.searchParams.set('lng', flags.lng);
  }
  return url.toString();
}

/**
 * Build the `fb-viewapp://` deep link that registers a webapp on the glasses.
 *
 * Both values are percent-encoded with `encodeURIComponent`, which is what makes a query-bearing
 * `appUrl` survive (see the module comment). Do not hand-assemble this string.
 *
 * @param {string} appName the name shown on the glasses launcher
 * @param {string} appUrl the full game URL, query string and all
 */
export function buildDeepLink(appName, appUrl) {
  return `${DEEP_LINK_BASE}?appName=${encodeURIComponent(appName)}&appUrl=${encodeURIComponent(appUrl)}`;
}

/**
 * Suffix used for the debug registration, so the debug build gets its own launcher tile next to
 * the normal one and toggling logging never means re-registering the webapp.
 */
export function debugAppName(appName) {
  return `${appName} (debug)`;
}

/**
 * `qr_generator.py` (the `/qr-code` skill) supports QR versions 1–10, i.e. roughly this many bytes
 * in byte mode. Longer data cannot be encoded, so callers should warn before generating.
 */
export const MAX_QR_CHARS = 271;
