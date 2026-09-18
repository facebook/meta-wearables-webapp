/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it } from 'vitest';

import { logOverlayRequested } from '@/framework/debug/LogOverlay';

// Only the flag parser is unit-tested here: LogOverlay itself is a DOM writer with no logic
// worth asserting in the node env, the same split as PerfSampler (tested) vs PerfOverlay (not).
describe('logOverlayRequested', () => {
  it('is off when absent or explicitly disabled', () => {
    expect(logOverlayRequested('')).toBe(false);
    expect(logOverlayRequested('?log=debug')).toBe(false);
    expect(logOverlayRequested('?logview=0')).toBe(false);
    expect(logOverlayRequested('?logview=false')).toBe(false);
    expect(logOverlayRequested('?logview=FALSE')).toBe(false);
  });

  it('is on when present with any other value (matching ?stats / ?strict / ?mute)', () => {
    expect(logOverlayRequested('?logview')).toBe(true);
    expect(logOverlayRequested('?logview=1')).toBe(true);
    expect(logOverlayRequested('?log=trace&logview=on')).toBe(true);
  });
});
