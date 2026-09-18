/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Pure-logic tests for `AmpAudioPlayer`. No Web Audio: a fake engine is injected in place of the
 * real `AudioEngine`, so this runs in plain Node. The fake drives the **real** `VoicePool`, so the
 * concurrency behaviour the player depends on cannot drift from the engine's.
 *
 * Covers the parts most likely to regress: clip selection, cooldown, `chanceToPlay`, the bank
 * decode/free memory lifecycle and its budget, loop tracking, the four clip kinds (sample, synth,
 * stream, registered buffer), voice limits and shared groups, and validation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmpAudioPlayer, type AmpAudioPlayerOptions } from '@/framework/audio/AmpAudioPlayer';
import {
  DEFAULT_BANK,
  type AudioSettings,
  type SynthClipSpec,
} from '@/framework/audio/audioSettings';
import type { EnginePlayParams } from '@/framework/audio/AudioEngine';
import { pcmBytesOf } from '@/framework/audio/BankStore';
import type { SoundHandle } from '@/framework/audio/AudioPlayer';
import { VoicePool } from '@/framework/audio/VoicePool';

/** Stereo 48 kHz, one second: 2 x 48000 x 4 = 384000 bytes of PCM per decoded clip. */
const FAKE_BUFFER = { numberOfChannels: 2, length: 48_000, sampleRate: 48_000 } as AudioBuffer;
const CLIP_BYTES = pcmBytesOf(FAKE_BUFFER);

/**
 * Stand-in for `AudioEngine`. Holds no nodes, but runs the real admission policy so voice limits,
 * shared groups and the global cap behave exactly as they do in the browser. Voice lifetime is
 * manual — a one-shot lives until stopped or stolen, since there is no audio clock to end it.
 */
class FakeEngine {
  public ready = true;
  public readonly started: { kind: string; id: string; params: EnginePlayParams }[] = [];
  public reservedNoiseSeconds: number[] = [];
  public muted = false;
  public maxVoices = 24;

  private readonly pool = new VoicePool();
  private next = 1;
  private limit = 24;

  public get globalVoiceLimit(): number {
    return this.limit;
  }
  public set globalVoiceLimit(value: number) {
    this.limit = Math.max(1, Math.min(Math.floor(value), this.maxVoices));
  }

  public resume(): void {}
  public suspend(): void {}
  public async close(): Promise<void> {}
  public getContext(): null {
    return null;
  }
  public reserveNoiseSeconds(seconds: number): void {
    this.reservedNoiseSeconds.push(seconds);
  }
  public async decodeBytes(): Promise<AudioBuffer> {
    return FAKE_BUFFER;
  }

  public playBuffer(_buffer: AudioBuffer, params: EnginePlayParams): SoundHandle | null {
    return this.start('buffer', '', params);
  }
  public playSynth(_definition: unknown, params: EnginePlayParams): SoundHandle | null {
    return this.start('synth', '', params);
  }
  public playStream(url: string, params: EnginePlayParams): SoundHandle | null {
    return this.start('stream', url, params);
  }
  public createVoice(params: EnginePlayParams): { input: null; handle: SoundHandle } | null {
    const handle = this.start('custom', '', params);
    return handle === null ? null : { input: null, handle };
  }

  public isAlive(handle: SoundHandle): boolean {
    return this.pool.has(handle);
  }
  public stop(handle: SoundHandle, fadeOutMs = 0): void {
    if (fadeOutMs > 0) {
      // Mirrors the engine: a fading voice keeps its global slot but frees its group slot.
      this.pool.markStopping(handle);
    } else {
      this.pool.remove(handle);
    }
  }
  public stopAll(fadeOutMs = 0): void {
    for (const handle of this.pool.handles()) {
      this.stop(handle as SoundHandle, fadeOutMs);
    }
  }
  public stopVoiceGroup(groupId: string, fadeOutMs = 0): void {
    for (const handle of this.pool.handlesInGroup(groupId)) {
      this.stop(handle as SoundHandle, fadeOutMs);
    }
  }
  public voiceGroupCount(groupId: string): number {
    return this.pool.countInGroup(groupId);
  }
  public get activeVoiceCount(): number {
    return this.pool.size;
  }
  public get activeVoiceGroupIds(): string[] {
    return this.pool.activeGroupIds;
  }

  public setMasterVolume(): void {}
  public setBusVolume(): void {}
  public setMuted(muted: boolean): void {
    this.muted = muted;
  }
  public setVoiceVolume(): void {}
  public setVoicePosition(): void {}
  public setListener(): void {}

  private start(kind: string, id: string, params: EnginePlayParams): SoundHandle | null {
    const constraints = params.voiceGroups ?? [];
    const plan = this.pool.plan(constraints, this.limit);
    if (!plan.admitted) {
      return null;
    }
    for (const victim of plan.evict) {
      this.pool.remove(victim);
    }
    const handle = this.next++ as SoundHandle;
    this.pool.add(
      handle,
      constraints.map((constraint) => constraint.groupId),
      params.loop,
    );
    this.started.push({ kind, id, params });
    return handle;
  }
}

