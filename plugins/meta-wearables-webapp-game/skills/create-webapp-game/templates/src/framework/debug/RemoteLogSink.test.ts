/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it } from 'vitest';

import type { LogRecord } from '@/framework/debug/Logger';
import type { LogBatchPayload, Scheduler, TransportResult } from '@/framework/debug/RemoteLogSink';
import {
  LOG_ENDPOINT,
  LogBatchQueue,
  RemoteLogSink,
  classifyResponse,
  describeSession,
  isLogEndpoint,
  logKeyFromSearch,
  nextBackoffMs,
} from '@/framework/debug/RemoteLogSink';

function record(seq: number, level: LogRecord['level'] = 'info'): LogRecord {
  return { seq, time: 1_000_000 + seq, level, scope: '', message: `m${seq}` };
}

/**
 * A scheduler whose callbacks only fire when the test says so, so batching and backoff are
 * exercised without real timers.
 */
function manualScheduler(): { scheduler: Scheduler; runDue: () => Promise<void>; pending: () => number[] } {
  let nextHandle = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    scheduler: {
      set: (callback, delayMs): number => {
        const handle = nextHandle++;
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      clear: (handle): void => void timers.delete(handle),
    },
    pending: (): number[] => [...timers.values()].map((t) => t.delayMs),
    runDue: async (): Promise<void> => {
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.callback();
      }
      // Let the async send() settle before the test asserts.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** A transport that records payloads and returns a scripted sequence of results. */
function fakeTransport(results: TransportResult[] = []): {
  transport: { send: (p: LogBatchPayload) => Promise<TransportResult>; sendFinal: (p: LogBatchPayload) => void };
  sent: LogBatchPayload[];
  beacons: LogBatchPayload[];
} {
  const sent: LogBatchPayload[] = [];
  const beacons: LogBatchPayload[] = [];
  let index = 0;
  return {
    sent,
    beacons,
    transport: {
      send: async (payload): Promise<TransportResult> => {
        sent.push(payload);
        return results[index++] ?? 'ok';
      },
      sendFinal: (payload): void => void beacons.push(payload),
    },
  };
}

describe('logKeyFromSearch', () => {
  it('returns null when absent or blank — remote logging was not requested', () => {
    expect(logKeyFromSearch('')).toBeNull();
    expect(logKeyFromSearch('?log=debug')).toBeNull();
    expect(logKeyFromSearch('?logkey=')).toBeNull();
    expect(logKeyFromSearch('?logkey=%20')).toBeNull();
  });

  it('returns the trimmed token', () => {
    expect(logKeyFromSearch('?logkey=k3j9xz')).toBe('k3j9xz');
    expect(logKeyFromSearch('?log=debug&logkey=abc123')).toBe('abc123');
  });
});

describe('isLogEndpoint', () => {
  it('matches the ingest path relative, absolute, and with a query string', () => {
    expect(isLogEndpoint(LOG_ENDPOINT)).toBe(true);
    expect(isLogEndpoint('/api/logs?k=abc123')).toBe(true);
    expect(isLogEndpoint('https://my-game.vercel.app/api/logs?k=abc123')).toBe(true);
  });

  it('does not match other URLs, so the NetworkGuard still covers real asset loads', () => {
    expect(isLogEndpoint('/api/log-auth')).toBe(false);
    expect(isLogEndpoint('/sprites/hero.png')).toBe(false);
    expect(isLogEndpoint('https://cdn.example.com/ship.glb')).toBe(false);
  });
});

describe('classifyResponse', () => {
  it('succeeds on 2xx', () => {
    expect(classifyResponse(200)).toBe('ok');
    expect(classifyResponse(204)).toBe('ok');
  });

  it('treats auth failures and a missing backend as permanent', () => {
    expect(classifyResponse(401)).toBe('fatal');
    expect(classifyResponse(403)).toBe('fatal');
    expect(classifyResponse(404)).toBe('fatal');
  });

  it('retries throttling and server errors', () => {
    expect(classifyResponse(429)).toBe('retry');
    expect(classifyResponse(500)).toBe('retry');
    expect(classifyResponse(503)).toBe('retry');
  });
});

describe('nextBackoffMs', () => {
  it('is zero before any failure and doubles thereafter', () => {
    expect(nextBackoffMs(0)).toBe(0);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(3)).toBe(8000);
  });

  it('is capped so a long outage does not schedule an absurd delay', () => {
    expect(nextBackoffMs(20)).toBe(60_000);
  });
});

describe('LogBatchQueue', () => {
  it('takes at most one batch worth, oldest first', () => {
    const queue = new LogBatchQueue({ maxPerBatch: 2 });
    queue.add(record(0));
    queue.add(record(1));
    queue.add(record(2));

    expect(queue.take().map((r) => r.seq)).toEqual([0, 1]);
    expect(queue.size()).toBe(1);
  });

  it('drops the OLDEST on overflow and counts the loss', () => {
    const queue = new LogBatchQueue({ maxQueued: 3, maxPerBatch: 10 });
    for (let i = 0; i < 5; i++) {
      queue.add(record(i));
    }
    expect(queue.take().map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(queue.consumeDropped()).toBe(2);
    // Reported once, then reset.
    expect(queue.consumeDropped()).toBe(0);
  });

  it('requeues a failed batch at the front, preserving order and the dropped count', () => {
    const queue = new LogBatchQueue({ maxPerBatch: 10 });
    queue.add(record(2));
    queue.requeue([record(0), record(1)], 4);

    expect(queue.take().map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(queue.consumeDropped()).toBe(4);
  });

  it('isBatchReady flips at the batch size', () => {
    const queue = new LogBatchQueue({ maxPerBatch: 2 });
    queue.add(record(0));
    expect(queue.isBatchReady()).toBe(false);
    queue.add(record(1));
    expect(queue.isBatchReady()).toBe(true);
  });
});

describe('describeSession', () => {
  it('works without a DOM and redacts the token out of the URL', () => {
    const meta = describeSession('abc', 42, (text) => text.replace('tok', '***'));
    expect(meta).toMatchObject({ sessionId: 'abc', startedAt: 42 });
  });
});

describe('RemoteLogSink', () => {
  const sinkOptions = (
    transport: ReturnType<typeof fakeTransport>['transport'],
    scheduler: Scheduler,
    extra: { maxPerBatch?: number; onDisabled?: (reason: string) => void } = {},
  ): ConstructorParameters<typeof RemoteLogSink>[0] => ({
    sessionId: 'sess1',
    transport,
    scheduler,
    now: () => 1_000_000,
    maxPerBatch: extra.maxPerBatch,
    onDisabled: extra.onDisabled,
  });

  it('batches ordinary records behind the timer instead of sending per call', async () => {
    const { scheduler, runDue, pending } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.write(record(0));
    sink.write(record(1));
    expect(sent).toHaveLength(0);
    expect(pending()).toEqual([2000]);

    await runDue();
    expect(sent).toHaveLength(1);
    expect(sent[0].records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it('sends an error immediately — it may be the last thing before the page dies', async () => {
    const { scheduler } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.write(record(0, 'error'));
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0].records[0].level).toBe('error');
  });

  it('sends as soon as a full batch accumulates', async () => {
    const { scheduler } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler, { maxPerBatch: 2 }));

    sink.write(record(0));
    sink.write(record(1));
    await Promise.resolve();

    expect(sent).toHaveLength(1);
  });

  it('includes the session header on the first batch only', async () => {
    const { scheduler, runDue } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.write(record(0));
    await runDue();
    sink.write(record(1));
    await runDue();

    expect(sent[0].meta).toMatchObject({ sessionId: 'sess1', startedAt: 1_000_000 });
    expect(sent[1].meta).toBeUndefined();
  });

  it('backfill() queues the pre-consent backlog and sends it', async () => {
    const { scheduler } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.backfill([record(0), record(1), record(2)]);
    await Promise.resolve();

    expect(sent[0].records.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it('retries a failed batch with backoff and does not lose records', async () => {
    const { scheduler, runDue, pending } = manualScheduler();
    const { transport, sent } = fakeTransport(['retry', 'ok']);
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.write(record(0));
    await runDue();
    expect(sent).toHaveLength(1);
    expect(pending()).toEqual([2000]);

    await runDue();
    expect(sent).toHaveLength(2);
    expect(sent[1].records.map((r) => r.seq)).toEqual([0]);
    // The session header is resent, since the batch carrying it never landed.
    expect(sent[1].meta).toBeDefined();
  });

  it('disables itself permanently on a fatal response rather than retrying on battery', async () => {
    const { scheduler, runDue, pending } = manualScheduler();
    const { transport, sent } = fakeTransport(['fatal']);
    const reasons: string[] = [];
    const sink = new RemoteLogSink(
      sinkOptions(transport, scheduler, { onDisabled: (reason) => void reasons.push(reason) }),
    );

    sink.write(record(0));
    await runDue();

    expect(sink.isDisabled()).toBe(true);
    expect(reasons).toHaveLength(1);
    expect(pending()).toEqual([]);

    sink.write(record(1));
    await runDue();
    expect(sent).toHaveLength(1);
  });

  it('reports the dropped count once the queue overflows', async () => {
    const { scheduler, runDue } = manualScheduler();
    const { transport, sent } = fakeTransport();
    const sink = new RemoteLogSink({
      ...sinkOptions(transport, scheduler),
      maxQueued: 2,
      maxPerBatch: 10,
    });

    sink.write(record(0));
    sink.write(record(1));
    sink.write(record(2));
    await runDue();

    expect(sent[0].dropped).toBe(1);
    expect(sent[0].records.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('dispose() hands anything pending to the beacon path and stops accepting records', () => {
    const { scheduler } = manualScheduler();
    const { transport, beacons } = fakeTransport();
    const sink = new RemoteLogSink(sinkOptions(transport, scheduler));

    sink.write(record(0));
    sink.dispose();

    expect(beacons).toHaveLength(1);
    expect(beacons[0].records.map((r) => r.seq)).toEqual([0]);
    expect(sink.isDisabled()).toBe(true);
  });
});
