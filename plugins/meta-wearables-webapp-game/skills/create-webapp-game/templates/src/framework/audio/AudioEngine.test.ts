/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Unit test for the pure `?mute` query-flag parser.
 *
 * `AudioEngine` itself needs a real `AudioContext` (browser only), so the class is not unit-tested
 * here — its behaviour is covered at the `AmpAudioPlayer` level against a fake engine, and the
 * node graph itself is verified by ear on device. Importing the module is safe in node because the
 * class touches Web Audio only inside methods, never at module load.
 */

import { describe, expect, it } from 'vitest';

import { muteRequested } from '@/framework/audio/AudioEngine';

describe('muteRequested', () => {
  it('is off when absent or explicitly disabled', () => {
    expect(muteRequested('')).toBe(false);
    expect(muteRequested('?stats')).toBe(false);
    expect(muteRequested('?mute=0')).toBe(false);
    expect(muteRequested('?mute=false')).toBe(false);
    expect(muteRequested('?mute=FALSE')).toBe(false);
  });

  it('is on when present with any other value (matching ?stats / ?slowload / ?strict)', () => {
    expect(muteRequested('?mute')).toBe(true);
    expect(muteRequested('?mute=1')).toBe(true);
    expect(muteRequested('?foo=1&mute=on')).toBe(true);
  });
});
