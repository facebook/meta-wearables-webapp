/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Ships log records to the game's own `/api/logs` endpoint so a developer can read them from the
 * portal while the game runs on the glasses — the device has no console, and cannot be tethered
 * to attach one. See `docs/logging.md`.
 *
 * **Inert unless a backend exists.** This file always ships with the framework (so
 * `update-webapp-game-framework` keeps it current), but nothing here runs unless
 * `main.ts` constructs it, and `main.ts` only does that when `?logkey=` is present AND the player
 * has accepted the consent gate. The sink is attached to the `Logger` *after* acceptance, so it is
 * structurally incapable of transmitting beforehand.
 *
 * The batching, overflow, and backoff decisions are pure and unit-tested; `httpTransport` is the
 * thin, untested `fetch`/`sendBeacon` wrapper — the same logic-vs-glue split as
 * `PerfSampler`/`PerfOverlay`.
 *
 * Cost discipline, because this runs on a battery-powered device: records are batched on an
 * interval rather than sent per-call, `error` jumps the queue (it is the one level you can't
 * afford to lose to a crash), the queue drops oldest under pressure instead of growing without
 * bound, failures back off exponentially, and an auth/404 failure disables the sink outright
 * rather than retrying against a deployment that will never accept it.
 */

import type { LogRecord, LogSink } from '@/framework/debug/Logger';

/** Ingest path served by the `add-webapp-game-logging` skill's serverless function. */
export const LOG_ENDPOINT = '/api/logs';

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_RECORDS_PER_BATCH = 50;
const DEFAULT_MAX_QUEUED = 500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Read the `?logkey=<token>` remote-logging token. Returns `null` when absent or empty, which is
 * the signal that remote logging was not requested at all. DOM-free so it is unit-testable —
 * matches `statsOverlayRequested` in `PerfSampler` and `logLevelFromSearch` in `Logger`.
 *
 * The token doubles as the enable flag: without it nothing is sent, and the server rejects
 * anything that arrives without it. Register it with `logger.addSecret()` so it never leaks into
 * the logs it authorizes.
 */
export function logKeyFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('logkey');
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Path portion of a relative or absolute URL, for endpoint matching. */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

/**
 * Whether `url` is the log-ingest endpoint. Pass this as `sealAssetNetwork`'s `allow` option:
 * remote logging is a deliberate runtime network call, and without this the `NetworkGuard` would
 * warn on every batch (or throw, under `?strict`). Matches on path, so query strings and absolute
 * URLs both resolve.
 */
export function isLogEndpoint(url: string): boolean {
  return pathOf(url) === LOG_ENDPOINT;
}

