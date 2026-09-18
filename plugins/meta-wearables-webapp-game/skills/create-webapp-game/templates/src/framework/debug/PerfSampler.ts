/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Pure, DOM-free performance sampler behind the `?stats` overlay. All timing and averaging
 * math lives here so it can be unit-tested in the plain `node` vitest env (the DOM wrapper
 * `PerfOverlay` adds only rendering). The clock is injectable for deterministic tests.
 *
 * Frame timing is measured begin-to-begin: `beginFrame()` at the top of the frame,
 * `endFrame(stats)` after `render()`. The interval between successive `beginFrame()` calls is
 * the real (unclamped) frame time — the FPS source — while `endFrame() - beginFrame()` is the
 * CPU cost of `update()` + `render()`. GPU counters come from the renderer's `RenderStats`.
 * The very first frame has no preceding `beginFrame()`, so it has no interval to measure; it
 * is skipped rather than recorded as a bogus 0ms frame (which would report 0 FPS).
 */

import type { RenderStats } from '@/framework/render/Renderer';

/** Rolling averages are computed over this trailing window (ms). */
const WINDOW_MS = 1000;

/** One frame's measurements, timestamped at `endFrame()` for window eviction. */
interface Sample {
  t: number;
  frameMs: number;
  cpuMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
}

/** A snapshot the overlay renders: latest ("current") value plus its 1-second average. */
export interface PerfReport {
  /** Instantaneous FPS from the last frame interval (`1000 / frameMs`). */
  fps: number;
  /** Frame rate averaged over the trailing 1-second window (count of frames over their span). */
  fpsAvg: number;
  /** Last frame interval in milliseconds. */
  frameMs: number;
  /** CPU ms spent in `update()` + `render()` last frame. */
  cpuMs: number;
  cpuMsAvg: number;
  drawCalls: number;
  drawCallsAvg: number;
  triangles: number;
  trianglesAvg: number;
  points: number;
  pointsAvg: number;
  lines: number;
  linesAvg: number;
  /** Live geometry / texture gauges (latest values, not averaged). */
  geometries: number;
  textures: number;
  /** Whether the renderer supplied `RenderStats` (false → GPU rows are unavailable). */
  hasRenderStats: boolean;
}

export interface PerfSamplerOptions {
  /** Clock source, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Whether the `?stats` debug overlay was requested via the URL query string. Pass
 * `window.location.search`. Present with any value except `0` / `false` enables it
 * (`?stats`, `?stats=1` → true; `?stats=0`, `?stats=false`, absent → false). DOM-free so it
 * is unit-testable.
 */
export function statsOverlayRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('stats');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

export class PerfSampler {
  private readonly now: () => number;
  private readonly samples: Sample[] = [];
  private lastBeginTime: number | null = null;
  private frameStart: number | null = null;
  private frameMs = 0;
  private hasInterval = false;
  private geometries = 0;
  private textures = 0;
  private hasRenderStats = false;

  public constructor(options: PerfSamplerOptions = {}) {
    this.now = options.now ?? ((): number => performance.now());
  }

  /** Mark the start of a frame. The gap since the previous start is the frame interval. */
  public beginFrame(): void {
    const now = this.now();
    const previousBegin = this.lastBeginTime;
    this.hasInterval = previousBegin !== null;
    this.frameMs = previousBegin === null ? 0 : now - previousBegin;
    this.lastBeginTime = now;
    this.frameStart = now;
  }

  /**
   * Mark the end of a frame (call after `render()`). Records CPU cost and the renderer's
   * GPU stats, then evicts samples older than the averaging window.
   */
  public endFrame(stats?: RenderStats): void {
    const now = this.now();
    const cpuMs = this.frameStart === null ? 0 : now - this.frameStart;

    if (stats) {
      this.geometries = stats.geometries;
      this.textures = stats.textures;
      this.hasRenderStats = true;
    }

    // The first frame has no preceding interval, so its frameMs is a meaningless 0. Skip
    // recording it (gauges above are still updated) so it never reports 0 FPS or skews the
    // window's averages.
    if (!this.hasInterval) {
      return;
    }

    this.samples.push({
      t: now,
      frameMs: this.frameMs,
      cpuMs,
      drawCalls: stats?.drawCalls ?? 0,
      triangles: stats?.triangles ?? 0,
      points: stats?.points ?? 0,
      lines: stats?.lines ?? 0,
    });

    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  /** Current + 1-second-averaged metrics for the overlay. */
  public getReport(): PerfReport {
    const count = this.samples.length;
    const last = count > 0 ? this.samples[count - 1] : null;
    const frameMs = last?.frameMs ?? 0;
    const fps = frameMs > 0 ? 1000 / frameMs : 0;

    // Count-based average over the window's real span: robust during warm-up regardless of
    // any single frame's interval.
    let fpsAvg = fps;
    if (count >= 2) {
      const span = this.samples[count - 1].t - this.samples[0].t;
      fpsAvg = span > 0 ? ((count - 1) / span) * 1000 : fps;
    }

    const mean = (select: (s: Sample) => number): number =>
      count > 0 ? this.samples.reduce((sum, s) => sum + select(s), 0) / count : 0;

    return {
      fps,
      fpsAvg,
      frameMs,
      cpuMs: last?.cpuMs ?? 0,
      cpuMsAvg: mean((s) => s.cpuMs),
      drawCalls: last?.drawCalls ?? 0,
      drawCallsAvg: mean((s) => s.drawCalls),
      triangles: last?.triangles ?? 0,
      trianglesAvg: mean((s) => s.triangles),
      points: last?.points ?? 0,
      pointsAvg: mean((s) => s.points),
      lines: last?.lines ?? 0,
      linesAvg: mean((s) => s.lines),
      geometries: this.geometries,
      textures: this.textures,
      hasRenderStats: this.hasRenderStats,
    };
  }
}
