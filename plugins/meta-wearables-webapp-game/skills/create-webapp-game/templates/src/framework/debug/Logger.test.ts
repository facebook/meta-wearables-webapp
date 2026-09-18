/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it } from 'vitest';

import type { LogRecord, LogSink } from '@/framework/debug/Logger';
import {
  Logger,
  captureGlobalErrors,
  consoleSink,
  logLevelFromSearch,
  toErrorData,
} from '@/framework/debug/Logger';

/** A sink that just records what it was handed, so assertions read off a plain array. */
function recordingSink(): { sink: LogSink; written: LogRecord[] } {
  const written: LogRecord[] = [];
  return { sink: { write: (record): number => written.push(record) }, written };
}

/** A logger on a manually advanced clock — no wall-clock flake in the rate-limit tests. */
function withClock(options: { level?: 'trace' | 'warn'; maxPerSecond?: number } = {}): {
  logger: Logger;
  written: LogRecord[];
  advance: (ms: number) => void;
} {
  let time = 1_000_000;
  const { sink, written } = recordingSink();
  const logger = new Logger({
    level: options.level ?? 'trace',
    maxPerSecond: options.maxPerSecond,
    now: () => time,
    sessionId: 'test',
  });
  logger.addSink(sink);
  return { logger, written, advance: (ms: number): void => void (time += ms) };
}

describe('logLevelFromSearch', () => {
  it('returns null when the flag is absent, so the caller can apply its own default', () => {
    expect(logLevelFromSearch('')).toBeNull();
    expect(logLevelFromSearch('?stats&mute')).toBeNull();
  });

  it('reads a recognized level name', () => {
    expect(logLevelFromSearch('?log=error')).toBe('error');
    expect(logLevelFromSearch('?log=warn')).toBe('warn');
    expect(logLevelFromSearch('?log=info')).toBe('info');
    expect(logLevelFromSearch('?log=debug')).toBe('debug');
    expect(logLevelFromSearch('?log=TRACE')).toBe('trace');
    expect(logLevelFromSearch('?log=silent')).toBe('silent');
  });

  it('treats the bare flag as debug ("show me logs")', () => {
    expect(logLevelFromSearch('?log')).toBe('debug');
    expect(logLevelFromSearch('?log=')).toBe('debug');
  });

  it('silences on the off-style values, matching the other boolean flags', () => {
    expect(logLevelFromSearch('?log=0')).toBe('silent');
    expect(logLevelFromSearch('?log=false')).toBe('silent');
    expect(logLevelFromSearch('?log=off')).toBe('silent');
    expect(logLevelFromSearch('?log=none')).toBe('silent');
  });

  it('falls back to debug on an unrecognized value rather than silently ignoring it', () => {
    expect(logLevelFromSearch('?log=verbose')).toBe('debug');
  });
});

describe('Logger level filtering', () => {
  it('defaults to warn — errors and warnings only', () => {
    const logger = new Logger({ sessionId: 'test' });
    const { sink, written } = recordingSink();
    logger.addSink(sink);

    logger.error('boom');
    logger.warn('careful');
    logger.info('fyi');
    logger.debug('detail');
    logger.trace('noise');

    expect(written.map((r) => r.level)).toEqual(['error', 'warn']);
  });

  it('isEnabled matches what actually gets emitted', () => {
    const logger = new Logger({ level: 'info', sessionId: 'test' });
    expect(logger.isEnabled('error')).toBe(true);
    expect(logger.isEnabled('info')).toBe(true);
    expect(logger.isEnabled('debug')).toBe(false);
  });

  it('setLevel("silent") suppresses everything, including errors', () => {
    const { logger, written } = withClock();
    logger.setLevel('silent');
    logger.error('boom');
    expect(written).toEqual([]);
  });
});