/** Exponential backoff with a ceiling. `failures` is the count of consecutive failed sends. */
export function nextBackoffMs(
  failures: number,
  baseMs: number = BACKOFF_BASE_MS,
  maxMs: number = BACKOFF_MAX_MS,
): number {
  if (failures <= 0) {
    return 0;
  }
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

/** What the sink should do next, given an HTTP status. */
export type TransportResult = 'ok' | 'retry' | 'fatal';

/**
 * Classify a response. 2xx succeeds; 401/403 (bad token) and 404 (no backend deployed) are
 * permanent — retrying burns battery against a server that will never accept us — everything else
 * (429, 5xx, a network error) is worth retrying with backoff.
 */
export function classifyResponse(status: number): TransportResult {
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  if (status === 401 || status === 403 || status === 404) {
    return 'fatal';
  }
  return 'retry';
}

/** Environment description sent once per session, so the portal can label the stream. */
export interface SessionMeta {
  sessionId: string;
  startedAt: number;
  userAgent?: string;
  language?: string;
  screen?: string;
  url?: string;
}

/** One POST body. `meta` rides along on the first batch only. */
export interface LogBatchPayload {
  sessionId: string;
  meta?: SessionMeta;
  records: LogRecord[];
  /** Records the client discarded due to queue overflow, so the gap is visible in the portal. */
  dropped?: number;
}

export interface LogTransport {
  /** Send a batch. Resolve with the outcome; never reject. */
  send(payload: LogBatchPayload): Promise<TransportResult>;
  /**
   * Best-effort send during page teardown, when an async `fetch` would be killed mid-flight.
   * Implemented with `navigator.sendBeacon`.
   */
  sendFinal?(payload: LogBatchPayload): void;
}

/**
 * Bounded FIFO of pending records. Drops the OLDEST on overflow: during a failure the newest
 * records describe what is happening now, and the count of what was dropped is preserved so the
 * portal shows a gap rather than a seamless lie.
 */
export class LogBatchQueue {
  private readonly maxQueued: number;
  private readonly maxPerBatch: number;
  private readonly pending: LogRecord[] = [];
  private dropped = 0;

  public constructor(options: { maxQueued?: number; maxPerBatch?: number } = {}) {
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.maxPerBatch = options.maxPerBatch ?? DEFAULT_MAX_RECORDS_PER_BATCH;
  }

  public add(record: LogRecord): void {
    this.pending.push(record);
    while (this.pending.length > this.maxQueued) {
      this.pending.shift();
      this.dropped++;
    }
  }

  public size(): number {
    return this.pending.length;
  }

  public droppedCount(): number {
    return this.dropped;
  }

  /** Whether the queue has reached a full batch and should be sent without waiting for the timer. */
  public isBatchReady(): boolean {
    return this.pending.length >= this.maxPerBatch;
  }

  /** Remove and return up to one batch worth of records, oldest first. */
  public take(): LogRecord[] {
    return this.pending.splice(0, this.maxPerBatch);
  }

  /**
   * Put an unsent batch back at the FRONT, preserving order, and re-apply the cap. `dropped`
   * carries back the count that was already consumed into the failed payload, so a retry doesn't
   * quietly erase the record of a gap.
   */
  public requeue(records: LogRecord[], dropped = 0): void {
    this.pending.unshift(...records);
    this.dropped += dropped;
    while (this.pending.length > this.maxQueued) {
      this.pending.shift();
      this.dropped++;
    }
  }

  /** Read and reset the dropped counter — called when a batch is built, so it is reported once. */
  public consumeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }
}

/** Describe the current environment for the session header. Safe to call without a DOM. */
export function describeSession(sessionId: string, now: number, redact?: (t: string) => string): SessionMeta {
  const meta: SessionMeta = { sessionId, startedAt: now };
  if (typeof navigator !== 'undefined') {
    meta.userAgent = navigator.userAgent;
    meta.language = navigator.language;
  }
  if (typeof window !== 'undefined' && typeof screen !== 'undefined') {
    meta.screen = `${screen.width}x${screen.height}@${window.devicePixelRatio}`;
  }
  if (typeof location !== 'undefined') {
    // The token lives in this URL — redact before it becomes a log record.
    meta.url = redact ? redact(location.href) : location.href;
  }
  return meta;
}

/** `setTimeout`-shaped scheduler, injectable so tests drive time by hand. */
export interface Scheduler {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

const defaultScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

export interface RemoteLogSinkOptions {
  sessionId: string;
  transport: LogTransport;
  /** Batch interval. Defaults to 2000ms. */
  intervalMs?: number;
  maxQueued?: number;
  maxPerBatch?: number;
  /** Epoch-ms clock, injectable for tests. */
  now?: () => number;
  scheduler?: Scheduler;
  /** Applied to the session URL so the `?logkey` token never ships. */
  redact?: (text: string) => string;
  /** Called when the sink permanently disables itself (bad token / no backend). */
  onDisabled?: (reason: string) => void;
}

export class RemoteLogSink implements LogSink {
  private readonly queue: LogBatchQueue;
  private readonly options: RemoteLogSinkOptions;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private timer: number | null = null;
  private sending = false;
  private failures = 0;
  private metaSent = false;
  private disabled = false;

