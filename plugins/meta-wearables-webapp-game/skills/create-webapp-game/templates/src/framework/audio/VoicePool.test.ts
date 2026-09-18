/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Unit tests for the concurrency rules. VoicePool has no Web Audio in it, so these
 * run in plain Node with no AudioContext mock — which is the whole reason the pool
 * was split out of AudioEngine.
 *
 * Convention in here: `admit()` mirrors what AudioEngine.play() does — plan, apply
 * the evictions, then record the new voice — so a test reads like a play sequence.
 */

import { describe, expect, it } from 'vitest';
import { VoicePool, type VoiceConstraint, type VoiceHandle } from './VoicePool';

const GLOBAL = 24;

function group(
  groupId: string,
  limit: number,
  strategy: VoiceConstraint['strategy'] = 'killOldest',
): VoiceConstraint {
  return { groupId, limit, strategy };
}

/** Plan + apply, returning the new handle or null when refused. */
function admit(
  pool: VoicePool,
  constraints: VoiceConstraint[],
  handle: VoiceHandle,
  { loop = false, globalLimit = GLOBAL } = {},
): VoiceHandle | null {
  const plan = pool.plan(constraints, globalLimit);
  if (!plan.admitted) return null;
  for (const victim of plan.evict) pool.remove(victim);
  pool.add(
    handle,
    constraints.map((c) => c.groupId),
    loop,
  );
  return handle;
}

describe('private (per-event) limits', () => {
  it('a limit of 1 steals the previous voice on every retrigger', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:UI_Click', 1)];

    expect(admit(pool, constraints, 1)).toBe(1);
    expect(admit(pool, constraints, 2)).toBe(2);

    expect(pool.countInGroup('@event:UI_Click')).toBe(1);
    expect(pool.has(1)).toBe(false);
    expect(pool.has(2)).toBe(true);
  });

  it('a limit of 3 stacks three voices and steals the oldest on the fourth', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:Match', 3)];

    for (const handle of [1, 2, 3]) admit(pool, constraints, handle);
    expect(pool.countInGroup('@event:Match')).toBe(3);

    admit(pool, constraints, 4);
    expect(pool.countInGroup('@event:Match')).toBe(3);
    expect(pool.has(1)).toBe(false); // oldest went
    expect(pool.handlesInGroup('@event:Match')).toEqual([2, 3, 4]);
  });

  it('preventNew refuses the new voice and leaves the existing one alone', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:Stinger', 1, 'preventNew')];

    expect(admit(pool, constraints, 1)).toBe(1);
    expect(admit(pool, constraints, 2)).toBeNull();
    expect(pool.has(1)).toBe(true);
    expect(pool.countInGroup('@event:Stinger')).toBe(1);
  });
});

describe('shared voice groups', () => {
  it('one budget spans several events, stealing across event boundaries', () => {
    const pool = new VoicePool();
    const grass = [group('@event:Step_Grass', GLOBAL), group('footsteps', 2)];
    const stone = [group('@event:Step_Stone', GLOBAL), group('footsteps', 2)];

    admit(pool, grass, 1);
    admit(pool, stone, 2);
    expect(pool.countInGroup('footsteps')).toBe(2);

    // A third footstep of either flavour evicts the oldest footstep, not a same-event one.
    admit(pool, stone, 3);
    expect(pool.countInGroup('footsteps')).toBe(2);
    expect(pool.has(1)).toBe(false);
    expect(pool.countInGroup('@event:Step_Grass')).toBe(0);
  });

  it('applies a private cap and a shared cap together', () => {
    const pool = new VoicePool();
    // Max 2 metal steps, max 4 footsteps overall.
    const metal = [group('@event:Step_Metal', 2), group('footsteps', 4)];

    admit(pool, metal, 1);
    admit(pool, metal, 2);
    admit(pool, metal, 3);

    expect(pool.countInGroup('@event:Step_Metal')).toBe(2); // private cap bit first
    expect(pool.countInGroup('footsteps')).toBe(2);
  });

  it('a preventNew group vetoes the play without evicting for the other group', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:UI_Click', 1), group('ui', 1, 'preventNew')];

    admit(pool, constraints, 1);
    const plan = pool.plan(constraints, GLOBAL);

    expect(plan.admitted).toBe(false);
    expect(plan.evict).toEqual([]); // nothing killed on the way to being refused
    expect(pool.has(1)).toBe(true);
  });
});

