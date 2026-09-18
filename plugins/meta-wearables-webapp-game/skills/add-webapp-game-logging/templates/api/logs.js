/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `/api/logs` — the remote-logging endpoint.
 *
 * - **POST** (from the game on the glasses, authenticated by `?k=<LOG_TOKEN>`): append a batch.
 *   The token rides in the query string because `navigator.sendBeacon` — the transport used for
 *   the final flush during a crash or backgrounding — cannot set headers.
 * - **GET** (from the portal, authenticated by the HttpOnly cookie set by `/api/log-auth`):
 *   read records newer than `?since=<cursor>`.
 *
 * With `LOG_TOKEN` unset, both verbs 404: an unconfigured deployment has no logging endpoints at
 * all. A wrong `?k=` is delayed and counted against a per-IP budget, the same treatment portal
 * sign-in gets. See `_http.js` for the rest of the security posture and `_store.js` for storage.
 */

import {
  clientIp,
  delayFailure,
  getLogToken,
  isLockedOut,
  parsedUrl,
  hasPortalCookie,
  readJsonBody,
  recordFailure,
  safeEqual,
  sendEmpty,
  sendJson,
  sendNotFound,
} from './_http.js';
import { getStore } from './_store.js';

/** This endpoint's failure budget, kept separate from `/api/log-auth` portal sign-in. */
const INGEST_SCOPE = 'ingest';

/** Never return more than this many records in one poll, however far behind the portal is. */
const MAX_READ = 500;

/** Records per POST. The client batches at 50; this is the abuse ceiling, not the normal path. */
const MAX_RECORDS_PER_BATCH = 500;

/** Longest single log message kept. Truncated rather than rejected, so the batch still lands. */
const MAX_MESSAGE_CHARS = 4000;

const LEVELS = new Set(['error', 'warn', 'info', 'debug', 'trace']);

/**
 * Coerce a client-supplied record into a known shape. Everything here arrives from a device over
 * the public internet, so nothing is trusted: fields are whitelisted, types are forced, and sizes
 * are capped. The portal additionally renders every value as text, never as markup.
 */
function sanitize(record, sessionId, receivedAt) {
  const level = LEVELS.has(record?.level) ? record.level : 'info';
  const message = String(record?.message ?? '').slice(0, MAX_MESSAGE_CHARS);
  const entry = {
    sessionId: String(sessionId).slice(0, 64),
    receivedAt,
    seq: Number.isFinite(record?.seq) ? Number(record.seq) : null,
    time: Number.isFinite(record?.time) ? Number(record.time) : receivedAt,
    level,
    scope: String(record?.scope ?? '').slice(0, 64),
    message,
  };
  if (record?.data !== undefined && record.data !== null) {
    // Round-trip through JSON so only plain data survives, capped so one record can't fill the store.
    try {
      entry.data = JSON.parse(JSON.stringify(record.data));
      const encoded = JSON.stringify(entry.data);
      if (encoded.length > MAX_MESSAGE_CHARS) {
        entry.data = { truncated: `${encoded.slice(0, MAX_MESSAGE_CHARS)}…` };
      }
    } catch {
      entry.data = { unserializable: true };
    }
  }
  return entry;
}

/**
 * Reject an ingest attempt that did not present the token.
 *
 * `?k=` holds the same secret as the portal passcode, so an ingest endpoint that answers wrong
 * guesses instantly and forever is a guessing oracle for portal access. Charge the same delay and
 * the same per-IP budget `/api/log-auth` charges.
 *
 * The key is checked *before* this runs, so a caller that presents the right token is never
 * throttled — the game's own `RemoteLogSink` posts every couple of seconds from one address and
 * must not be able to throttle itself. For the same reason a success does not clear the counter:
 * behind a NAT the game's traffic would otherwise reset an attacker's budget continuously.
 */
async function rejectIngest(req, res) {
  const ip = clientIp(req);
  const throttled = isLockedOut(INGEST_SCOPE, ip);
  if (!throttled) {
    recordFailure(INGEST_SCOPE, ip);
  }
  await delayFailure();
  if (throttled) {
    // 429 rather than 401: `RemoteLogSink` treats 401 as permanent and disables itself, but retries
    // 429 with exponential backoff. A well-behaved client that merely shares an egress IP with
    // whoever was guessing should come back, not go silent for the rest of the session.
    sendJson(res, 429, { error: 'too many attempts — wait a few minutes' });
    return;
  }
  // 401 tells the client's RemoteLogSink to disable itself instead of retrying forever.
  sendEmpty(res, 401);
}

async function handlePost(req, res, token) {
  const url = parsedUrl(req);
  const provided = url.searchParams.get('k');
  if (provided === null || !safeEqual(provided, token)) {
    await rejectIngest(req, res);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendEmpty(res, error.statusCode ?? 400);
    return;
  }

  if (!body || !Array.isArray(body.records)) {
    sendJson(res, 400, { error: 'expected { sessionId, records: [] }' });
    return;
  }

  const receivedAt = Date.now();
  const sessionId = String(body.sessionId ?? 'unknown').slice(0, 64);

  // The synthetic records are built first so they count against MAX_RECORDS_PER_BATCH. Appending
  // them afterwards would let a full batch exceed the ceiling the cap is supposed to enforce.
  const leading = [];
  if (body.meta && typeof body.meta === 'object') {
    leading.push(
      sanitize(
        { level: 'info', scope: 'session', message: 'session started', data: body.meta },
        sessionId,
        receivedAt,
      ),
    );
  }
  // Surface a client-side drop as a real record, so the portal shows the gap.
  if (Number.isFinite(body.dropped) && body.dropped > 0) {
    leading.push(
      sanitize(
        { level: 'warn', message: `${Number(body.dropped)} record(s) dropped on the device before sending` },
        sessionId,
        receivedAt,
      ),
    );
  }

  const entries = [
    ...leading,
    ...body.records
      .slice(0, MAX_RECORDS_PER_BATCH - leading.length)
      .map((record) => sanitize(record, sessionId, receivedAt)),
  ];

  if (entries.length > 0) {
    await getStore().append(entries);
  }
  sendEmpty(res, 204);
}

async function handleGet(req, res, token) {
  if (!hasPortalCookie(req, token)) {
    sendJson(res, 401, { error: 'not authenticated' });
    return;
  }

  const url = parsedUrl(req);
  const since = Number(url.searchParams.get('since') ?? 0);
  const store = getStore();
  const { entries, cursor } = await store.read(Number.isFinite(since) ? since : 0, MAX_READ);

  sendJson(res, 200, {
    entries,
    cursor,
    store: { kind: store.kind, ephemeral: store.ephemeral },
  });
}

export default async function handler(req, res) {
  const token = getLogToken();
  if (token === null) {
    sendNotFound(res);
    return;
  }

  if (req.method === 'POST') {
    await handlePost(req, res, token);
    return;
  }
  if (req.method === 'GET') {
    await handleGet(req, res, token);
    return;
  }
  res.setHeader('Allow', 'GET, POST');
  sendEmpty(res, 405);
}
