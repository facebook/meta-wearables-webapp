/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it } from 'vitest';

import { PerfSampler, statsOverlayRequested } from '@/framework/debug/PerfSampler';
import type { RenderStats } from '@/framework/render/Renderer';

/** A controllable clock: set `clock.t` before each sampler call. */
function makeClock(): { t: number; now: () => number } {
  const clock = { t: 0, now: (): number => clock.t };
  return clock;
}

function stats(overrides: Partial<RenderStats> = {}): RenderStats {
  return {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    geometries: 0,
    textures: 0,
    ...overrides,
  };
}

describe('statsOverlayRequested', () => {
  it('enables for a bare or truthy flag', () => {
    expect(statsOverlayRequested('?stats')).toBe(true);
    expect(statsOverlayRequested('?stats=1')).toBe(true);
    expect(statsOverlayRequested('?stats=true')).toBe(true);
    expect(statsOverlayRequested('?foo=bar&stats')).toBe(true);
  });

  it('disables when absent or explicitly falsey', () => {
    expect(statsOverlayRequested('')).toBe(false);
    expect(statsOverlayRequested('?other=1')).toBe(false);
    expect(statsOverlayRequested('?stats=0')).toBe(false);
    expect(statsOverlayRequested('?stats=false')).toBe(false);
    expect(statsOverlayRequested('?stats=FALSE')).toBe(false);
  });
});

describe('PerfSampler', () => {
  /** Run one begin(at `beginAt`)/end(after `cpu` ms) frame. */
  function frame(
    sampler: PerfSampler,
    clock: { t: number },
    beginAt: number,
    cpu: number,
    frameStats?: RenderStats,
  ): void {
    clock.t = beginAt;
    sampler.beginFrame();
    clock.t = beginAt + cpu;
    sampler.endFrame(frameStats);
  }

  it('reports FPS from the frame interval and averages over the window', () => {
    const clock = makeClock();
    const sampler = new PerfSampler({ now: clock.now });

    // Five steady 10ms frames, each doing 2ms of CPU work, with constant GPU stats.
    for (let i = 0; i < 5; i++) {
      frame(sampler, clock, i * 10, 2, stats({ drawCalls: 5, triangles: 100 }));
    }

    const report = sampler.getReport();
    expect(report.frameMs).toBe(10);
    expect(report.fps).toBeCloseTo(100);
    expect(report.fpsAvg).toBeCloseTo(100);
    expect(report.cpuMs).toBe(2);
    expect(report.cpuMsAvg).toBeCloseTo(2);
    expect(report.drawCalls).toBe(5);
    expect(report.drawCallsAvg).toBeCloseTo(5);
    expect(report.triangles).toBe(100);
    expect(report.trianglesAvg).toBeCloseTo(100);
    expect(report.hasRenderStats).toBe(true);
  });

  it('skips the first frame (no interval) instead of reporting a bogus 0 FPS', () => {
    const clock = makeClock();
    const sampler = new PerfSampler({ now: clock.now });

    // One frame has no preceding beginFrame(), so there is no interval to measure yet.
    frame(sampler, clock, 0, 2, stats({ drawCalls: 5 }));
    expect(sampler.getReport().fps).toBe(0);

    // The second frame supplies the first real interval; FPS reflects it, not a 0.
    frame(sampler, clock, 10, 2, stats({ drawCalls: 5 }));
    const report = sampler.getReport();
    expect(report.fps).toBeCloseTo(100);
    expect(report.frameMs).toBe(10);
  });

  it('carries the latest geometry/texture gauges', () => {
    const clock = makeClock();
    const sampler = new PerfSampler({ now: clock.now });

    frame(sampler, clock, 0, 1, stats({ geometries: 8, textures: 3 }));
    frame(sampler, clock, 10, 1, stats({ geometries: 9, textures: 4 }));

    const report = sampler.getReport();
    expect(report.geometries).toBe(9);
    expect(report.textures).toBe(4);
  });

  it('evicts samples older than the 1-second window', () => {
    const clock = makeClock();
    const sampler = new PerfSampler({ now: clock.now });

    // Two old high-draw frames, then two recent low-draw frames > 1s later.
    frame(sampler, clock, 0, 0, stats({ drawCalls: 100 }));
    frame(sampler, clock, 500, 0, stats({ drawCalls: 100 }));
    frame(sampler, clock, 1100, 0, stats({ drawCalls: 10 }));
    frame(sampler, clock, 1600, 0, stats({ drawCalls: 20 }));

    // At t=1600 the cutoff is 600, so only the t=1100 and t=1600 samples survive.
    const report = sampler.getReport();
    expect(report.drawCalls).toBe(20);
    expect(report.drawCallsAvg).toBeCloseTo(15);
  });

  it('degrades gracefully when the renderer supplies no stats', () => {
    const clock = makeClock();
    const sampler = new PerfSampler({ now: clock.now });

    frame(sampler, clock, 0, 1);
    frame(sampler, clock, 10, 1);

    const report = sampler.getReport();
    expect(report.hasRenderStats).toBe(false);
    expect(report.drawCalls).toBe(0);
    expect(report.fps).toBeCloseTo(100);
  });
});
