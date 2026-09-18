/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `/api/log-auth` — portal sign-in.
 *
 * - **POST `{ "token": "…" }`** — on a match, sets an HttpOnly cookie granting read access to
 *   `/api/logs`. The portal page never embeds or stores the secret itself; the browser holds an
 *   opaque cookie that JavaScript cannot read.
 * - **DELETE** — sign out.
 *
 * With `LOG_TOKEN` unset this 404s, like every other logging endpoint.
 *
 * Guessing is made tedious rather than impossible: comparison is constant-time, every failure
 * costs a fixed delay, and an IP that fails repeatedly is locked out for a while (see `_http.js`).
 * The real protection is that `LOG_TOKEN` is a secret you chose and never committed.
 */

import {
  clearFailures,
  clearSessionCookie,
  clientIp,
  delayFailure,
  getLogToken,
  isLockedOut,
  readJsonBody,
  recordFailure,
  safeEqual,
  sendEmpty,
  sendJson,
  sendNotFound,
  setSessionCookie,
} from './_http.js';

/** This endpoint's failure budget, kept separate from `/api/logs` ingest. */
const SCOPE = 'auth';

export default async function handler(req, res) {
  const token = getLogToken();
  if (token === null) {
    sendNotFound(res);
    return;
  }

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    sendEmpty(res, 204);
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    sendEmpty(res, 405);
    return;
  }

  const ip = clientIp(req);
  if (isLockedOut(SCOPE, ip)) {
    await delayFailure();
    sendJson(res, 429, { error: 'too many attempts — wait a few minutes' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendEmpty(res, error.statusCode ?? 400);
    return;
  }

  const provided = typeof body?.token === 'string' ? body.token : '';
  if (provided === '' || !safeEqual(provided, token)) {
    recordFailure(SCOPE, ip);
    await delayFailure();
    sendJson(res, 401, { error: 'incorrect passcode' });
    return;
  }

  clearFailures(SCOPE, ip);
  setSessionCookie(res, token);
  sendJson(res, 200, { ok: true });
}