/** A one-layer square blip, as JSON would spell it. */
const BLIP: SynthClipSpec = { synth: { gain: 0.4, layers: [{ type: 'square', freq: 660, decay: 0.08 }] } };

const SETTINGS: AudioSettings = {
  global: { soundsBasePath: '', defaultCooldown: 50 },
  banks: [
    { id: 'shared', persistent: true },
    { id: 'level_1', transitionsTo: ['level_2'] },
    { id: 'level_2' },
  ],
  voiceGroups: [
    { id: 'ui', voiceLimit: 2 },
    { id: 'footsteps', voiceLimit: 3, voiceLimitStrategy: 'preventNew' },
  ],
  events: [
    { name: 'Poly', clips: ['p.ogg'], bank: 'shared', voiceLimit: 3 },
    { name: 'Guard', clips: ['g.ogg'], bank: 'shared', voiceLimit: 1, voiceLimitStrategy: 'preventNew' },
    { name: 'Wide', clips: ['w.ogg'], bank: 'shared', voiceLimit: 'max' },
    { name: 'Grouped_A', clips: ['ga.ogg'], bank: 'shared', voiceGroup: 'ui' },
    { name: 'Grouped_B', clips: ['gb.ogg'], bank: 'shared', voiceGroup: 'ui' },
    { name: 'Step_Metal', clips: ['sm.ogg'], bank: 'level_1', voiceGroup: 'footsteps', voiceLimit: 2 },
    { name: 'UI_Swipe', clips: ['a.ogg', 'b.ogg', 'c.ogg'], bank: 'shared', randomNonRepeating: true },
    { name: 'UI_Two', clips: ['t1.ogg', 't2.ogg'], bank: 'shared', randomNonRepeating: true },
    { name: 'UI_Cycle', clips: ['c1.ogg', 'c2.ogg', 'c3.ogg'], bank: 'shared', clipSelect: 'roundRobin' },
    { name: 'UI_One', clips: ['one.ogg'], bank: 'shared' },
    { name: 'L1_Step', clips: ['s1.ogg', 's2.ogg'], bank: 'level_1', cooldown: 200 },
    { name: 'L2_Step', clips: ['m1.ogg'], bank: 'level_2' },
    { name: 'Whoosh', clips: ['whoosh.ogg'], bank: ['level_1', 'level_2'] },
    { name: 'Ambience', clips: ['amb.ogg'], bank: 'level_1', loop: true, fadeOutDuration: 500, stream: false },
    { name: 'Chancy', clips: ['ch.ogg'], bank: 'level_1', chanceToPlay: 50 },
    { name: 'Blip', clips: [BLIP] },
    { name: 'Theme', clips: ['theme.ogg'], bus: 'music', loop: true },
  ],
};

/**
 * Distinct clips each bank decodes, counted from SETTINGS above. `shared` is 14 (Poly, Guard, Wide,
 * Grouped_A/B, three swipes, two UI_Two, three UI_Cycle, UI_One); `level_1` is 6 (sm, s1, s2,
 * whoosh, amb, ch); `level_2` is 2 (m1, whoosh). The default bank holds only synth and streamed
 * clips, so it costs nothing.
 */
const SHARED_CLIPS = { shared: 14, level_1: 6, level_2: 2 } as const;

/** Fits `shared` plus exactly one level bank — the interesting budget for swap tests. */
const TIGHT_BUDGET = (SHARED_CLIPS.shared + SHARED_CLIPS.level_1) * CLIP_BYTES;

/** Keys the settings play as streams — the manifest has to agree, and `validate()` checks it. */
const STREAMED_KEYS = new Set(['theme.ogg']);

/** Every sample/stream key the settings above reference, so preload can be simulated wholesale. */
const ALL_KEYS = [
  'p.ogg', 'g.ogg', 'w.ogg', 'ga.ogg', 'gb.ogg', 'sm.ogg',
  'a.ogg', 'b.ogg', 'c.ogg', 't1.ogg', 't2.ogg',
  'c1.ogg', 'c2.ogg', 'c3.ogg', 'one.ogg',
  's1.ogg', 's2.ogg', 'm1.ogg', 'whoosh.ogg', 'amb.ogg', 'ch.ogg', 'theme.ogg',
];

/** A streamed clip is held for streaming and needs no decoded-size hint; a sample clip is both. */
function storeOptions(key: string): { pcmBytes?: number; streamed?: boolean } {
  return STREAMED_KEYS.has(key) ? { streamed: true } : { pcmBytes: CLIP_BYTES };
}

