/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Leveled logging for a Meta Display Glasses game. Game code calls this instead of `console.*` (enforced by
 * `npm run validate`), which buys three things the bare console can't: a level filter so a shipped
 * build is quiet by default, a ring buffer the `?logview` on-glasses overlay and the remote sink
 * read from, and a single choke point where secrets are redacted and a runaway loop is rate-limited.
 *
 * Pure and DOM-free so it unit-tests in the plain `node` vitest env — the same split as
 * `PerfSampler` (logic) vs `PerfOverlay` (DOM). The clock and session id are injectable so tests
 * are deterministic. Sinks are where the side effects live: `consoleSink()` here, `LogOverlay` for
 * the on-device view, `RemoteLogSink` for the network.
 *
 * Default level is `warn`: real problems still reach the desktop console during development, and a
 * published build sends nothing chatty. Raise it per-session with `?log=debug` — see
 * `docs/logging.md`.
 *
 * Performance note: `update()` runs 60x/second, so a log call there is a log *storm*. Guard hot
 * paths with `isEnabled()` (which is a single integer compare) rather than building a message and
 * throwing it away, and let the rate limiter be the backstop, not the plan.
 */

/** Severity, most-severe first. `silent` is a level to *set*, never a level to emit at. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** The levels a record can actually carry (everything except the `silent` filter setting). */
export type EmittedLevel = Exclude<LogLevel, 'silent'>;

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** Quiet by default — errors and warnings only. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

/** Rate-limit window. */
const WINDOW_MS = 1000;

/** Replacement written over any registered secret. */
const REDACTED = '***';

/**
 * Secrets shorter than this are not redacted: a 1–2 character "secret" would match everywhere and
 * shred every message. Tokens are expected to be longer (see `docs/logging.md`).
 */
const MIN_SECRET_LENGTH = 3;

/** One log entry. Plain JSON — it is buffered, rendered, and POSTed as-is. */
export interface LogRecord {
  /** Per-session monotonic counter, so a consumer can detect dropped or reordered entries. */
  seq: number;
  /** Client wall-clock epoch ms. The server records its own receive time separately. */
  time: number;
  level: EmittedLevel;
  /** Subsystem tag from `child(scope)`; `''` for the root logger. */
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

/** A destination for records. `flush`/`dispose` are optional — only buffering sinks need them. */
export interface LogSink {
  write(record: LogRecord): void;
  flush?(): void;
  dispose?(): void;
}

/** The logging surface game code uses. `Logger` and `child()` scopes both satisfy it. */
export interface ScopedLogger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  trace(message: string, data?: Record<string, unknown>): void;
  isEnabled(level: EmittedLevel): boolean;
  child(scope: string): ScopedLogger;
}

export interface LoggerOptions {
  /** Starting level. Defaults to `warn`; `main.ts` overrides it from `?log`. */
  level?: LogLevel;
  /** Ring-buffer size. Defaults to 200 — enough for the overlay and a post-crash flush. */
  capacity?: number;
  /** Records per second before coalescing into a single "dropped" warning. Defaults to 120. */
  maxPerSecond?: number;
  /** Epoch-ms clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Session identifier. Defaults to a random string; injectable for tests. */
  sessionId?: string;
}

/**
 * Parse `?log=<level>`. Returns `null` when the flag is absent, so a caller can distinguish "not
 * requested" from "explicitly silenced" and fall back to {@link DEFAULT_LOG_LEVEL}.
 *
 * `?log` (bare) means "I want to see logs" → `debug`. `?log=0` / `=false` / `=off` / `=none` →
 * `silent`. A recognized level name is taken as-is. Anything else falls back to `debug` rather
 * than being ignored, because a typo'd level should still turn logging on, not silently do
 * nothing. DOM-free so it is unit-testable — matches `statsOverlayRequested` in `PerfSampler`.
 */
