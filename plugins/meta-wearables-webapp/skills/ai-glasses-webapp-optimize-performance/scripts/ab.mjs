#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// ab.mjs — interleaved A/B of two builds under the Meta Ray-Ban Display profile.
//
// Measuring A ten times and then B ten times does not work: machine state drifts across a
// batch, and the drift lands entirely on the difference. Alternating A,B,A,B… inside one
// session puts it on both arms, so what is left is the change.
//
//   node ab.mjs --a ./dist-before --b ./dist-after [--reps 10] --oracle "…" [--null]
//               --clear-storage [--grant-media]
// URL arms must be production previews, never development/HMR servers.
//   node ab.mjs --a http://127.0.0.1:5173 --b http://127.0.0.1:5174
//
// --null compares A against itself. Whatever that reports is your noise floor; a result
// smaller than it is not a result. Run it every time, in the same session.
// `--smoke` permits fewer than 10 pairs and the default oracle, but never valid evidence.
import {
  assertKnownArgs,
  flagArg,
  measureOnce,
  numArg,
  parseArgs,
  serveDir,
  sleep,
  strArg,
} from './lib/cdp.mjs';

const A = parseArgs(process.argv.slice(2));
assertKnownArgs(A, [
  'a', 'b', 'reps', 'oracle', 'null', 'clear-storage', 'grant-media', 'port',
  'smoke', 'labelA', 'labelB',
]);
const armASpec = strArg(A, 'a', undefined, { required: true });
const nullControl = flagArg(A, 'null');
const armBSpec = nullControl ? null : strArg(A, 'b', undefined, { required: true });
// parseArgs yields `true` for a valueless flag, and Number(true) is 1 — so `--reps` with no
// value would quietly run a single rep and report it as a result, which is the one thing this
// tool exists to prevent. Only a number or a numeric string is accepted.
const repsRaw = A.reps ?? 10;
const REPS =
  typeof repsRaw === 'number' || typeof repsRaw === 'string' ? Number(repsRaw) : Number.NaN;
// At least 2: with one pair `sd` divides by zero and prints NaN, and the permutation test can
// only return 1 or 0.5. A single pair is not a comparison, which is the whole premise here.
if (!Number.isInteger(REPS) || REPS < 2) {
  console.error(`--reps must be an integer >= 2 (got ${JSON.stringify(A.reps)}) — one pair is not a comparison`);
  process.exit(2);
}
const smoke = flagArg(A, 'smoke');
const resetStorage = flagArg(A, 'clear-storage');
const grantMedia = flagArg(A, 'grant-media');
if (!resetStorage) {
  console.error('--clear-storage is required so every pair starts from a declared cache state; use a throwaway Chrome profile');
  process.exit(2);
}
if (REPS < 10 && !smoke) {
  console.error('--reps must be at least 10 for a comparison; pass --smoke for a non-evidentiary plumbing check');
  process.exit(2);
}
const oracle = strArg(A, 'oracle', null);
const port = numArg(A, 'port', 9222, { max: 65535 });
if (!oracle && !smoke) {
  console.error('--oracle is required for an evidentiary comparison; it must identify usable app content and exclude overlays');
  process.exit(2);
}

// Validate both arms before opening either local server. Otherwise a malformed B URL can
// leave A's server alive while argument parsing aborts.
const armARemoteUrl = remoteUrlOrNull(armASpec);
const armBRemoteUrl = nullControl ? armARemoteUrl : remoteUrlOrNull(armBSpec);

const servers = [];
// Port 0 lets the OS pick a free one. Fixed ports mean a second concurrent run — or anything
// else already on 9351 — dies with an unhandled EADDRINUSE.
async function resolveArm(spec, remoteUrl) {
  if (remoteUrl) return { url: remoteUrl, close: async () => {} };
  const s = await serveDir(spec, 0);
  servers.push(s);
  return s;
}

const labelA = strArg(A, 'labelA', armASpec);
const labelB = nullControl
  ? `${labelA} (null control)`
  : strArg(A, 'labelB', armBSpec);

const got = [[], []];
try {
  const armA = await resolveArm(armASpec, armARemoteUrl);
  const armB = nullControl
    ? await resolveArm(armASpec, armARemoteUrl)
    : await resolveArm(armBSpec, armBRemoteUrl);
  for (let i = 0; i < REPS; i++) {
    // Alternate which arm leads, so neither one is always the one that runs second.
    const order = i % 2 === 0 ? [0, 1] : [1, 0];
    for (const arm of order) {
      const url = arm === 0 ? armA.url : armB.url;
      got[arm].push(await measureOnce({
        url,
        oracle,
        port,
        grantMedia,
        resetStorage,
      }));
      await sleep(400);
    }
  }
} finally {
  await Promise.all(servers.map((server) => server.close()));
}

