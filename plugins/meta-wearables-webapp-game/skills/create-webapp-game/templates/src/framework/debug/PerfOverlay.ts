/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * DOM overlay for the `?stats` performance HUD. Thin wrapper over the pure `PerfSampler`:
 * this file only creates and updates a DOM element, so all testable math stays in
 * `PerfSampler` (unit-tested in `node`), matching how `ThreeRenderer` keeps the untestable
 * GPU surface separate from the logic.
 *
 * Display-only: it creates an element and writes `style` / `textContent` and adds **no** event
 * listeners, so it stays within the "no input through the DOM" rule (a sanctioned DOM writer
 * like the game HUD). Styling is inline — `update-webapp-game-framework` re-syncs
 * only `src/framework/`, so the overlay must not depend on the game's `style.css`.
 */

import type { AudioPlayer } from '@/framework/audio/AudioPlayer';
import { PerfSampler } from '@/framework/debug/PerfSampler';
import type { PerfReport } from '@/framework/debug/PerfSampler';
import type { Renderer } from '@/framework/render/Renderer';

/** Throttle DOM text writes to ~5/sec so the numbers are readable; sampling stays per-frame. */
const REFRESH_MS = 200;

export interface PerfOverlayOptions {
  /** Where to append the overlay element. Defaults to `document.body`. */
  mount?: HTMLElement;
  /** Clock source, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
  /**
   * The audio subsystem, to show its decoded-PCM residency against its budget. Optional — omit it
   * and the audio line is left out. Worth wiring for a game with banks: decoded audio is the one
   * memory cost that moves at runtime and has no browser-visible counter, so the only way to see a
   * bank swap land while playtesting on the glasses is to read it here. See `docs/audio-banks.md`.
   */
  audio?: Pick<AudioPlayer, 'residentBytes' | 'maxResidentBytes' | 'activeVoiceCount'>;
}

/** Compact large counts (`12345` → `12.3k`) so the panel stays narrow. */
function formatCount(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** Bytes as whole megabytes-with-one-decimal, the unit the audio budget is expressed in. */
function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export class PerfOverlay {
  private readonly element: HTMLElement;
  private readonly sampler: PerfSampler;
  private readonly readStats: () => ReturnType<NonNullable<Renderer['getStats']>> | undefined;
  private readonly now: () => number;
  private readonly audio: PerfOverlayOptions['audio'];
  private lastRenderTime = 0;

  public constructor(
    renderer: Pick<Renderer, 'getStats'>,
    options: PerfOverlayOptions = {},
  ) {
    this.now = options.now ?? ((): number => performance.now());
    this.audio = options.audio;
    this.sampler = new PerfSampler({ now: this.now });
    this.readStats = (): ReturnType<NonNullable<Renderer['getStats']>> | undefined =>
      renderer.getStats?.();

    const element = document.createElement('div');
    Object.assign(element.style, {
      position: 'absolute',
      top: '4px',
      left: '4px',
      margin: '0',
      padding: '4px 6px',
      // Faint dark-gray backing (never pure black, which is invisible on the additive
      // display) so the bright text stays legible over the game.
      background: 'rgba(20, 20, 20, 0.72)',
      borderRadius: '4px',
      color: '#7cfc00',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: '9999',
    } satisfies Partial<CSSStyleDeclaration>);
    (options.mount ?? document.body).appendChild(element);
    this.element = element;
  }

  /** Mark the start of a frame — call before `update()`. */
  public beginFrame(): void {
    this.sampler.beginFrame();
  }

  /** Mark the end of a frame — call after `render()`, so GPU counters describe this frame. */
  public endFrame(): void {
    this.sampler.endFrame(this.readStats());
    const now = this.now();
    if (now - this.lastRenderTime >= REFRESH_MS) {
      this.lastRenderTime = now;
      this.element.textContent = this.format(this.sampler.getReport());
    }
  }

  /** Remove the overlay from the DOM. */
  public dispose(): void {
    this.element.remove();
  }

  private format(r: PerfReport): string {
    const lines = [
      `FPS  ${Math.round(r.fps)} / ${Math.round(r.fpsAvg)}   ${r.frameMs.toFixed(1)}ms`,
      `CPU  ${r.cpuMs.toFixed(1)} / ${r.cpuMsAvg.toFixed(1)} ms`,
    ];
    if (r.hasRenderStats) {
      lines.push(
        `Draw ${formatCount(r.drawCalls)} / ${formatCount(r.drawCallsAvg)}`,
        `Tris ${formatCount(r.triangles)} / ${formatCount(r.trianglesAvg)}`,
        `P/L  ${formatCount(r.points)}/${formatCount(r.lines)}` +
          ` / ${formatCount(r.pointsAvg)}/${formatCount(r.linesAvg)}`,
        `Mem  geo ${r.geometries}  tex ${r.textures}`,
      );
    } else {
      lines.push('(GPU stats unavailable)');
    }
    if (this.audio) {
      lines.push(
        `Snd  ${formatMb(this.audio.residentBytes)}/${formatMb(this.audio.maxResidentBytes)} MB` +
          `  ${this.audio.activeVoiceCount}v`,
      );
    }
    return lines.join('\n');
  }
}
