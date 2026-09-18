/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * On-glasses log view behind `?logview`: the last N log lines drawn straight onto the 600x600
 * display. It needs no backend, no network, and no deploy, so it works offline, and on the first
 * run of a game that has never been published — which covers a large share of "why did it do that
 * on device?" without the remote sink at all.
 *
 * A `LogSink`, so it is attached with `logger.addSink(overlay)`. Display-only, like `PerfOverlay`
 * and `LoadingScreen`: it creates elements and writes `style` / `textContent`, adds **no** event
 * listeners (the "no input through the DOM" rule), and styles inline —
 * `update-webapp-game-framework` re-syncs only `src/framework/`, so it must not depend
 * on the game's `style.css`.
 *
 * Text goes in via `textContent`, never `innerHTML`: a log line can contain anything the game
 * formatted into it, and markup in a log message must render as characters, not as DOM.
 */

import type { EmittedLevel, LogRecord, LogSink } from '@/framework/debug/Logger';

/** Throttle DOM writes so a burst of records can't turn into a burst of layouts. */
const REFRESH_MS = 150;

/** Per-level text color, so an error is findable at a glance on a busy 600x600 display. */
const LEVEL_COLORS: Record<EmittedLevel, string> = {
  error: '#ff6b6b',
  warn: '#ffd166',
  info: '#ffffff',
  debug: '#8ecae6',
  trace: '#9aa0a6',
};

const LEVEL_LETTERS: Record<EmittedLevel, string> = {
  error: 'E',
  warn: 'W',
  info: 'I',
  debug: 'D',
  trace: 'T',
};

export interface LogOverlayOptions {
  /** Where to append the overlay. Defaults to `document.body`; the scaffold passes `#game-root`. */
  mount?: HTMLElement;
  /** How many lines to keep on screen. Defaults to 10 — more than that is unreadable at 600x600. */
  maxLines?: number;
  /** Clock source, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Whether the `?logview` on-screen log overlay was requested. Pass `window.location.search`.
 * Present with any value except `0` / `false` enables it — the same convention as `?stats`,
 * `?slowload`, `?strict`, and `?mute`. DOM-free so it is unit-testable.
 */
export function logOverlayRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('logview');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

/** `HH:MM:SS` from an epoch timestamp — the date is never useful in a single play session. */
function formatClock(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class LogOverlay implements LogSink {
  private readonly root: HTMLElement;
  private readonly maxLines: number;
  private readonly now: () => number;
  private readonly lines: Array<{ text: string; level: EmittedLevel }> = [];
  private lastRenderTime = 0;
  private dirty = false;
  private disposed = false;
  private trailingRender: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: LogOverlayOptions = {}) {
    this.maxLines = options.maxLines ?? 10;
    this.now = options.now ?? ((): number => performance.now());

    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'absolute',
      left: '4px',
      bottom: '4px',
      right: '4px',
      margin: '0',
      padding: '4px 6px',
      // Faint dark backing, never pure black (invisible on the additive display), so the text
      // stays legible over whatever the game is drawing.
      background: 'rgba(20, 20, 20, 0.72)',
      borderRadius: '4px',
      font: '10px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      pointerEvents: 'none',
      userSelect: 'none',
      // Below the LoadingScreen (10000) but above the HUD; alongside the ?stats overlay.
      zIndex: '9999',
    } satisfies Partial<CSSStyleDeclaration>);

    (options.mount ?? document.body).appendChild(root);
    this.root = root;
  }

  public write(record: LogRecord): void {
    // A sink can outlive its removal — the logger may still hold a reference. Dropping the record
    // here is what keeps `dispose()` final: no line buffered, no trailing timer rescheduled.
    if (this.disposed) {
      return;
    }
    const scope = record.scope === '' ? '' : ` [${record.scope}]`;
    const data = record.data === undefined ? '' : ` ${safeStringify(record.data)}`;
    this.lines.push({
      level: record.level,
      text: `${formatClock(record.time)} ${LEVEL_LETTERS[record.level]}${scope} ${record.message}${data}`,
    });
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.markDirty();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.trailingRender !== null) {
      clearTimeout(this.trailingRender);
      this.trailingRender = null;
    }
    this.root.remove();
  }

  /**
   * Render at most once per {@link REFRESH_MS}, with a trailing render so the final line of a
   * burst is never left off-screen (the case that matters: the last log before a freeze).
   */
  private markDirty(): void {
    this.dirty = true;
    const now = this.now();
    if (now - this.lastRenderTime >= REFRESH_MS) {
      this.render();
      return;
    }
    if (this.trailingRender === null) {
      this.trailingRender = setTimeout(() => {
        this.trailingRender = null;
        if (this.dirty) {
          this.render();
        }
      }, REFRESH_MS);
    }
  }

  private render(): void {
    this.lastRenderTime = this.now();
    this.dirty = false;
    this.root.replaceChildren(
      ...this.lines.map((line) => {
        const element = document.createElement('div');
        element.style.color = LEVEL_COLORS[line.level];
        // textContent, never innerHTML: a log message may contain anything, including markup.
        element.textContent = line.text;
        return element;
      }),
    );
  }
}

/** JSON for the overlay, degrading to a marker rather than throwing on a cyclic structure. */
function safeStringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data) ?? '';
  } catch {
    return '[unserializable]';
  }
}
