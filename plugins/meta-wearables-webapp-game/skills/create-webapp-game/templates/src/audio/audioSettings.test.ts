/**
 * Guards the game's own sound catalog. Two things can rot silently here, and both are cheap to
 * catch: the hand-written `SoundId` union drifting from the JSON's event names, and a typo in the
 * JSON that the type system cannot see (`resolveJsonModule` widens every string, so
 * `"type": "sqaure"` compiles fine).
 *
 * Runs in plain Node — no `AudioContext`, because `parseSettings` / `validateSettings` are pure.
 * Keep this file when you replace the starter's sounds; it is what makes the no-codegen approach
 * to typed sound ids safe.
 */

import { describe, expect, it } from 'vitest';

import { AUDIO_SETTINGS, SOUND_IDS } from '@/audio/soundIds';
import { parseSettings, validateSettings } from '@/framework/audio/audioSettings';

describe('audioSettings.json', () => {
  it('validates clean', () => {
    const parsed = parseSettings(AUDIO_SETTINGS);
    expect(validateSettings(parsed)).toEqual([]);
  });

  it('matches the SoundId union exactly', () => {
    const parsed = parseSettings(AUDIO_SETTINGS);
    expect(validateSettings(parsed, { declaredIds: SOUND_IDS })).toEqual([]);
  });

  it('ships no sample clips, so the starter needs no audio files or banks', () => {
    // Replace this expectation once your game has real recorded audio: at that point the clips
    // move into a bank and the preload manifest, and docs/audio-banks.md applies.
    const parsed = parseSettings(AUDIO_SETTINGS);
    for (const event of parsed.events.values()) {
      expect(event.sampleKeys).toEqual([]);
      expect(event.streamKeys).toEqual([]);
    }
  });
});
