#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Smoke-test the remote-logging backend against a real dev server.
 *
 * This is the mechanical half of Step 4: prove the endpoints exist, authenticate, ingest, read
 * back, that they fail closed with no `LOG_TOKEN`, and that a bare `npm run dev` — the command a
 * developer actually types, with the token only in `.env` — works. Previously the agent hand-wrote
 * this as a dozen curl invocations every time.
 *
 * The half this does NOT replace is the consent sequence (gate appears before the game, nothing
 * is POSTed before accepting, decline still runs the game). That is the privacy contract and is
 * still worth walking by hand in a browser — see Step 4 of SKILL.md.
 *
 * Usage:
 *   node smoke-log-api.mjs [--project <dir>] [--token <token>] [--port <port>]
 *
 * Exits 0 with a PASS summary, or non-zero listing the failed checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = { project: process.cwd(), port: 5199 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') out.project = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else {
      console.error(`smoke-log-api: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read LOG_TOKEN out of `.env` so the caller usually doesn't have to pass it. */
function tokenFromEnvFile(project) {
  const file = path.join(project, '.env');
  if (!fs.existsSync(file)) return undefined;
  const match = fs.readFileSync(file, 'utf8').match(/^LOG_TOKEN=(.*)$/m);
  return match ? match[1].trim() : undefined;
}

async function startDevServer(project, port, env) {
  // An `undefined` value means "make this variable genuinely absent", which is not the same as
  // the empty string: the bare-`npm run dev` phase has to run with no inherited LOG_TOKEN even
  // when the developer has one exported in their shell.
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }

  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: project,
    env: childEnv,
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`dev server exited early (code ${child.exitCode})`);
    try {
      await fetch(`${base}/`, { signal: AbortSignal.timeout(500) });
      return { child, base };
    } catch {
      await sleep(200);
    }
  }
  child.kill('SIGKILL');
  throw new Error(`dev server did not come up on ${base} within 20s`);
}

async function stopDevServer(server) {
  if (!server) return;
  server.child.kill('SIGTERM');
  for (let i = 0; i < 25 && server.child.exitCode === null; i += 1) await sleep(100);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
  // Vite holds the port briefly after exit; --strictPort would fail the next start.
  await sleep(300);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = path.resolve(args.project);
  const envFileToken = tokenFromEnvFile(project);
  const token = args.token ?? envFileToken;
  if (!token) {
    console.error('smoke-log-api: no token — pass --token or set LOG_TOKEN in .env');
    process.exit(1);
  }

  // Don't pollute the developer's log store: snapshot it and put it back afterwards.
  const logsDir = path.join(project, '.logs');
  const logsFile = path.join(logsDir, 'game-logs.jsonl');
  const logsDirExisted = fs.existsSync(logsDir);
  const previousLogs = fs.existsSync(logsFile) ? fs.readFileSync(logsFile) : null;

  let server;
  try {
    // --- Phase 1: configured (LOG_TOKEN set) ---
    server = await startDevServer(project, args.port, { LOG_TOKEN: token });
    const { base } = server;

    const ingest = await fetch(`${base}/api/logs?k=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'smoke-test',
        meta: { source: 'smoke-log-api' },
        records: [{ level: 'info', scope: 'smoke', message: 'hello from smoke-log-api', seq: 1, time: Date.now() }],
      }),
    });
    check('POST /api/logs with token → 204', ingest.status === 204, `got ${ingest.status}`);

    const badIngest = await fetch(`${base}/api/logs?k=definitely-wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'smoke-test', records: [] }),
    });
    check('POST /api/logs with wrong token → 401', badIngest.status === 401, `got ${badIngest.status}`);

    const signIn = await fetch(`${base}/api/log-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const cookie = signIn.headers.get('set-cookie');
    check('POST /api/log-auth with token → 200 + cookie', signIn.status === 200 && Boolean(cookie), `got ${signIn.status}, cookie=${Boolean(cookie)}`);

    const tail = await fetch(`${base}/api/logs?since=0`, {
      headers: cookie ? { cookie: cookie.split(';')[0] } : {},
    });
    const body = tail.ok ? await tail.json() : null;
    const found = body?.entries?.some((e) => e.message === 'hello from smoke-log-api');
    check('GET /api/logs with cookie returns the ingested record', tail.status === 200 && found === true, `status ${tail.status}, entries ${body?.entries?.length ?? 0}`);

    const noCookie = await fetch(`${base}/api/logs?since=0`);
    check('GET /api/logs without cookie → 401', noCookie.status === 401, `got ${noCookie.status}`);

    const portal = await fetch(`${base}/logs.html`);
    check('GET /logs.html serves the portal', portal.status === 200, `got ${portal.status}`);

    await stopDevServer(server);
    server = undefined;

    // --- Phase 2: unconfigured (no LOG_TOKEN) — the fail-closed contract ---
    server = await startDevServer(project, args.port, { LOG_TOKEN: '' });
    const base2 = server.base;

    const closedIngest = await fetch(`${base2}/api/logs?k=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'smoke-test', records: [] }),
    });
    check('fail-closed: POST /api/logs without LOG_TOKEN → 404', closedIngest.status === 404, `got ${closedIngest.status}`);

    const closedAuth = await fetch(`${base2}/api/log-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    check('fail-closed: POST /api/log-auth without LOG_TOKEN → 404', closedAuth.status === 404, `got ${closedAuth.status}`);

    await stopDevServer(server);
    server = undefined;

    // --- Phase 3: a bare `npm run dev`, with the token coming only from `.env` ---
    // Phases 1 and 2 both inject LOG_TOKEN into the server's environment, so neither exercises
    // what a developer actually runs. The dev-server plugin loads `.env` itself; if that ever
    // regresses, the portal rejects the right passcode with "not enabled on this deployment".
    if (envFileToken) {
      server = await startDevServer(project, args.port, { LOG_TOKEN: undefined });
      const base3 = server.base;

      const envIngest = await fetch(`${base3}/api/logs?k=${encodeURIComponent(envFileToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'smoke-test',
          records: [{ level: 'info', scope: 'smoke', message: 'hello from .env', seq: 1, time: Date.now() }],
        }),
      });
      check('bare `npm run dev`: POST /api/logs with the .env token → 204', envIngest.status === 204, `got ${envIngest.status}`);

      const envAuth = await fetch(`${base3}/api/log-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: envFileToken }),
      });
      check('bare `npm run dev`: POST /api/log-auth with the .env token → 200', envAuth.status === 200, `got ${envAuth.status}`);
    } else {
      console.log('note: no LOG_TOKEN in .env, so the bare `npm run dev` phase was skipped.');
    }
  } catch (error) {
    check('harness', false, String(error?.message ?? error));
  } finally {
    await stopDevServer(server);
    if (previousLogs !== null) fs.writeFileSync(logsFile, previousLogs);
    else if (!logsDirExisted) fs.rmSync(logsDir, { recursive: true, force: true });
    else fs.rmSync(logsFile, { force: true });
  }

  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nsmoke-log-api: ${failed.length} of ${results.length} checks failed`);
    process.exit(1);
  }
  console.log(`\nPASS — all ${results.length} checks passed.`);
}

main();
