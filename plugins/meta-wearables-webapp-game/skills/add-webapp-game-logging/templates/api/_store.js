/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Log storage for the remote-logging backend. Underscore-prefixed so Vercel treats it as a helper
 * module rather than routing it as a function.
 *
 * Three backends, auto-selected in this order:
 *
 * 1. **Upstash Redis** — when `KV_REST_API_URL` / `KV_REST_API_TOKEN` are set. Durable: survives
 *    cold starts and is shared across instances, so you can close the portal, keep playing, and
 *    come back to a complete log. This is the recommended setup for real use.
 * 2. **File (JSONL)** — when a persistent filesystem exists (i.e. not running on serverless).
 *    Covers `npm run dev` on your laptop and any self-hosted Node deployment; you can also just
 *    `cat` the file.
 * 3. **Memory ring buffer** — the zero-setup fallback. Works, but a serverless platform can hand
 *    the next request to a different (or cold) instance, which has its own empty buffer. Records
 *    can therefore go missing. The portal shows a banner in this mode so a gap is explained rather
 *    than mysterious — see `ephemeral` below.
 *
 * Every backend exposes the same tiny interface:
 *   append(entries) -> void        add records
 *   read(sinceId, limit) -> {entries, cursor}   records with id > sinceId
 *   kind, ephemeral                for the portal's status banner
 *
 * `id` is a server-assigned, monotonically increasing cursor. The client's own `seq` is per
 * session, so it can't order two sessions or drive incremental polling; `id` can.
 */

import fs from 'node:fs';
import path from 'node:path';

import { envNumber } from './_http.js';

/** Cap on retained records. Old records are evicted first. */
const MAX_ENTRIES = envNumber('LOG_MAX_ENTRIES', 2000);

/** Where the file store writes. Relative paths resolve against the process cwd. */
const LOG_DIR = process.env.LOG_DIR ?? '.logs';

/** Serverless platforms have no persistent, shared filesystem — `/tmp` is per-instance. */
function hasPersistentFilesystem() {
  return !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.NETLIFY;
}

/**
 * The id the portal should poll from next: the last one actually returned, not the store's
 * high-water mark. `read` caps its result at `limit`, so reporting the high-water mark would
 * advance the portal past the records the cap withheld and they would never be sent. An empty
 * batch reports `sinceId` back, leaving the watermark where it was.
 */
function batchCursor(entries, sinceId) {
  return entries.length === 0 ? sinceId : entries[entries.length - 1].id;
}

function createMemoryStore() {
  const entries = [];
  let nextId = 1;
  return {
    kind: 'memory',
    ephemeral: true,
    async append(records) {
      for (const record of records) {
        entries.push({ ...record, id: nextId++ });
      }
      if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
      }
    },
    async read(sinceId, limit) {
      const matching = entries.filter((entry) => entry.id > sinceId).slice(0, limit);
      return { entries: matching, cursor: batchCursor(matching, sinceId) };
    },
  };
}

function createFileStore(dir) {
  const file = path.join(dir, 'game-logs.jsonl');
  fs.mkdirSync(dir, { recursive: true });

  const readAll = () => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const parsed = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // A torn final line from a concurrent append — skip it rather than failing the read.
      }
    }
    return parsed;
  };

  return {
    kind: 'file',
    ephemeral: false,
    file,
    async append(records) {
      const existing = readAll();
      let nextId = existing.length === 0 ? 1 : existing[existing.length - 1].id + 1;
      const stamped = records.map((record) => ({ ...record, id: nextId++ }));

      // Rewrite (rather than append) once the file outgrows twice the cap, so it stays bounded
      // without a separate rotation job.
      if (existing.length + stamped.length > MAX_ENTRIES * 2) {
        const kept = [...existing, ...stamped].slice(-MAX_ENTRIES);
        fs.writeFileSync(file, `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
        return;
      }
      fs.appendFileSync(file, `${stamped.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    },
    async read(sinceId, limit) {
      const matching = readAll()
        .filter((entry) => entry.id > sinceId)
        .slice(0, limit);
      return { entries: matching, cursor: batchCursor(matching, sinceId) };
    },
  };
}

/**
 * Upstash Redis over its REST API — no client library, just `fetch`. A Redis LIST with `LTRIM` is
 * exactly a ring buffer, and `INCR` gives the shared cursor.
 */
function createRedisStore(baseUrl, token) {
  const listKey = process.env.LOG_REDIS_KEY ?? 'webapp-game:logs';
  const counterKey = `${listKey}:cursor`;

  const pipeline = async (commands) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!response.ok) {
      throw new Error(`Upstash request failed: ${response.status}`);
    }
    return response.json();
  };

  return {
    kind: 'redis',
    ephemeral: false,
    async append(records) {
      // `RPUSH key` with no values is not a valid Redis command, so an empty batch would throw.
      if (records.length === 0) {
        return;
      }
      // Reserve a contiguous id block, then push the records stamped with it.
      const [{ result: end }] = await pipeline([['INCRBY', counterKey, String(records.length)]]);
      const start = Number(end) - records.length + 1;
      const stamped = records.map((record, index) => JSON.stringify({ ...record, id: start + index }));
      await pipeline([
        ['RPUSH', listKey, ...stamped],
        ['LTRIM', listKey, String(-MAX_ENTRIES), '-1'],
      ]);
    },
    async read(sinceId, limit) {
      const [{ result: raw }] = await pipeline([['LRANGE', listKey, '0', '-1']]);
      const entries = [];
      for (const line of raw ?? []) {
        try {
          const entry = JSON.parse(line);
          if (entry.id > sinceId) {
            entries.push(entry);
          }
        } catch {
          // Ignore an unparseable entry rather than breaking the whole read.
        }
      }
      const matching = entries.slice(0, limit);
      return { entries: matching, cursor: batchCursor(matching, sinceId) };
    },
  };
}

let store;

/** The process-wide store, created once per instance. */
export function getStore() {
  if (store) {
    return store;
  }
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    store = createRedisStore(redisUrl, redisToken);
  } else if (hasPersistentFilesystem()) {
    try {
      store = createFileStore(path.resolve(LOG_DIR));
    } catch {
      // An unwritable directory shouldn't take the endpoint down — degrade to memory.
      store = createMemoryStore();
    }
  } else {
    store = createMemoryStore();
  }
  return store;
}
