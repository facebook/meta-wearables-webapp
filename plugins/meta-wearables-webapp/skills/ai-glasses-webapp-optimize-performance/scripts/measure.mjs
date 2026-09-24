#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// measure.mjs — measure a webapp's startup under the Meta Ray-Ban Display profile, over CDP.
//
// No device and no npm install. Needs Node 22+ and a Chrome started with
//   --remote-debugging-port=9222 --user-data-dir=<unique temporary directory>
//
// Point --url at a production preview, never a development/HMR server.
//   node measure.mjs --url http://127.0.0.1:5173 [--reps 10] [--warm] [--by-type]
//                    --oracle "<js expression that is true only when the app is usable>"
//                    --clear-storage [--port 9222] [--timeout 60000]
//                    [--grant-media] [--json]
// `--smoke` permits fewer than 10 runs and the default oracle, but never valid evidence.
//
// Reports the median over N loads plus the spread. One run is not a measurement: see SKILL.md.
import {
  assertKnownArgs,
  flagArg,
  httpUrlArg,
  measureOnce,
  numArg,
  parseArgs,
  sleep,
  strArg,
} from './lib/cdp.mjs';

const A = parseArgs(process.argv.slice(2));
assertKnownArgs(A, [
  'url', 'reps', 'warm', 'by-type', 'oracle', 'clear-storage', 'port', 'timeout',
  'grant-media', 'json', 'smoke',
]);
const URL_ARG = httpUrlArg(A);
// parseArgs yields `true` for a valueless flag, and Number(true) is 1 — so `--reps` with no
// value would quietly run a single rep and report it as a result, which is the one thing this
// tool exists to prevent. Only a number or a numeric string is accepted.
const repsRaw = A.reps ?? 10;
const REPS =
  typeof repsRaw === 'number' || typeof repsRaw === 'string' ? Number(repsRaw) : Number.NaN;
if (!Number.isInteger(REPS) || REPS < 1) {
  console.error(`--reps must be a positive integer (got ${JSON.stringify(A.reps)})`);
  process.exit(2);
}
const smoke = flagArg(A, 'smoke');
const resetStorage = flagArg(A, 'clear-storage');
const grantMedia = flagArg(A, 'grant-media');
const warm = flagArg(A, 'warm');
const json = flagArg(A, 'json');
const byType = flagArg(A, 'by-type');
if (!resetStorage) {
  console.error('--clear-storage is required so every run starts from a declared cache state; use a throwaway Chrome profile');
  process.exit(2);
}
if (REPS < 10 && !smoke) {
  console.error('--reps must be at least 10 for a measurement; pass --smoke for a non-evidentiary plumbing check');
  process.exit(2);
}
const oracle = strArg(A, 'oracle', null);
const port = numArg(A, 'port', 9222, { max: 65535 });
const timeoutMs = numArg(A, 'timeout', 60000);
if (!oracle && !smoke) {
  console.error('--oracle is required for an evidentiary run; it must identify usable app content and exclude overlays');
  process.exit(2);
}

const runs = [];
for (let i = 0; i < REPS; i++) {
  runs.push(await measureOnce({
    url: URL_ARG,
    warm,
    oracle,
    port,
    timeoutMs,
    grantMedia,
    resetStorage,
  }));
  await sleep(400);
}

const med = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const middle = Math.floor(s.length / 2);
  return s.length % 2 ? s[middle] : Math.round((s[middle - 1] + s[middle]) / 2);
};
const spread = (xs) => {
  const s = xs.filter((x) => x != null);
  return s.length > 1 ? Math.round(Math.max(...s) - Math.min(...s)) : 0;
};

