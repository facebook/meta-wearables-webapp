/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared HTTP helpers for the remote-logging endpoints. Underscore-prefixed so Vercel treats it as
 * a helper module rather than routing it as a function.
 *
 * Written against the plain Node `(req, res)` shape so the exact same handlers serve BOTH the
 * deployed serverless functions and the local Vite dev server (see `scripts/vite-log-api.mjs`).
 * That means: parse the query from `req.url` rather than trusting a platform-provided `req.query`,
 * and read the body from the stream unless the platform already parsed it.
 *
 * Security posture (see the plugin's docs/logging.md):
 *
 * - **Fail closed.** With `LOG_TOKEN` unset, every endpoint 404s. A game published without
 *   deliberately configuring logging therefore exposes nothing — no open ingest endpoint to spam,
 *   no portal to find.
 * - **Constant-time comparison** on both the ingest token and the portal passcode, so neither can
 *   be recovered a character at a time.
 * - **Every rejected credential is delayed and counted per IP**, on ingest as well as on the
 *   portal. Both gates hold the same secret, so throttling only one leaves the other as an oracle
 *   for it. The address is taken from the socket unless a trusted proxy is declared, because a
 *   believed `x-forwarded-for` is an attacker-chosen counter key.
 * - **The portal cookie is a hash of the token, not the token**, so a leaked cookie doesn't hand
 *   over the ingest key.
 */

import crypto from 'node:crypto';

/**
 * A numeric env var, falling back to the default when unset or unparseable. `Number('256k')` is
 * `NaN`, and every comparison against `NaN` is false — so a typo'd override would silently
 * *disable* the limit it was meant to configure rather than fail loudly.
 */
export function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Reject bodies larger than this outright — a log batch is small, anything huge is abuse. */
export const MAX_BODY_BYTES = envNumber('LOG_MAX_BODY_BYTES', 256 * 1024);

const COOKIE_NAME = 'webapp-game-log';

/**
 * Fixed delay charged for every rejected credential — enough to make scripted guessing impractical
 * even before the lockout engages, and independent of the IP the request claims to come from.
 */
export const FAILURE_DELAY_MS = envNumber('LOG_FAILURE_DELAY_MS', 750);

/** Await the anti-guessing delay. Both endpoints charge it on every rejection. */
export function delayFailure() {
  return new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
}

/**
 * Failed-credential tracking. Per-instance and best-effort — a speed bump, not a global rate
 * limiter.
 *
 * Keyed by `<scope>:<ip>`, so the ingest key and the portal passcode get independent budgets.
 * Sharing one budget would let traffic on one gate move the other's counter: everything behind a
 * NAT looks like a single IP, and the game itself posts from one address every couple of seconds.
 */
const failuresByIp = new Map();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Ceiling on tracked keys. This Map is the only state that grows with request volume, and its key
 * is partly caller-influenced (see {@link clientIp}), so without a cap a flood of distinct
 * apparent clients is a memory-exhaustion path against the whole function.
 */
export const MAX_TRACKED_IPS = 10_000;

const failureKey = (scope, ip) => `${scope}:${ip}`;

/** How many failure windows are currently tracked. Exposed so the bound above can be asserted. */
export function trackedFailureCount() {
  return failuresByIp.size;
}

/**
 * How far a prune cuts back. Reclaiming a margin rather than a single slot keeps the sweep
 * amortized: at the cap, one prune in ten percent of inserts instead of one per insert.
 */
const PRUNE_TARGET = Math.floor(MAX_TRACKED_IPS * 0.9);

/**
 * Drop expired windows, then evict oldest-first down to {@link PRUNE_TARGET}. Called only once the
 * Map is over the cap, so the sweep costs nothing in normal operation.
 *
 * Entries are inserted in `first` order and never re-inserted while live, so Map iteration order is
 * oldest-first and the head is the closest to expiring anyway. Cutting a live lockout short is the
 * lesser failure: the alternative is an unbounded Map.
 */
function pruneFailures() {
  const now = Date.now();
  for (const [key, entry] of failuresByIp) {
    if (now - entry.first > FAILURE_WINDOW_MS) {
      failuresByIp.delete(key);
    }
  }
  let excess = failuresByIp.size - PRUNE_TARGET;
  for (const key of failuresByIp.keys()) {
    if (excess <= 0) {
      return;
    }
    failuresByIp.delete(key);
    excess -= 1;
  }
}

/** The configured secret, or `null` when remote logging is not enabled on this deployment. */
export function getLogToken() {
  const token = process.env.LOG_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on a length mismatch, which would itself leak length. Hash first so
  // the compared buffers are always the same size.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(left).digest(),
    crypto.createHash('sha256').update(right).digest(),
  );
}

