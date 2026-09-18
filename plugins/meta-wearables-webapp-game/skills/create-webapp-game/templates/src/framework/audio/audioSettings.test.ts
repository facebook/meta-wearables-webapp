/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Tests for the pure config layer: how `audioSettings.json` resolves to events, and what
 * `validate()` catches. No `AudioContext`, no DOM, no engine — `parseSettings` and
 * `validateSettings` are functions over plain data, which is the whole reason they live in their
 * own file.
 *
 * The runtime consequences of these resolutions (which clip actually plays, which bank decodes) are
 * covered in `AmpAudioPlayer.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BANK,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_GLOBAL_VOICE_LIMIT,
  eventVoiceGroupId,
  parseSettings,
  toSynthDefinition,
  validateSettings,
  type AudioSettings,
} from '@/framework/audio/audioSettings';

const event = (settings: AudioSettings, name: string) => {
  const resolved = parseSettings(settings).events.get(name);
  if (!resolved) {
    throw new Error(`No event '${name}'`);
  }
  return resolved;
};


/**
 * `expect(issues.some(match)).toBe(true)` fails with a bare "expected false to be true", which
 * says nothing about what was actually reported. Falling back to the whole list puts the issues
 * themselves in the failure message.
 */
function expectIssue(issues: readonly string[], match: (issue: string) => boolean): void {
  expect(issues.find(match) ?? issues).toEqual(expect.any(String));
}

describe('parseSettings — defaults', () => {
  const settings: AudioSettings = { events: [{ name: 'Bare', clips: ['b.ogg'] }] };

  it('applies the documented defaults to a minimal event', () => {
    const bare = event(settings, 'Bare');
    expect(bare.volume).toBe(1);
    expect(bare.pitch).toBe(1);
    expect(bare.loop).toBe(false);
    expect(bare.chanceToPlay).toBe(100);
    expect(bare.bus).toBe('sfx');
    expect(bare.cooldown).toBe(DEFAULT_COOLDOWN_MS);
    expect(bare.clipSelect).toBe('random');
    // Monophonic by default: one instance of an event at a time unless it says otherwise.
    expect(bare.voiceLimit).toBe(1);
    expect(bare.voiceLimitStrategy).toBe('killOldest');
  });

  it('puts an event that declares no bank in the always-resident default bank', () => {
    expect(event(settings, 'Bare').banks).toEqual([DEFAULT_BANK]);
  });

  it('registers a bank an event names but never declares', () => {
    const parsed = parseSettings({ events: [{ name: 'E', clips: ['e.ogg'], bank: 'implicit' }] });
    expect(parsed.banks.has('implicit')).toBe(true);
  });

  it('lets init() overrides win over the JSON global block', () => {
    const withGlobal: AudioSettings = {
      global: { globalVoiceLimit: 4, defaultCooldown: 10, soundsBasePath: 'a/' },
      events: [{ name: 'E', clips: ['e.ogg'] }],
    };
    const parsed = parseSettings(withGlobal, { globalVoiceLimit: 12, soundsBasePath: 'b/' });
    expect(parsed.globalVoiceLimit).toBe(12);
    expect(parsed.defaultCooldown).toBe(10); // not overridden, so the JSON stands
    expect(parsed.events.get('E')?.sampleKeys).toEqual(['b/e.ogg']);
  });
});

describe('parseSettings — voice limits', () => {
  const settings: AudioSettings = {
    global: { globalVoiceLimit: 8 },
    voiceGroups: [{ id: 'ui', voiceLimit: 2 }],
    events: [
      { name: 'Plain', clips: ['a.ogg'] },
      { name: 'Capped', clips: ['a.ogg'], voiceLimit: 3 },
      { name: 'Grouped', clips: ['a.ogg'], voiceGroup: 'ui' },
      { name: 'Both', clips: ['a.ogg'], voiceGroup: 'ui', voiceLimit: 2 },
      { name: 'Max', clips: ['a.ogg'], voiceLimit: 'max' },
      { name: 'Over', clips: ['a.ogg'], voiceLimit: 99 },
    ],
  };

  it('caps a plain event at 1 and an explicit one at its voiceLimit', () => {
    expect(event(settings, 'Plain').voiceLimit).toBe(1);
    expect(event(settings, 'Capped').voiceLimit).toBe(3);
  });

  it('drops the private cap when only a group is declared, so the group governs', () => {
    expect(event(settings, 'Grouped').voiceLimit).toBe(8);
    expect(event(settings, 'Grouped').voiceGroups).toEqual(['ui']);
  });

  it('applies both caps when both are declared', () => {
    expect(event(settings, 'Both').voiceLimit).toBe(2);
    expect(event(settings, 'Both').voiceGroups).toEqual(['ui']);
  });

  it("resolves 'max' to the global limit and clamps anything above it", () => {
    expect(event(settings, 'Max').voiceLimit).toBe(8);
    expect(event(settings, 'Over').voiceLimit).toBe(8);
  });

  it('namespaces the implicit per-event group so it cannot collide with a shared one', () => {
    expect(eventVoiceGroupId('ui')).not.toBe('ui');
    expect(eventVoiceGroupId('ui').startsWith('@event:')).toBe(true);
  });
});

describe('parseSettings — clips', () => {
  it('resolves a sample filename against soundsBasePath', () => {
    const parsed = parseSettings({
      global: { soundsBasePath: 'assets/sounds/' },
      events: [{ name: 'E', clips: ['step.ogg'] }],
    });
    expect(parsed.events.get('E')?.sampleKeys).toEqual(['assets/sounds/step.ogg']);
  });

  it('builds an inline synth clip, filling the tone() defaults', () => {
    const parsed = parseSettings({
      events: [
        { name: 'Blip', clips: [{ synth: { layers: [{ type: 'square', freq: 440, decay: 0.1 }] } }] },
      ],
    });
    const clip = parsed.events.get('Blip')?.clips[0];
    expect(clip?.kind).toBe('synth');
    if (clip?.kind !== 'synth') {
      throw new Error('expected a synth clip');
    }
    const [layer] = clip.definition.layers;
    // `freq` is shorthand for a flat pitch, and the rest come from the shared tone() defaults.
    expect(layer.startFreq).toBe(440);
    expect(layer.endFreq).toBe(440);
    expect(layer.peak).toBe(1);
    expect(layer.delaySeconds).toBe(0);
    expect(layer.detune).toBe(0);
    expect(clip.definition.gain).toBe(0.5);
  });

  it('costs a synth event nothing and frees it from bank gating', () => {
    const parsed = parseSettings({
      events: [
        {
          name: 'Blip',
          clips: [{ synth: { layers: [{ type: 'sine', freq: 440, decay: 0.1 }] } }],
          bank: 'level_1',
        },
      ],
    });
    const blip = parsed.events.get('Blip');
    expect(blip?.sampleKeys).toEqual([]);
    // Forced into the default bank precisely so it is never gated on a bank load.
    expect(blip?.banks).toEqual([DEFAULT_BANK]);
  });

  it('streams music-bus clips by default and decodes sfx-bus ones', () => {
    const parsed = parseSettings({
      global: { soundsBasePath: '' },
      events: [
        { name: 'Theme', clips: ['theme.ogg'], bus: 'music' },
        { name: 'Sting', clips: ['sting.ogg'], bus: 'music', stream: false },
        { name: 'Ambience', clips: ['amb.ogg'], stream: true },
        { name: 'Step', clips: ['step.ogg'] },
      ],
    });
    expect(parsed.events.get('Theme')?.streamKeys).toEqual(['theme.ogg']);
    expect(parsed.events.get('Theme')?.sampleKeys).toEqual([]);
    // An explicit `stream` overrides the bus default in both directions.
    expect(parsed.events.get('Sting')?.sampleKeys).toEqual(['sting.ogg']);
    expect(parsed.events.get('Ambience')?.streamKeys).toEqual(['amb.ogg']);
    expect(parsed.events.get('Step')?.sampleKeys).toEqual(['step.ogg']);
  });

  it('accepts randomNonRepeating as the native-AMP spelling of clipSelect', () => {
    const parsed = parseSettings({
      events: [
        { name: 'A', clips: ['a.ogg', 'b.ogg'], randomNonRepeating: true },
        { name: 'B', clips: ['a.ogg', 'b.ogg'], clipSelect: 'roundRobin' },
        { name: 'C', clips: ['a.ogg', 'b.ogg'] },
      ],
    });
    expect(parsed.events.get('A')?.clipSelect).toBe('randomNonRepeating');
    expect(parsed.events.get('B')?.clipSelect).toBe('roundRobin');
    expect(parsed.events.get('C')?.clipSelect).toBe('random');
  });
});

describe('parseSettings — totality', () => {
  it('never throws on malformed input, so one bad clip cannot break startup', () => {
    const broken = {
      events: [
        { name: 'NoClips', clips: [] },
        { name: 'EmptySynth', clips: [{ synth: { layers: [] } }] },
        { name: 'BadStrategy', clips: ['a.ogg'], voiceLimitStrategy: 'Nope' },
        { name: 'BadSelect', clips: ['a.ogg', 'b.ogg'], clipSelect: 'sideways' },
      ],
    } as unknown as AudioSettings;
    expect(() => parseSettings(broken)).not.toThrow();
    const parsed = parseSettings(broken);
    // The layerless synth clip is dropped rather than crashing `synth()`…
    expect(parsed.events.get('EmptySynth')?.clips).toEqual([]);
    // …and an unknown value falls back to its default.
    expect(parsed.events.get('BadStrategy')?.voiceLimitStrategy).toBe('Nope');
    expect(parsed.events.get('BadSelect')?.clipSelect).toBe('random');
  });

  it('reports every one of those as a validate() issue instead', () => {
    const broken = {
      events: [
        { name: 'NoClips', clips: [] },
        { name: 'EmptySynth', clips: [{ synth: { layers: [] } }] },
        { name: 'BadStrategy', clips: ['a.ogg'], voiceLimitStrategy: 'Nope' },
        { name: 'BadSelect', clips: ['a.ogg', 'b.ogg'], clipSelect: 'sideways' },
      ],
    } as unknown as AudioSettings;
    const issues = validateSettings(parseSettings(broken));
    expectIssue(issues, (i) => i.includes('NoClips') && i.includes('no clips'));
    expectIssue(issues, (i) => i.includes('EmptySynth') && i.includes('no layers'));
    expectIssue(issues, (i) => i.includes('BadStrategy') && i.includes("'Nope'"));
    expectIssue(issues, (i) => i.includes('BadSelect') && i.includes("'sideways'"));
  });
});

describe('validateSettings', () => {
  it('passes a clean config', () => {
    expect(
      validateSettings(
        parseSettings({
          global: { soundsBasePath: '' },
          banks: [{ id: 'level_1' }],
          voiceGroups: [{ id: 'ui', voiceLimit: 2 }],
          events: [
            { name: 'Tap', clips: ['t.ogg'], bank: 'level_1', voiceGroup: 'ui' },
            { name: 'Steps', clips: ['a.ogg', 'b.ogg'], bank: 'level_1', clipSelect: 'roundRobin' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('flags clipSelect and randomNonRepeating disagreeing', () => {
    const issues = validateSettings(
      parseSettings({
        events: [
          { name: 'E', clips: ['a.ogg', 'b.ogg'], clipSelect: 'roundRobin', randomNonRepeating: true },
        ],
      }),
    );
    expectIssue(issues, (i) => i.includes('they disagree'));
  });

  it('flags a bank declared on an event with nothing a bank could free', () => {
    const issues = validateSettings(
      parseSettings({
        events: [
          {
            name: 'Blip',
            clips: [{ synth: { layers: [{ type: 'sine', freq: 440, decay: 0.1 }] } }],
            bank: 'level_1',
          },
        ],
      }),
    );
    expectIssue(issues, (i) => i.includes('no clips a bank can free'));
  });

  it('flags a transitionsTo pair that cannot both be resident', () => {
    const parsed = parseSettings({
      global: { soundsBasePath: '' },
      banks: [{ id: 'a', transitionsTo: ['b'] }, { id: 'b' }],
      events: [
        { name: 'A', clips: ['a.ogg'], bank: 'a' },
        { name: 'B', clips: ['b.ogg'], bank: 'b' },
      ],
    });
    const issues = validateSettings(parsed, {
      estimateBankBytes: () => 10 * 1024 * 1024,
      maxResidentBytes: 15 * 1024 * 1024,
    });
    expectIssue(issues, (i) => i.includes("Banks 'a' -> 'b'"));
  });

  it('flags a transitionsTo target that is not a bank', () => {
    const parsed = parseSettings({
      banks: [{ id: 'a', transitionsTo: ['ghost'] }],
      events: [{ name: 'A', clips: ['a.ogg'], bank: 'a' }],
    });
    const issues = validateSettings(parsed, {
      estimateBankBytes: () => 0,
      maxResidentBytes: 1,
    });
    expectIssue(issues, (i) => i.includes("transitionsTo 'ghost'"));
  });
});

describe('toSynthDefinition', () => {
  it('treats startFreq/endFreq as a bend and freq as flat', () => {
    const bend = toSynthDefinition({
      synth: { layers: [{ type: 'square', startFreq: 900, endFreq: 420, decay: 0.08 }] },
    });
    expect(bend.layers[0].startFreq).toBe(900);
    expect(bend.layers[0].endFreq).toBe(420);

    const flat = toSynthDefinition({ synth: { layers: [{ type: 'square', freq: 440, decay: 0.08 }] } });
    expect(flat.layers[0].startFreq).toBe(flat.layers[0].endFreq);
  });

  it('defaults a noise layer to zero frequencies, which the engine ignores anyway', () => {
    const noise = toSynthDefinition({ synth: { layers: [{ type: 'noise', decay: 0.6, peak: 0.9 }] } });
    expect(noise.layers[0].type).toBe('noise');
    expect(noise.layers[0].peak).toBe(0.9);
  });
});

describe('module constants', () => {
  it('states the documented global defaults', () => {
    // These are quoted in docs/audio.md; a change here needs a change there.
    expect(DEFAULT_COOLDOWN_MS).toBe(50);
    expect(DEFAULT_GLOBAL_VOICE_LIMIT).toBe(24);
  });
});