describe('fading voices', () => {
  it('stop free a group slot immediately so a retrigger can crossfade', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:Ambience', 1)];

    admit(pool, constraints, 1);
    pool.markStopping(1);

    expect(pool.countInGroup('@event:Ambience')).toBe(0);
    const plan = pool.plan(constraints, GLOBAL);
    expect(plan.admitted).toBe(true);
    expect(plan.evict).toEqual([]); // the outgoing tail is left to finish its fade
  });

  it('does not let preventNew be blocked by its own fading tail', () => {
    const pool = new VoicePool();
    const constraints = [group('@event:Stinger', 1, 'preventNew')];

    admit(pool, constraints, 1);
    expect(admit(pool, constraints, 2)).toBeNull();

    pool.markStopping(1);
    expect(admit(pool, constraints, 2)).toBe(2);
  });

  it('still counts a fading voice against the global cap', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:A', GLOBAL)], 1);
    pool.markStopping(1);
    expect(pool.size).toBe(1);
  });
});

describe('global cap', () => {
  it('fills the cap exactly before evicting anything', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:A', 4)], 1, { globalLimit: 3 });
    admit(pool, [group('@event:B', 4)], 2, { globalLimit: 3 });
    admit(pool, [group('@event:C', 4)], 3, { globalLimit: 3 });

    expect(pool.size).toBe(3);
    expect(pool.has(1)).toBe(true);
  });

  it('reclaims a fading voice before a sounding one', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:A', 4)], 1, { globalLimit: 2 });
    admit(pool, [group('@event:B', 4)], 2, { globalLimit: 2 });
    pool.markStopping(1);

    admit(pool, [group('@event:C', 4)], 3, { globalLimit: 2 });
    expect(pool.has(1)).toBe(false); // the fading one was taken
    expect(pool.has(2)).toBe(true);
  });

  it('prefers a one-shot over a loop so ambience survives a burst', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:Ambience', 4)], 1, { loop: true, globalLimit: 2 });
    admit(pool, [group('@event:Hit', 4)], 2, { globalLimit: 2 });

    admit(pool, [group('@event:Hit', 4)], 3, { globalLimit: 2 });
    expect(pool.has(1)).toBe(true); // loop kept
    expect(pool.has(2)).toBe(false); // one-shot taken
  });

  it('never exceeds the cap over a long burst', () => {
    const pool = new VoicePool();
    for (let i = 1; i <= 200; i++) {
      admit(pool, [group(`@event:E${i % 7}`, 4)], i, { globalLimit: 8 });
      expect(pool.size).toBeLessThanOrEqual(8);
    }
  });
});

describe('bookkeeping', () => {
  it('prunes empty groups so the map does not grow for the whole session', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:A', 2)], 1);
    expect(pool.activeGroupIds).toContain('@event:A');

    pool.remove(1);
    expect(pool.activeGroupIds).toEqual([]);
    expect(pool.size).toBe(0);
  });

  it('remove is idempotent', () => {
    const pool = new VoicePool();
    admit(pool, [group('@event:A', 2)], 1);
    pool.remove(1);
    pool.remove(1);
    expect(pool.size).toBe(0);
  });

  it('deduplicates repeated group ids', () => {
    const pool = new VoicePool();
    pool.add(1, ['dup', 'dup'], false);
    expect(pool.countInGroup('dup')).toBe(1);
    pool.remove(1);
    expect(pool.countInGroup('dup')).toBe(0);
  });

  it('treats a limit below 1 as 1 rather than deadlocking', () => {
    const pool = new VoicePool();
    expect(admit(pool, [group('@event:A', 0)], 1)).toBe(1);
    expect(admit(pool, [group('@event:A', 0)], 2)).toBe(2);
    expect(pool.countInGroup('@event:A')).toBe(1);
  });
});