/** The cookie value proving portal access: a hash of the token, never the token itself. */
export function cookieValueFor(token) {
  return crypto.createHash('sha256').update(`webapp-game-log:${token}`).digest('hex');
}

export function parsedUrl(req) {
  return new URL(req.url ?? '/', 'http://localhost');
}

export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers?.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        // Malformed percent-encoding (`webapp-game-log=%ZZ`) throws URIError. An unauthenticated
        // caller must get the 401 that a missing cookie gets, not a 500 from an uncaught throw.
        // Keep scanning rather than returning: a later, well-formed cookie of the same name is
        // still usable.
      }
    }
  }
  return null;
}

export function setSessionCookie(res, token, maxAgeSeconds = 12 * 60 * 60) {
  const attributes = [
    `${COOKIE_NAME}=${cookieValueFor(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // `Secure` would make the cookie unusable over plain-HTTP localhost during `npm run dev`.
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    attributes.push('Secure');
  }
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Whether the request carries a valid portal cookie. */
export function hasPortalCookie(req, token) {
  const cookie = readCookie(req);
  return cookie !== null && safeEqual(cookie, cookieValueFor(token));
}

/**
 * Whether `x-forwarded-for` may be believed.
 *
 * The header is caller-supplied unless something in front of this process overwrites it, and every
 * per-IP protection here is only as strong as the identity it keys on — a caller free to invent an
 * address per request never reaches a lockout at all, and grows the tracking Map while it tries.
 *
 * Vercel's edge sets the header itself, and there `req.socket.remoteAddress` is the internal hop,
 * identical for every request: trusting XFF is both safe and necessary, since the alternative keys
 * the whole world onto one bucket. Any other reverse-proxied deployment — the self-hosted Node mode
 * `_store.js` also supports — has to say so with `LOG_TRUST_PROXY=1`. A directly reachable process
 * must not, so that is the default.
 */
function trustsForwardedFor() {
  if (process.env.VERCEL) {
    return true;
  }
  const optIn = (process.env.LOG_TRUST_PROXY ?? '').trim().toLowerCase();
  return optIn !== '' && optIn !== '0' && optIn !== 'false';
}

/** Longest client address kept. The value can be caller-supplied and becomes a Map key. */
const MAX_IP_CHARS = 64;

export function clientIp(req) {
  if (trustsForwardedFor()) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim().slice(0, MAX_IP_CHARS);
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** True when this IP has failed too many `scope` attempts recently. */
export function isLockedOut(scope, ip) {
  const key = failureKey(scope, ip);
  const entry = failuresByIp.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failuresByIp.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(scope, ip) {
  const key = failureKey(scope, ip);
  const entry = failuresByIp.get(key);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) {
    // Delete before re-adding: `Map.set` on an existing key keeps its original position, which
    // would break the oldest-first iteration order `pruneFailures` evicts by.
    failuresByIp.delete(key);
    failuresByIp.set(key, { count: 1, first: Date.now() });
    if (failuresByIp.size > MAX_TRACKED_IPS) {
      pruneFailures();
    }
    return;
  }
  entry.count++;
}

export function clearFailures(scope, ip) {
  failuresByIp.delete(failureKey(scope, ip));
}

/**
 * Read and JSON-parse the request body, enforcing {@link MAX_BODY_BYTES}.
 *
 * The cap applies only when this function does the reading. Where the platform parsed the body
 * first — Vercel does — the bytes are already in memory and are returned untouched, so
 * `LOG_MAX_BODY_BYTES` has no effect there and the platform's own request-body limit (4.5 MB on
 * Vercel) is what bounds it. The cap is the real ceiling on the self-hosted Node and `npm run dev`
 * paths, where nothing else would impose one.
 */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Payload too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function sendEmpty(res, status) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * The fail-closed response: indistinguishable from "this deployment has no logging endpoints",
 * which is exactly what an unconfigured deployment should look like.
 */
export function sendNotFound(res) {
  res.statusCode = 404;
  res.setHeader('Cache-Control', 'no-store');
  res.end('Not found');
}