const visA = got[0].map((r) => r.visible);
const visB = got[1].map((r) => r.visible);
const developmentResources = [
  ...new Set(got.flat().flatMap((run) => run.developmentResources || [])),
];
if (developmentResources.length) {
  console.error('  A development/HMR resource was loaded; compare production output instead:');
  for (const resource of developmentResources) console.error(`     ${resource}`);
  process.exit(1);
}
const webSocketUrls = [...new Set(got.flat().flatMap((run) => run.webSocketUrls || []))];
if (webSocketUrls.length) {
  console.error('  WebSocket traffic is present but not included in HTTP wire totals:');
  for (const resource of webSocketUrls) console.error(`     ${resource}`);
  process.exit(1);
}
const failedRequests = got.flat().flatMap((run) => run.failedRequests || []);
if (failedRequests.length) {
  console.error('  HTTP request failures make the wire comparison incomplete:');
  for (const failure of failedRequests.slice(0, 10)) {
    console.error(`     ${failure.url} (${failure.reason})`);
  }
  process.exit(1);
}
const timeoutPhases = got.flat().map((run) => run.timeoutPhase).filter(Boolean);
if (timeoutPhases.length) {
  console.error(`  The per-run deadline expired during: ${[...new Set(timeoutPhases)].join(', ')}.`);
  process.exit(1);
}
const originMismatchRuns = got.flat().filter((run) => !run.originMatches).length;
if (originMismatchRuns) {
  console.error('  An arm redirected to another origin; rerun with each final production URL.');
  process.exit(1);
}
const incompleteNetworkRuns = got.flat().filter((run) => !run.networkComplete).length;
if (incompleteNetworkRuns) {
  console.error(
    `  ${incompleteNetworkRuns}/${REPS * 2} run(s) did not reach network idle; ` +
      'wire bytes and request counts are incomplete.',
  );
  process.exit(1);
}
if (visA.some((v) => v == null) || visB.some((v) => v == null)) {
  console.log('  The oracle did not fire on every run — fix --oracle before comparing anything.');
  process.exit(1);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// Paired, because interleaving is what makes the pairing meaningful: flip signs within pairs.
const pairs = visA.map((v, i) => v - visB[i]);
const obs = mean(pairs);
let hits = 0;
const N = 200000;
for (let k = 0; k < N; k++) {
  let s = 0;
  for (const d of pairs) s += Math.random() < 0.5 ? d : -d;
  if (Math.abs(s / pairs.length) >= Math.abs(obs)) hits++;
}
const p = hits / N;
const wireA = Math.round(mean(got[0].map((r) => r.wire)));
const wireB = Math.round(mean(got[1].map((r) => r.wire)));

console.log(`  A  ${labelA}`);
console.log(`     visible ${Math.round(mean(visA))} ms (sd ${Math.round(sd(visA))})   HTTP wire ${wireA.toLocaleString()} B`);
console.log(`  B  ${labelB}`);
console.log(`     visible ${Math.round(mean(visB))} ms (sd ${Math.round(sd(visB))})   HTTP wire ${wireB.toLocaleString()} B`);
console.log(
  `  B is ${Math.abs(Math.round(obs))} ms ${obs > 0 ? 'faster' : 'slower'} than A   ` +
    `p=${p.toFixed(4)}   HTTP wire ${(wireB - wireA).toLocaleString()} B`,
);
if (nullControl) {
  console.log(`  This was a null control: the truth is 0 ms. Treat anything smaller than`);
  console.log(`  ${Math.abs(Math.round(obs))} ms as indistinguishable from nothing, whatever p says.`);
} else {
  console.log(`  Now run the same command with --null to get the noise floor for this session.`);
}
if (smoke) console.log('  SMOKE ONLY: this comparison cannot support a performance claim.');
process.exitCode = 0;

function remoteUrlOrNull(spec) {
  // Preserve absolute Windows paths even though URL parses their drive letter as a scheme.
  if (/^[a-z]:[\\/]/i.test(spec)) return null;
  try {
    const parsed = new URL(spec);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.error(`A/B URL arms must use HTTP(S) (got ${JSON.stringify(spec)})`);
      process.exit(2);
    }
    return parsed.href;
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      console.error(`A/B URL arms must be absolute HTTP(S) URLs (got ${JSON.stringify(spec)})`);
      process.exit(2);
    }
    return null;
  }
}