  public constructor(options: RemoteLogSinkOptions) {
    this.options = options;
    this.queue = new LogBatchQueue({
      maxQueued: options.maxQueued,
      maxPerBatch: options.maxPerBatch,
    });
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  public isDisabled(): boolean {
    return this.disabled;
  }

  public write(record: LogRecord): void {
    if (this.disabled) {
      return;
    }
    this.queue.add(record);
    // An error may be the last thing that happens before the page dies — don't sit on it.
    if (record.level === 'error' || this.queue.isBatchReady()) {
      void this.send();
      return;
    }
    this.scheduleSend(this.intervalMs);
  }

  /** Queue records already buffered by the Logger (the pre-consent backlog). */
  public backfill(records: readonly LogRecord[]): void {
    if (this.disabled) {
      return;
    }
    for (const record of records) {
      this.queue.add(record);
    }
    void this.send();
  }

  public flush(): void {
    void this.send();
  }

  /** Final synchronous handoff for page teardown — `fetch` would be cancelled here. */
  public flushFinal(): void {
    if (this.disabled || this.queue.size() === 0 || !this.options.transport.sendFinal) {
      return;
    }
    this.options.transport.sendFinal(this.buildPayload(this.queue.take()));
  }

  public dispose(): void {
    this.cancelTimer();
    this.flushFinal();
    this.disabled = true;
  }

  private scheduleSend(delayMs: number): void {
    if (this.timer !== null || this.disabled) {
      return;
    }
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      void this.send();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
  }

  private buildPayload(records: LogRecord[]): LogBatchPayload {
    const dropped = this.queue.consumeDropped();
    const payload: LogBatchPayload = { sessionId: this.options.sessionId, records };
    if (!this.metaSent) {
      this.metaSent = true;
      payload.meta = describeSession(this.options.sessionId, this.now(), this.options.redact);
    }
    if (dropped > 0) {
      payload.dropped = dropped;
    }
    return payload;
  }

  private async send(): Promise<void> {
    if (this.disabled || this.sending || this.queue.size() === 0) {
      return;
    }
    this.cancelTimer();
    this.sending = true;

    const batch = this.queue.take();
    const payload = this.buildPayload(batch);

    let result: TransportResult;
    try {
      result = await this.options.transport.send(payload);
    } catch {
      result = 'retry';
    }
    this.sending = false;

    if (result === 'ok') {
      this.failures = 0;
      if (this.queue.size() > 0) {
        this.scheduleSend(0);
      }
      return;
    }

    if (result === 'fatal') {
      // Never accepted, never will be: stop spending battery on it.
      this.disabled = true;
      this.cancelTimer();
      this.options.onDisabled?.('the log endpoint rejected the request (bad token, or no backend deployed)');
      return;
    }

    this.queue.requeue(batch, payload.dropped ?? 0);
    // The session header went out with a batch that failed; resend it with the retry.
    this.metaSent = false;
    this.failures++;
    this.scheduleSend(nextBackoffMs(this.failures));
  }
}

/**
 * Default transport: POST JSON to `/api/logs?k=<token>`, with a `sendBeacon` path for teardown.
 *
 * The token travels as a query parameter rather than a header because `sendBeacon` cannot set
 * headers, and the teardown flush is exactly the one that carries a crash. It is no more exposed
 * there than it already is in the page URL that enabled logging.
 */
export function httpTransport(token: string, endpoint: string = LOG_ENDPOINT): LogTransport {
  const url = `${endpoint}?k=${encodeURIComponent(token)}`;
  return {
    async send(payload: LogBatchPayload): Promise<TransportResult> {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
        return classifyResponse(response.status);
      } catch {
        return 'retry';
      }
    },
    sendFinal(payload: LogBatchPayload): void {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
        return;
      }
      navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    },
  };
}