async function makePlayer(
  options: AmpAudioPlayerOptions = {},
  settings: AudioSettings = SETTINGS,
  keys: readonly string[] = ALL_KEYS,
): Promise<{ audio: AmpAudioPlayer; fake: FakeEngine }> {
  const audio = new AmpAudioPlayer(settings, { maxResidentBytes: 64 * 1024 * 1024, ...options });
  const fake = new FakeEngine();
  // The player builds its engine in the constructor; the BankStore's decode closure reads
  // `this.engine` lazily, so swapping it here still routes decoding through the fake.
  (audio as unknown as { engine: FakeEngine }).engine = fake;
  for (const key of keys) {
    audio.storeClip(key, new Blob([new Uint8Array(16)]), storeOptions(key));
  }
  await audio.init();
  return { audio, fake };
}

afterEach(() => {
  vi.restoreAllMocks();
});


/**
 * `expect(issues.some(match)).toBe(true)` fails with a bare "expected false to be true", which
 * says nothing about what was actually reported. Falling back to the whole list puts the issues
 * themselves in the failure message.
 */
function expectIssue(issues: readonly string[], match: (issue: string) => boolean): void {
  expect(issues.find(match) ?? issues).toEqual(expect.any(String));
}

/** Negative form of `expectIssue`: a failure shows which unexpected issues matched. */
function expectNoIssue(issues: readonly string[], match: (issue: string) => boolean): void {
  expect(issues.filter(match)).toEqual([]);
}

describe('init + banks', () => {
  it('loads the default and persistent banks, not the level banks', async () => {
    const { audio } = await makePlayer();
    expect(audio.loadedBanks.sort()).toEqual([DEFAULT_BANK, 'shared'].sort());
  });

  it('registers every declared bank', async () => {
    const { audio } = await makePlayer();
    expect(audio.bankIds).toEqual(
      expect.arrayContaining([DEFAULT_BANK, 'shared', 'level_1', 'level_2']),
    );
  });

  it('loads initialBanks too', async () => {
    const audio = new AmpAudioPlayer(SETTINGS);
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      audio.storeClip(key, new Blob([new Uint8Array(16)]), storeOptions(key));
    }
    await audio.init({ initialBanks: ['level_2'] });
    expect(audio.loadedBanks).toContain('level_2');
  });
});