export function logLevelFromSearch(search: string): LogLevel | null {
  const value = new URLSearchParams(search).get('log');
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'none') {
    return 'silent';
  }
  if (normalized === '') {
    return 'debug';
  }
  return normalized in LEVEL_RANK ? (normalized as LogLevel) : 'debug';
}

/** Flatten an unknown thrown value into loggable fields (an `Error`'s name/message/stack). */
export function toErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorMessage: String(error) };
}

/** Random session id. Not security-sensitive — it only groups one page load's records. */
function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class Logger implements ScopedLogger {
  /** Groups this page load's records in the overlay and the portal. */
  public readonly sessionId: string;

  private readonly capacity: number;
  private readonly maxPerSecond: number;
  private readonly now: () => number;
  private readonly buffer: LogRecord[] = [];
  private readonly sinks: LogSink[] = [];
  private readonly secrets: string[] = [];
  private level: LogLevel;
  private seq = 0;
  private windowStart = 0;
  private windowCount = 0;
  private droppedInWindow = 0;

  public constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? DEFAULT_LOG_LEVEL;
    this.capacity = options.capacity ?? 200;
    this.maxPerSecond = options.maxPerSecond ?? 120;
    this.now = options.now ?? ((): number => Date.now());
    this.sessionId = options.sessionId ?? randomSessionId();
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Whether a record at `level` would be kept. Cheap enough to guard per-frame code with. */
  public isEnabled(level: EmittedLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  public addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  public removeSink(sink: LogSink): void {
    const index = this.sinks.indexOf(sink);
    if (index >= 0) {
      this.sinks.splice(index, 1);
    }
  }

  /**
   * Register a value that must never appear in a log — notably the `?logkey` token, which would
   * otherwise leak through `location.href` into the very logs it authorizes. Redaction covers
   * messages and top-level string fields of `data` (not nested objects, which are not
   * walked for cost reasons — don't put a secret in one).
   */
  public addSecret(secret: string): void {
    if (secret.length >= MIN_SECRET_LENGTH && !this.secrets.includes(secret)) {
      this.secrets.push(secret);
    }
  }

  /** Replace every registered secret in `text` with `***`. */
  public redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join(REDACTED);
    }
    return result;
  }

  /** The buffered records, oldest first — the overlay and the post-consent flush read this. */
  public getRecent(count?: number): LogRecord[] {
    if (count === undefined || count >= this.buffer.length) {
      return [...this.buffer];
    }
    return this.buffer.slice(Math.max(0, this.buffer.length - count));
  }

  /** Drop the buffered records — used when consent is declined, so nothing lingers. */
  public clear(): void {
    this.buffer.length = 0;
  }

  public error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', '', message, data);
  }

  public warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warn', '', message, data);
  }

  public info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', '', message, data);
  }

  public debug(message: string, data?: Record<string, unknown>): void {
    this.emit('debug', '', message, data);
  }

  public trace(message: string, data?: Record<string, unknown>): void {
    this.emit('trace', '', message, data);
  }

  /**
   * A logger that tags every record with `scope` (e.g. `log.child('audio')`). Scopes are a label
   * only — they share the root's level, buffer, and sinks, so there is one ordered stream.
   */
  public child(scope: string): ScopedLogger {
    const parent = this;
    const scoped: ScopedLogger = {
      error: (message, data): void => parent.emit('error', scope, message, data),
      warn: (message, data): void => parent.emit('warn', scope, message, data),
      info: (message, data): void => parent.emit('info', scope, message, data),
      debug: (message, data): void => parent.emit('debug', scope, message, data),
      trace: (message, data): void => parent.emit('trace', scope, message, data),
      isEnabled: (level): boolean => parent.isEnabled(level),
      child: (childScope): ScopedLogger => parent.child(`${scope}.${childScope}`),
    };
    return scoped;
  }

  /** Ask every buffering sink to send now (the remote sink batches otherwise). */
  public flush(): void {
    for (const sink of this.sinks) {
      sink.flush?.();
    }
  }

  public dispose(): void {
    for (const sink of this.sinks) {
      sink.dispose?.();
    }
    this.sinks.length = 0;
  }

  private emit(
    level: EmittedLevel,
    scope: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.isEnabled(level)) {
      return;
    }

    const time = this.now();
    if (time - this.windowStart >= WINDOW_MS) {
      this.windowStart = time;
      this.windowCount = 0;
      const dropped = this.droppedInWindow;
      this.droppedInWindow = 0;
      if (dropped > 0) {
        // Report the loss rather than hiding it — a silent gap in a log is worse than a noisy one.
        this.record('warn', 'log', `${dropped} log message(s) dropped (over ${this.maxPerSecond}/s)`, undefined, time);
      }
    }
    if (this.windowCount >= this.maxPerSecond) {
      this.droppedInWindow++;
      return;
    }
    this.windowCount++;

    this.record(level, scope, message, data, time);
  }

  private record(
    level: EmittedLevel,
    scope: string,
    message: string,
    data: Record<string, unknown> | undefined,
    time: number,
  ): void {
    const entry: LogRecord = {
      seq: this.seq++,
      time,
      level,
      scope,
      message: this.redact(message),
      ...(data === undefined ? {} : { data: this.redactData(data) }),
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }

    for (const sink of this.sinks) {
      sink.write(entry);
    }
  }

  private redactData(data: Record<string, unknown>): Record<string, unknown> {
    if (this.secrets.length === 0) {
      return data;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = typeof value === 'string' ? this.redact(value) : value;
    }
    return result;
  }
}