const vis = runs.map((r) => r.visible);
const missed = vis.filter((v) => v == null).length;
const missingFcpRuns = runs.filter((run) => run.fcp == null).length;
const developmentResources = [...new Set(runs.flatMap((run) => run.developmentResources || []))];
const webSocketUrls = [...new Set(runs.flatMap((run) => run.webSocketUrls || []))];
const failedRequests = runs.flatMap((run) => run.failedRequests || []);
const originMismatchRuns = runs.filter((run) => !run.originMatches).length;
const incompleteNetworkRuns = runs.filter((run) => !run.networkComplete).length;
const timeoutPhases = runs.map((run) => run.timeoutPhase).filter(Boolean);
const out = {
  url: URL_ARG,
  mode: warm ? 'warm' : 'cold',
  reps: REPS,
  fcp_ms: med(runs.map((r) => r.fcp)),
  visible_ms: med(vis),
  visible_spread_ms: spread(vis),
  wire_bytes: med(runs.map((r) => r.wire)),
  wire_scope: 'completed HTTP(S) responses; WebSocket traffic is not counted',
  requests: med(runs.map((r) => r.requests)),
  oracleNeverFired: missed,
  fcpMissing: missingFcpRuns,
  developmentResources,
  webSocketUrls,
  failedRequests,
  originMismatchRuns,
  incompleteNetworkRuns,
  timeoutPhases,
  valid:
    missed === 0 && missingFcpRuns === 0 && incompleteNetworkRuns === 0
    && developmentResources.length === 0 && webSocketUrls.length === 0
    && failedRequests.length === 0 && originMismatchRuns === 0 && timeoutPhases.length === 0
    && REPS >= 10 && !!oracle && !smoke,
};

if (json) {
  console.log(JSON.stringify({ ...out, runs }, null, 2));
} else {
  console.log(
    `  ${out.mode.padEnd(5)} n=${REPS}  FCP ${out.fcp_ms ?? 'NEVER'} ms   ` +
      `visible ${out.visible_ms ?? 'NEVER'} ms (spread ${out.visible_spread_ms})   ` +
      `HTTP wire ${(out.wire_bytes ?? 0).toLocaleString()} B   reqs ${out.requests ?? 0}`,
  );
  if (missed) {
    console.log(
      `  WARNING: the oracle never fired on ${missed}/${REPS} runs, after waiting ` +
        `${Math.round(Math.max(...runs.map((r) => r.waited || 0)) / 1000)}s. Either the app did not\n` +
        `  load, --oracle is wrong, or --timeout is too short. These numbers are not a measurement yet.`,
    );
  }
  if (missingFcpRuns) {
    console.log(`  ERROR: FCP was unavailable in ${missingFcpRuns}/${REPS} run(s); the result is incomplete.`);
  }
  if (originMismatchRuns) {
    console.log(
      `  ERROR: ${originMismatchRuns}/${REPS} run(s) ended on another origin; ` +
        'rerun with the final production URL so its state can be cleared.',
    );
  }
  if (developmentResources.length) {
    console.log('  ERROR: a development/HMR resource was loaded; build and serve the production output before measuring.');
    for (const resource of developmentResources) console.log(`     ${resource}`);
  }
  if (incompleteNetworkRuns) {
    console.log(
      `  ERROR: ${incompleteNetworkRuns}/${REPS} run(s) did not reach network idle; ` +
        'wire bytes and request counts are incomplete.',
    );
  }
  if (timeoutPhases.length) {
    console.log(`  ERROR: the per-run deadline expired during: ${[...new Set(timeoutPhases)].join(', ')}.`);
  }
  if (webSocketUrls.length) {
    console.log('  ERROR: WebSocket traffic is present but not included in HTTP wire totals:');
    for (const resource of webSocketUrls) console.log(`     ${resource}`);
  }
  if (failedRequests.length) {
    console.log('  ERROR: HTTP request failures make the wire total incomplete:');
    for (const failure of failedRequests.slice(0, 10)) {
      console.log(`     ${failure.url} (${failure.reason})`);
    }
  }
  if (smoke) console.log('  SMOKE ONLY: this run cannot support a performance claim.');
  if (byType) {
    const t = runs[runs.length - 1].byType;
    console.log('  bytes by type (last run), with what each costs on a 500 Kbps link:');
    for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(v).padStart(9)} B  ${k.padEnd(12)} ~${Math.round(v / 62.5)} ms`);
    }
  }
}
process.exitCode =
  missed || missingFcpRuns || incompleteNetworkRuns || developmentResources.length
  || webSocketUrls.length || failedRequests.length || originMismatchRuns || timeoutPhases.length ? 1 : 0;