describe('play gating', () => {
  it('skips an event whose bank is not loaded', async () => {
    const { audio } = await makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(audio.play('L1_Step')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('plays once the bank is loaded', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    expect(audio.play('L1_Step')).not.toBeNull();
  });

  it('warns and skips an unknown event', async () => {
    const { audio } = await makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(audio.play('Nope')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('drops every play while muted', async () => {
    const { audio } = await makePlayer();
    audio.setMuted(true);
    expect(audio.play('UI_One')).toBeNull();
    audio.setMuted(false);
    expect(audio.play('UI_One')).not.toBeNull();
  });
});

describe('clip kinds', () => {
  it('plays a synth-only event with no bank loaded at all', async () => {
    // A synth clip costs no bytes, so it must never be gated on a bank — the bug this guards is
    // every synthesized sound going silent the moment banks were introduced.
    const { audio, fake } = await makePlayer();
    expect(audio.play('Blip')).not.toBeNull();
    expect(fake.started.at(-1)?.kind).toBe('synth');
  });

  it('reserves noise-buffer length for synth layers at registration', async () => {
    const noisy: AudioSettings = {
      events: [
        {
          name: 'Boom',
          clips: [{ synth: { layers: [{ type: 'noise', decay: 0.6, attack: 0.01 }] } }],
        },
      ],
    };
    const { fake } = await makePlayer({}, noisy, []);
    expect(fake.reservedNoiseSeconds.some((seconds) => seconds > 0.6)).toBe(true);
  });

  it('streams a music-bus event instead of decoding it', async () => {
    const { audio, fake } = await makePlayer();
    // Node has no URL.createObjectURL; the store degrades to null, so stub it for this path.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    expect(audio.play('Theme')).not.toBeNull();
    expect(fake.started.at(-1)?.kind).toBe('stream');
    expect(fake.started.at(-1)?.id).toBe('blob:fake');
  });

  it('keeps a streamed clip out of the decoded-PCM budget', async () => {
    const { audio } = await makePlayer();
    // theme.ogg is on the music bus, so it streams: no bank owns it and it never becomes PCM.
    expect(audio.describeEvent('Theme')?.sampleKeys).toEqual([]);
    expect(audio.describeEvent('Theme')?.streamKeys).toEqual(['theme.ogg']);
    await audio.loadBanks(['level_1', 'level_2']);
    expect(bankStore(audio).getBuffer('theme.ogg')).toBeUndefined();
  });

  it('plays a programmatically registered AudioBuffer', async () => {
    const { audio, fake } = await makePlayer();
    audio.registerSounds({ Custom: FAKE_BUFFER });
    expect(audio.play('Custom')).not.toBeNull();
    expect(fake.started.at(-1)?.kind).toBe('buffer');
  });
});

describe('clip selection', () => {
  it('randomNonRepeating never repeats consecutively over a long run', async () => {
    const { audio } = await makePlayer();
    const seen: number[] = [];
    for (let i = 0; i < 500; i++) {
      audio.play('UI_Swipe', { ignoreCooldown: true });
      seen.push(indexOf(audio, 'UI_Swipe'));
    }
    expect(seen.length).toBe(500);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('a 2-clip randomNonRepeating event strictly alternates', async () => {
    const { audio } = await makePlayer();
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      audio.play('UI_Two', { ignoreCooldown: true });
      seen.push(indexOf(audio, 'UI_Two'));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('roundRobin cycles in order', async () => {
    const { audio } = await makePlayer();
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      audio.play('UI_Cycle', { ignoreCooldown: true });
      seen.push(indexOf(audio, 'UI_Cycle'));
    }
    expect(seen).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });

  it('a single-clip event always selects clip 0', async () => {
    const { audio, fake } = await makePlayer();
    for (let i = 0; i < 5; i++) {
      audio.play('UI_One', { ignoreCooldown: true });
    }
    expect(indexOf(audio, 'UI_One')).toBe(0);
    expect(fake.started.length).toBe(5);
  });

  it('a dropped play does not consume a rotation slot', async () => {
    // Guard is monophonic + preventNew: the second play is refused, so the clip index must not
    // advance — otherwise a refused play silently skips a variant for the next real one.
    const { audio } = await makePlayer();
    audio.play('UI_Cycle', { ignoreCooldown: true });
    expect(indexOf(audio, 'UI_Cycle')).toBe(0);
    audio.globalVoiceLimit = 1;
    audio.play('Guard', { ignoreCooldown: true });
    audio.play('Guard', { ignoreCooldown: true }); // refused by preventNew
    expect(indexOf(audio, 'Guard')).toBe(0);
  });
});

/** The clip index the player last selected for an event — its variant-rotation state. */
function indexOf(audio: AmpAudioPlayer, name: string): number {
  const state = (audio as unknown as { state: Map<string, { lastClipIndex: number }> }).state;
  return state.get(name)?.lastClipIndex ?? -1;
}

describe('cooldown', () => {
  it('drops a second play inside the window and allows one outside it', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    let t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    expect(audio.play('L1_Step')).not.toBeNull(); // t=1000
    expect(audio.play('L1_Step')).toBeNull(); // still 1000, within the 200ms per-event cooldown
    t = 1300;
    expect(audio.play('L1_Step')).not.toBeNull();
  });

  it('falls back to the global default when an event sets none', async () => {
    const { audio } = await makePlayer();
    expect(audio.describeEvent('UI_One')?.cooldown).toBe(50);
    expect(audio.describeEvent('L1_Step')?.cooldown).toBe(200);
  });

  it('ignoreCooldown bypasses the guard', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    vi.spyOn(performance, 'now').mockReturnValue(0);
    expect(audio.play('L1_Step')).not.toBeNull();
    expect(audio.play('L1_Step', { ignoreCooldown: true })).not.toBeNull();
  });
});

describe('chanceToPlay', () => {
  it('a high roll skips and a low roll plays', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    // Through the injected RNG seam, not a Math.random spy: the player captures its RNG once, so
    // a spy installed afterwards would never be seen.
    audio.setRandom(() => 0.99); // 99 > 50 -> skip
    expect(audio.play('Chancy', { ignoreCooldown: true })).toBeNull();
    audio.setRandom(() => 0.01); // 1 < 50 -> play
    expect(audio.play('Chancy', { ignoreCooldown: true })).not.toBeNull();
  });
});

describe('bank lifecycle', () => {
  it('unloading a bank frees only clips no still-loaded bank references', async () => {
    const { audio } = await makePlayer();
    await audio.loadBanks(['level_1', 'level_2']);
    const store = bankStore(audio);
    expect(store.getBuffer('whoosh.ogg')).toBeDefined();
    expect(store.getBuffer('s1.ogg')).toBeDefined();

    audio.unloadBank('level_1');
    // level_1-only clips are freed…
    expect(store.getBuffer('s1.ogg')).toBeUndefined();
    expect(store.getBuffer('s2.ogg')).toBeUndefined();
    // …but the clip shared with still-loaded level_2 survives.
    expect(store.getBuffer('whoosh.ogg')).toBeDefined();
    expect(store.getBuffer('m1.ogg')).toBeDefined();
  });

  it('keeps compressed bytes so a reload costs no fetch', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    audio.unloadBank('level_1');
    // The Blob is still registered; only the decoded PCM went away.
    expect(bankStore(audio).has('s1.ogg')).toBe(true);
    await audio.loadBank('level_1');
    expect(bankStore(audio).getBuffer('s1.ogg')).toBeDefined();
  });

  it('refuses to unload the default bank', async () => {
    const { audio } = await makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    audio.unloadBank(DEFAULT_BANK);
    expect(audio.loadedBanks).toContain(DEFAULT_BANK);
    expect(warn).toHaveBeenCalled();
  });

  it('swapBanks swaps the level and keeps a persistent bank the caller did NOT name', async () => {
    // `shared` is deliberately absent from `keep`: `persistent: true` is what protects it. Naming
    // it here would make the assertion vacuous.
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    await audio.swapBanks([], ['level_2']);
    expect(audio.loadedBanks.sort()).toEqual([DEFAULT_BANK, 'level_2', 'shared'].sort());
    expect(audio.loadedBanks).not.toContain('level_1');
  });

  it('refuses a direct unload of a persistent bank', async () => {
    const { audio } = await makePlayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    audio.unloadBank('shared');
    expect(audio.loadedBanks).toContain('shared');
    expect(warn.mock.calls.flat().join(' ')).toContain('persistent');
  });

  it('keeps a persistent bank resident across a swap', async () => {
    const { audio } = await makePlayer();
    const store = bankStore(audio);
    await audio.swapBanks([], ['level_2']);
    // chime lives only in `shared`; a swap that frees it would silence every UI sound.
    expect(store.getBuffer('p.ogg')).toBeDefined();
  });
});

describe('memory budget', () => {
  it('tracks resident PCM as banks load and free', async () => {
    const { audio } = await makePlayer();
    const base = audio.residentBytes;
    await audio.loadBank('level_1');
    expect(audio.residentBytes).toBeGreaterThan(base);
    audio.unloadBank('level_1');
    expect(audio.residentBytes).toBe(base);
  });

  it('estimates a bank before decoding it, from the pcmBytes hints', async () => {
    const { audio } = await makePlayer();
    // level_1 decodes sm, s1, s2, whoosh, amb, ch — 6 distinct clips.
    expect(audio.estimateBankBytes('level_1')).toBe(SHARED_CLIPS.level_1 * CLIP_BYTES);
    expect(audio.estimateBankBytes('level_2')).toBe(SHARED_CLIPS.level_2 * CLIP_BYTES);
  });

  it('a sequential swap never exceeds max(outgoing, incoming)', async () => {
    // The budget fits `shared` + one level bank exactly, so an overlapped swap would not fit but a
    // sequential one must — this is the peak-residency guarantee the whole bank model exists for.
    const { audio } = await makePlayer({ maxResidentBytes: TIGHT_BUDGET });
    await audio.loadBank('level_1');
    let peak = audio.residentBytes;
    expect(peak).toBe(TIGHT_BUDGET); // shared (14) + level_1 (6), to the byte
    await audio.swapBanks(['shared'], ['level_2'], 'sequential');
    peak = Math.max(peak, audio.residentBytes);

    expect(peak).toBeLessThanOrEqual(TIGHT_BUDGET);
    expect(audio.loadedBanks).toContain('level_2');
    expect(audio.loadedBanks).not.toContain('level_1');
  });

  it('an overlapped swap that would exceed the budget falls back to sequential', async () => {
    const budget = TIGHT_BUDGET;
    const { audio } = await makePlayer({ maxResidentBytes: budget });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await audio.loadBank('level_1');
    await audio.swapBanks(['shared'], ['level_2'], 'overlapped');

    expect(warn.mock.calls.flat().join(' ')).toContain('falling back to a sequential swap');
    expect(audio.residentBytes).toBeLessThanOrEqual(budget);
    expect(audio.loadedBanks).toContain('level_2');
  });

  it('refuses to overlap when the incoming cost is unknown, rather than trusting a lower bound', async () => {
    // No hints anywhere and nothing decoded, so every bank estimates as 0. Trusting that would
    // wave through the first swap into an unmeasured bank — the exact case the check exists for.
    const audio = new AmpAudioPlayer(SETTINGS, { maxResidentBytes: 64 * 1024 * 1024 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      audio.storeClip(key, new Blob([new Uint8Array(16)]), STREAMED_KEYS.has(key) ? { streamed: true } : {});
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await audio.init();
    await audio.swapBanks(['shared'], ['level_2'], 'overlapped');

    expect(warn.mock.calls.flat().join(' ')).toContain('cannot be costed');
    expect(audio.loadedBanks).toContain('level_2');
  });

  it('overlaps normally once the sizes have been measured by an earlier decode', async () => {
    const audio = new AmpAudioPlayer(SETTINGS, { maxResidentBytes: 64 * 1024 * 1024 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      audio.storeClip(key, new Blob([new Uint8Array(16)]), STREAMED_KEYS.has(key) ? { streamed: true } : {});
    }
    await audio.init();
    await audio.loadBank('level_2');
    audio.unloadBank('level_2');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await audio.swapBanks(['shared'], ['level_2'], 'overlapped');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('cannot be costed');
  });

  it('an overlapped swap that fits keeps the outgoing bank until the incoming one is in', async () => {
    const { audio } = await makePlayer({ maxResidentBytes: 64 * 1024 * 1024 });
    await audio.loadBank('level_1');
    await audio.swapBanks([], ['level_2'], 'overlapped');
    expect(audio.loadedBanks).toContain('level_2');
    expect(audio.loadedBanks).not.toContain('level_1');
  });

  it('refuses a decode that would blow the budget rather than OOMing', async () => {
    const { audio } = await makePlayer({ maxResidentBytes: 2 * CLIP_BYTES });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await audio.loadBank('level_1'); // needs 5 clips, budget fits 2
    expect(audio.residentBytes).toBeLessThanOrEqual(2 * CLIP_BYTES);
    expect(warn.mock.calls.flat().join(' ')).toContain('over the');
  });
});

describe('loop tracking', () => {
  it('isPlaying reflects a live loop and stopSound clears it', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    expect(audio.play('Ambience')).not.toBeNull();
    expect(audio.isPlaying('Ambience')).toBe(true);
    audio.stopSound('Ambience');
    expect(audio.isPlaying('Ambience')).toBe(false);
  });

  it("unloading a loop's only bank stops it", async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    audio.play('Ambience');
    expect(audio.isPlaying('Ambience')).toBe(true);
    audio.unloadBank('level_1');
    expect(audio.isPlaying('Ambience')).toBe(false);
  });

  it('retriggering a loop crossfades instead of being blocked by its own tail', async () => {
    const { audio, fake } = await makePlayer();
    await audio.loadBank('level_1');

    const first = audio.play('Ambience', { ignoreCooldown: true });
    const second = audio.play('Ambience', { ignoreCooldown: true });

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The outgoing voice is still alive, fading out, but no longer counted.
    expect(fake.isAlive(first as SoundHandle)).toBe(true);
    expect(audio.activeVoices('Ambience')).toBe(1);
  });
});

describe('voice limits', () => {
  const burst = (audio: AmpAudioPlayer, name: string, times: number): (SoundHandle | null)[] =>
    Array.from({ length: times }, () => audio.play(name, { ignoreCooldown: true }));

  it('defaults an event to monophonic, stealing its own previous voice', async () => {
    const { audio, fake } = await makePlayer();
    const [first, second] = burst(audio, 'UI_One', 2);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(fake.isAlive(first as SoundHandle)).toBe(false);
    expect(audio.activeVoices('UI_One')).toBe(1);
  });

  it('voiceLimit stacks that many instances then steals the oldest', async () => {
    const { audio, fake } = await makePlayer();
    const handles = burst(audio, 'Poly', 3);
    expect(audio.activeVoices('Poly')).toBe(3);

    burst(audio, 'Poly', 1);
    expect(audio.activeVoices('Poly')).toBe(3);
    expect(fake.isAlive(handles[0] as SoundHandle)).toBe(false);
    expect(fake.isAlive(handles[2] as SoundHandle)).toBe(true);
  });

  it('preventNew drops the new play and protects the sounding one', async () => {
    const { audio, fake } = await makePlayer();
    const [first, second] = burst(audio, 'Guard', 2);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(fake.isAlive(first as SoundHandle)).toBe(true);
    expect(audio.activeVoices('Guard')).toBe(1);
  });

  it("voiceLimit 'max' resolves to the global limit", async () => {
    const { audio } = await makePlayer({ globalVoiceLimit: 6, maxVoices: 6 });
    burst(audio, 'Wide', 6);
    expect(audio.activeVoices('Wide')).toBe(6);
  });

  it('caps total polyphony at the global limit across all events', async () => {
    const { audio } = await makePlayer();
    audio.globalVoiceLimit = 3;
    burst(audio, 'Poly', 10);
    expect(audio.activeVoiceCount).toBeLessThanOrEqual(3);
  });
});

describe('shared voice groups', () => {
  it('spends one budget across several events, stealing across them', async () => {
    const { audio } = await makePlayer();
    audio.play('Grouped_A', { ignoreCooldown: true });
    audio.play('Grouped_B', { ignoreCooldown: true });
    expect(audio.voiceGroupCount('ui')).toBe(2);

    // The third UI voice takes the oldest in the group, which belongs to Grouped_A.
    audio.play('Grouped_B', { ignoreCooldown: true });
    expect(audio.voiceGroupCount('ui')).toBe(2);
    expect(audio.activeVoices('Grouped_A')).toBe(0);
    expect(audio.activeVoices('Grouped_B')).toBe(2);
  });

  it('leaves the private limit uncapped when only a group is declared', async () => {
    const { audio } = await makePlayer();
    expect(audio.describeEvent('Grouped_A')?.voiceLimit).toBe(audio.globalVoiceLimit);
    expect(audio.describeEvent('Grouped_A')?.voiceGroups).toEqual(['ui']);
  });

  it('applies a private limit and a group limit together', async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    for (let i = 0; i < 4; i++) {
      audio.play('Step_Metal', { ignoreCooldown: true });
    }
    // The private cap of 2 bites before the group cap of 3.
    expect(audio.activeVoices('Step_Metal')).toBe(2);
    expect(audio.voiceGroupCount('footsteps')).toBe(2);
  });
});

describe('per-event stop and isPlaying', () => {
  it('works for one-shots, not just loops', async () => {
    const { audio } = await makePlayer();
    audio.play('UI_One', { ignoreCooldown: true });
    expect(audio.isPlaying('UI_One')).toBe(true);

    audio.stopSound('UI_One');
    expect(audio.isPlaying('UI_One')).toBe(false);
  });

  it('stops only the named event, not others sharing its group', async () => {
    const { audio } = await makePlayer();
    audio.play('Grouped_A', { ignoreCooldown: true });
    audio.play('Grouped_B', { ignoreCooldown: true });

    audio.stopSound('Grouped_A');
    expect(audio.activeVoices('Grouped_A')).toBe(0);
    expect(audio.activeVoices('Grouped_B')).toBe(1);
  });

  it("unloading a bank silences that bank's one-shots too", async () => {
    const { audio } = await makePlayer();
    await audio.loadBank('level_1');
    audio.play('L1_Step', { ignoreCooldown: true });
    expect(audio.isPlaying('L1_Step')).toBe(true);

    audio.unloadBank('level_1');
    expect(audio.isPlaying('L1_Step')).toBe(false);
  });
});

describe('global settings block', () => {
  const withGlobal: AudioSettings = {
    global: { globalVoiceLimit: 4, defaultCooldown: 0, soundsBasePath: 'snd/' },
    events: [{ name: 'E', clips: ['e.ogg'] }],
  };

  it('reads globalVoiceLimit, defaultCooldown and soundsBasePath from JSON', async () => {
    const { audio } = await makePlayer({ maxVoices: 24 }, withGlobal, ['snd/e.ogg']);
    expect(audio.globalVoiceLimit).toBe(4);
    expect(audio.describeEvent('E')?.cooldown).toBe(0);
    expect(audio.describeEvent('E')?.sampleKeys).toEqual(['snd/e.ogg']);
  });

  it('lets init() options override the JSON', async () => {
    const audio = new AmpAudioPlayer(withGlobal, { maxVoices: 24 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    await audio.init({ globalVoiceLimit: 12, soundsBasePath: '' });

    expect(audio.globalVoiceLimit).toBe(12);
    expect(audio.describeEvent('E')?.sampleKeys).toEqual(['e.ogg']);
  });
});

describe('graceful degradation', () => {
  it('is a silent no-op when Web Audio is unavailable', async () => {
    const audio = new AmpAudioPlayer(SETTINGS);
    const fake = new FakeEngine();
    fake.ready = false;
    (audio as unknown as { engine: FakeEngine }).engine = fake;
    await audio.init();

    // Events still resolve, so validate() and the dev overlay work…
    expect(audio.describeEvent('UI_One')).toBeDefined();
    // …but nothing is loaded and nothing throws.
    expect(audio.loadedBanks).toEqual([]);
    expect(() => audio.stopAll()).not.toThrow();
    await expect(audio.loadBank('level_1')).resolves.toBeUndefined();
  });
});

describe('validate', () => {
  it('flags empty clips, a bad clipSelect pool, and out-of-range chanceToPlay', async () => {
    const bad: AudioSettings = {
      events: [
        { name: 'Empty', clips: [] },
        { name: 'SoloRandom', clips: ['x.ogg'], randomNonRepeating: true },
        { name: 'BadChance', clips: ['y.ogg'], chanceToPlay: 250 },
      ],
    };
    const { audio } = await makePlayer({}, bad, ['x.ogg', 'y.ogg']);
    const issues = audio.validate();
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Empty'),
        expect.stringContaining('SoloRandom'),
        expect.stringContaining('BadChance'),
      ]),
    );
  });

  it('reports no issues for a clean config', async () => {
    const { audio } = await makePlayer();
    expect(audio.validate()).toEqual([]);
  });

  it('flags voice group problems', async () => {
    const bad: AudioSettings = {
      global: { globalVoiceLimit: 8, soundsBasePath: '' },
      voiceGroups: [
        { id: '@event:sneaky', voiceLimit: 2 },
        { id: 'huge', voiceLimit: 99 },
      ],
      events: [
        // A misspelled strategy: TS would catch it, hand-authored JSON would not.
        {
          name: 'BadStrategy',
          clips: ['s.ogg'],
          voiceLimitStrategy: 'StopOldest' as unknown as 'killOldest',
        },
        { name: 'Typo', clips: ['a.ogg'], voiceGroup: 'footstpes' },
        { name: 'Fractional', clips: ['b.ogg'], voiceLimit: 2.5 },
        { name: 'TooMany', clips: ['c.ogg'], voiceLimit: 50 },
        { name: 'StackedLoop', clips: ['d.ogg'], loop: true, voiceLimit: 3 },
      ],
    };
    const { audio } = await makePlayer({}, bad, ['s.ogg', 'a.ogg', 'b.ogg', 'c.ogg', 'd.ogg']);
    const issues = audio.validate();

    expectIssue(issues, (i) => i.includes("undeclared voice group 'footstpes'"));
    expectIssue(issues, (i) => i.includes('Fractional'));
    expectIssue(issues, (i) => i.includes('TooMany'));
    expectIssue(issues, (i) => i.includes('StackedLoop'));
    expectIssue(issues, (i) => i.includes('reserved'));
    expectIssue(issues, (i) => i.includes("'huge'"));
    expectIssue(issues, (i) => i.includes('BadStrategy') && i.includes("voiceLimitStrategy 'StopOldest'"));
  });

  it('flags a clip no preload-manifest entry supplies', async () => {
    const { audio } = await makePlayer({}, SETTINGS, ['p.ogg']); // only one clip preloaded
    const issues = audio.validate();
    expectIssue(issues, (i) => i.includes("references clip 'one.ogg'"));
  });

  it('flags drift between the events and the SoundId union', async () => {
    const settings: AudioSettings = {
      global: { soundsBasePath: '' },
      events: [{ name: 'Present', clips: ['p.ogg'] }],
    };
    const { audio } = await makePlayer({}, settings, ['p.ogg']);
    const issues = audio.validate(['Present', 'Ghost']);
    expectIssue(issues, (i) => i.includes("SoundId 'Ghost' has no event"));
    expect(audio.validate(['Present'])).toEqual([]);
  });

  it('flags a declared bank transition that cannot fit in the budget', async () => {
    const { audio } = await makePlayer({ maxResidentBytes: 3 * CLIP_BYTES });
    const issues = audio.validate();
    expectIssue(issues, (i) => i.includes("Banks 'level_1' -> 'level_2'"));
  });

  it('flags an event that streams a clip the manifest holds for decoding', async () => {
    const audio = new AmpAudioPlayer(SETTINGS, { maxResidentBytes: 64 * 1024 * 1024 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      // Every key stored as a decodable sample, including the one the music event streams.
      audio.storeClip(key, new Blob([new Uint8Array(16)]), { pcmBytes: CLIP_BYTES });
    }
    await audio.init();
    expectIssue(audio.validate(), (i) => i.includes("streams clip 'theme.ogg'") && i.includes('stream: true'));
  });

  it('flags an event that decodes a clip the manifest holds for streaming', async () => {
    const audio = new AmpAudioPlayer(SETTINGS, { maxResidentBytes: 64 * 1024 * 1024 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      audio.storeClip(key, new Blob([new Uint8Array(16)]), { streamed: true });
    }
    await audio.init();
    expectIssue(audio.validate(), (i) => i.includes("decodes clip 'p.ogg'") && i.includes('will be silent'));
  });

  it('asks for no pcmBytes hint on a streamed clip, which never becomes PCM', async () => {
    const { audio } = await makePlayer();
    // theme.ogg is stored with `streamed: true` and no hint, and that is not an issue.
    expectNoIssue(audio.validate(), (i) => i.includes('theme.ogg'));
  });

  it('reports a transitionsTo pair it cannot check, instead of passing vacuously', async () => {
    const audio = new AmpAudioPlayer(SETTINGS, { maxResidentBytes: 64 * 1024 * 1024 });
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    for (const key of ALL_KEYS) {
      audio.storeClip(key, new Blob([new Uint8Array(16)]), STREAMED_KEYS.has(key) ? { streamed: true } : {});
    }
    await audio.init();
    expectIssue(audio.validate(), (i) => i.includes("'level_1' -> 'level_2'") && i.includes('cannot be checked'));
  });

  it('flags a missing pcmBytes hint', async () => {
    const audio = new AmpAudioPlayer(
      { global: { soundsBasePath: '' }, events: [{ name: 'E', clips: ['e.ogg'] }] },
      {},
    );
    (audio as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    audio.storeClip('e.ogg', new Blob([new Uint8Array(4)])); // no hint
    await audio.init();
    expectIssue(audio.validate(), (i) => i.includes('no pcmBytes hint'));
  });
});

/** The player's private byte store, for asserting exactly which clips are decoded. */
function bankStore(audio: AmpAudioPlayer): {
  getBuffer(key: string): AudioBuffer | undefined;
  has(key: string): boolean;
} {
  return (audio as unknown as { banks: { getBuffer(key: string): AudioBuffer | undefined; has(key: string): boolean } })
    .banks;
}