/** The subset of `console` a sink needs — narrow so a test can pass a recording fake. */
export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Mirror records to the browser console, so desktop development still gets clickable stack traces
 * and object inspection. `trace` maps to `console.debug` (the real `console.trace` prints a stack
 * on every call, which is noise at that volume).
 */
export function consoleSink(target?: ConsoleLike): LogSink {
  // eslint-disable-next-line no-console
  const output = target ?? console;
  return {
    write(record: LogRecord): void {
      const label = record.scope === '' ? record.message : `[${record.scope}] ${record.message}`;
      const args: unknown[] = record.data === undefined ? [label] : [label, record.data];
      switch (record.level) {
        case 'error':
          output.error(...args);
          break;
        case 'warn':
          output.warn(...args);
          break;
        case 'info':
          output.info(...args);
          break;
        default:
          output.debug(...args);
      }
    },
  };
}

/** Minimal event-target shape, so `captureGlobalErrors` can be pointed at a fake in tests. */
export interface GlobalErrorSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Route uncaught errors and unhandled promise rejections into the logger. These are the failures
 * that matter most on the glasses, where there is no console to see them in — and they are logged
 * at `error`, so they survive the default level and (with the remote sink armed) flush immediately.
 *
 * Returns a teardown function. No-ops when there is no DOM (the node test env).
 */
export function captureGlobalErrors(
  logger: ScopedLogger,
  target?: GlobalErrorSource,
): () => void {
  const source = target ?? (typeof window === 'undefined' ? undefined : window);
  if (!source) {
    return (): void => {};
  }

  const onError = (event: Event): void => {
    const error = event as Partial<ErrorEvent>;
    logger.error(error.message ?? 'Uncaught error', {
      source: error.filename,
      line: error.lineno,
      column: error.colno,
      ...toErrorData(error.error),
    });
  };

  const onRejection = (event: Event): void => {
    const rejection = event as Partial<PromiseRejectionEvent>;
    logger.error('Unhandled promise rejection', toErrorData(rejection.reason));
  };

  source.addEventListener('error', onError);
  source.addEventListener('unhandledrejection', onRejection);

  return (): void => {
    source.removeEventListener('error', onError);
    source.removeEventListener('unhandledrejection', onRejection);
  };
}