describe('Logger records', () => {
  it('numbers records with a monotonic per-session sequence', () => {
    const { logger, written } = withClock();
    logger.info('one');
    logger.info('two');
    logger.info('three');
    expect(written.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it('stamps the injected clock and omits data when none is passed', () => {
    const { logger, written, advance } = withClock();
    logger.info('one');
    advance(50);
    logger.info('two', { hp: 3 });

    expect(written[0]).toEqual({ seq: 0, time: 1_000_000, level: 'info', scope: '', message: 'one' });
    expect(written[1].time).toBe(1_000_050);
    expect(written[1].data).toEqual({ hp: 3 });
  });

  it('tags child-scope records and nests grandchildren', () => {
    const { logger, written } = withClock();
    logger.child('audio').info('unlocked');
    logger.child('audio').child('bus').debug('gain set');
    expect(written.map((r) => r.scope)).toEqual(['audio', 'audio.bus']);
  });

  it('shares one ordered stream across scopes', () => {
    const { logger, written } = withClock();
    const audio = logger.child('audio');
    logger.info('root');
    audio.info('scoped');
    expect(written.map((r) => r.seq)).toEqual([0, 1]);
  });
});

describe('Logger ring buffer', () => {
  it('keeps only the most recent records once capacity is reached', () => {
    const logger = new Logger({ level: 'trace', capacity: 3, sessionId: 'test' });
    for (let i = 0; i < 6; i++) {
      logger.info(`m${i}`);
    }
    expect(logger.getRecent().map((r) => r.message)).toEqual(['m3', 'm4', 'm5']);
  });

  it('getRecent(n) returns the last n, and the whole buffer when n exceeds it', () => {
    const logger = new Logger({ level: 'trace', sessionId: 'test' });
    logger.info('a');
    logger.info('b');
    logger.info('c');
    expect(logger.getRecent(2).map((r) => r.message)).toEqual(['b', 'c']);
    expect(logger.getRecent(99)).toHaveLength(3);
  });

  it('clear() empties the buffer — the declined-consent path', () => {
    const logger = new Logger({ level: 'trace', sessionId: 'test' });
    logger.info('secret-ish startup detail');
    logger.clear();
    expect(logger.getRecent()).toEqual([]);
  });
});

describe('Logger rate limiting', () => {
  it('caps records per second and coalesces the overflow into one warning', () => {
    const { logger, written, advance } = withClock({ maxPerSecond: 3 });

    for (let i = 0; i < 10; i++) {
      logger.info(`m${i}`);
    }
    expect(written).toHaveLength(3);

    // Next window: the 7 suppressed records are reported as a single warning.
    advance(1000);
    logger.info('after');

    expect(written).toHaveLength(5);
    expect(written[3].level).toBe('warn');
    expect(written[3].message).toBe('7 log message(s) dropped (over 3/s)');
    expect(written[4].message).toBe('after');
  });

  it('does not report a drop warning when nothing was dropped', () => {
    const { logger, written, advance } = withClock({ maxPerSecond: 10 });
    logger.info('one');
    advance(1000);
    logger.info('two');
    expect(written.map((r) => r.message)).toEqual(['one', 'two']);
  });
});

describe('Logger redaction', () => {
  it('strips a registered secret from messages and top-level string data', () => {
    const { logger, written } = withClock();
    logger.addSecret('s3cret-token');

    logger.info('opened https://game.example/?log=debug&logkey=s3cret-token', {
      url: 'https://game.example/?logkey=s3cret-token',
      attempts: 2,
    });

    expect(written[0].message).toBe('opened https://game.example/?log=debug&logkey=***');
    expect(written[0].data).toEqual({ url: 'https://game.example/?logkey=***', attempts: 2 });
  });

  it('ignores a too-short secret, which would otherwise shred every message', () => {
    const { logger, written } = withClock();
    logger.addSecret('a');
    logger.info('a quick brown fox');
    expect(written[0].message).toBe('a quick brown fox');
  });

  it('redact() is idempotent for repeated registration', () => {
    const logger = new Logger({ sessionId: 'test' });
    logger.addSecret('abcdef');
    logger.addSecret('abcdef');
    expect(logger.redact('x abcdef y')).toBe('x *** y');
  });
});

describe('Logger sinks', () => {
  it('fans out to every sink and stops after removeSink', () => {
    const { logger } = withClock();
    const first = recordingSink();
    const second = recordingSink();
    logger.addSink(first.sink);
    logger.addSink(second.sink);

    logger.info('both');
    logger.removeSink(first.sink);
    logger.info('second only');

    expect(first.written.map((r) => r.message)).toEqual(['both']);
    expect(second.written.map((r) => r.message)).toEqual(['both', 'second only']);
  });

  it('flush() and dispose() reach the optional sink hooks', () => {
    const logger = new Logger({ sessionId: 'test' });
    const calls: string[] = [];
    logger.addSink({
      write: (): void => {},
      flush: (): number => calls.push('flush'),
      dispose: (): number => calls.push('dispose'),
    });

    logger.flush();
    logger.dispose();
    expect(calls).toEqual(['flush', 'dispose']);
  });
});

describe('consoleSink', () => {
  it('routes each level to the matching console method and prefixes the scope', () => {
    const calls: Array<[string, unknown[]]> = [];
    const fake = {
      error: (...args: unknown[]): number => calls.push(['error', args]),
      warn: (...args: unknown[]): number => calls.push(['warn', args]),
      info: (...args: unknown[]): number => calls.push(['info', args]),
      debug: (...args: unknown[]): number => calls.push(['debug', args]),
    };
    const logger = new Logger({ level: 'trace', sessionId: 'test' });
    logger.addSink(consoleSink(fake));

    logger.error('bad');
    logger.warn('hmm');
    logger.info('ok');
    logger.debug('detail', { n: 1 });
    logger.child('audio').trace('noise');

    expect(calls.map(([method]) => method)).toEqual(['error', 'warn', 'info', 'debug', 'debug']);
    expect(calls[3][1]).toEqual(['detail', { n: 1 }]);
    expect(calls[4][1]).toEqual(['[audio] noise']);
  });
});

describe('toErrorData', () => {
  it('unpacks an Error and stringifies anything else', () => {
    const data = toErrorData(new TypeError('nope'));
    expect(data.errorName).toBe('TypeError');
    expect(data.errorMessage).toBe('nope');
    expect(typeof data.stack).toBe('string');

    expect(toErrorData('plain string')).toEqual({ errorMessage: 'plain string' });
  });
});

describe('captureGlobalErrors', () => {
  it('logs uncaught errors and rejections at error level, and detaches on teardown', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const source = {
      addEventListener: (type: string, listener: (event: Event) => void): void => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string): void => void listeners.delete(type),
    };

    const { logger, written } = withClock();
    const detach = captureGlobalErrors(logger, source);

    listeners.get('error')?.({
      message: 'kaboom',
      filename: 'main.ts',
      lineno: 12,
      colno: 3,
      error: new Error('kaboom'),
    } as unknown as Event);
    listeners.get('unhandledrejection')?.({ reason: new Error('rejected') } as unknown as Event);

    expect(written.map((r) => [r.level, r.message])).toEqual([
      ['error', 'kaboom'],
      ['error', 'Unhandled promise rejection'],
    ]);
    expect(written[0].data).toMatchObject({ source: 'main.ts', line: 12, column: 3 });

    detach();
    expect(listeners.size).toBe(0);
  });

  it('no-ops without a DOM (the node test env) instead of throwing', () => {
    const logger = new Logger({ sessionId: 'test' });
    expect(() => captureGlobalErrors(logger)()).not.toThrow();
  });
});
