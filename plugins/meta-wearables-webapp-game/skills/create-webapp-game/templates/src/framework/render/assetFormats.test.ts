/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  audioMimeFromUrl,
  entryWeight,
  isTextureUrl,
  loadDelayFromSearch,
  loadManifestWith,
  modelFormatFromUrl,
  resolveAssetUrl,
  withAudioSizes,
} from '@/framework/render/assetFormats';
import type { AssetManifestEntry, AudioManifestEntry } from '@/framework/render/assetFormats';

describe('modelFormatFromUrl', () => {
  it('maps model extensions to their loader, case-insensitively', () => {
    expect(modelFormatFromUrl('ship.glb')).toBe('gltf');
    expect(modelFormatFromUrl('ship.gltf')).toBe('gltf');
    expect(modelFormatFromUrl('ship.GLB')).toBe('gltf');
    expect(modelFormatFromUrl('ship.fbx')).toBe('fbx');
    expect(modelFormatFromUrl('ship.obj')).toBe('obj');
  });

  it('ignores query strings and hash fragments', () => {
    expect(modelFormatFromUrl('models/ship.glb?v=2')).toBe('gltf');
    expect(modelFormatFromUrl('models/ship.fbx#main')).toBe('fbx');
  });

  it('throws on an unsupported or missing extension', () => {
    expect(() => modelFormatFromUrl('ship.stl')).toThrow(/Unsupported model format/);
    expect(() => modelFormatFromUrl('ship')).toThrow(/Unsupported model format/);
  });
});

describe('isTextureUrl', () => {
  it('recognizes supported image extensions', () => {
    expect(isTextureUrl('hero.png')).toBe(true);
    expect(isTextureUrl('hero.webp')).toBe(true);
    expect(isTextureUrl('hero.JPG')).toBe(true);
    expect(isTextureUrl('hero.jpeg?cache=1')).toBe(true);
  });

  it('rejects non-image extensions', () => {
    expect(isTextureUrl('hero.glb')).toBe(false);
    expect(isTextureUrl('hero')).toBe(false);
  });
});

describe('resolveAssetUrl', () => {
  it('joins public-relative paths onto the base url', () => {
    expect(resolveAssetUrl('sprite.png', './')).toBe('./sprite.png');
    expect(resolveAssetUrl('./sprite.png', './')).toBe('./sprite.png');
    expect(resolveAssetUrl('models/ship.glb', '/game/')).toBe('/game/models/ship.glb');
  });

  it('adds a trailing slash to a base url that lacks one', () => {
    expect(resolveAssetUrl('sprite.png', '/game')).toBe('/game/sprite.png');
  });

  it('passes absolute references through unchanged', () => {
    expect(resolveAssetUrl('https://cdn.example.com/a.png', './')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(resolveAssetUrl('//cdn.example.com/a.png', './')).toBe('//cdn.example.com/a.png');
    expect(resolveAssetUrl('/root/a.png', './')).toBe('/root/a.png');
    expect(resolveAssetUrl('data:image/png;base64,AAAA', './')).toBe(
      'data:image/png;base64,AAAA',
    );
  });
});

describe('entryWeight', () => {
  it('uses declared bytes, falling back to 1', () => {
    expect(entryWeight({ type: 'texture', path: 'a.png', bytes: 2048 })).toBe(2048);
    expect(entryWeight({ type: 'texture', path: 'a.png' })).toBe(1);
  });
});

describe('loadDelayFromSearch', () => {
  it('is 0 when the param is absent', () => {
    expect(loadDelayFromSearch('')).toBe(0);
    expect(loadDelayFromSearch('?stats')).toBe(0);
  });

  it('uses an explicit millisecond value', () => {
    expect(loadDelayFromSearch('?slowload=1500')).toBe(1500);
    expect(loadDelayFromSearch('?foo=1&slowload=250')).toBe(250);
  });

  it('applies a default delay for a bare flag', () => {
    expect(loadDelayFromSearch('?slowload')).toBe(800);
    expect(loadDelayFromSearch('?slowload=')).toBe(800);
  });

  it('treats zero, negative, and non-numeric values as off', () => {
    expect(loadDelayFromSearch('?slowload=0')).toBe(0);
    expect(loadDelayFromSearch('?slowload=-100')).toBe(0);
    expect(loadDelayFromSearch('?slowload=abc')).toBe(0);
  });
});

describe('loadManifestWith', () => {
  it('resolves to a record keyed like the manifest', async () => {
    const manifest = {
      hero: { type: 'texture', path: 'hero.png' },
      ship: { type: 'model', path: 'ship.glb' },
    } satisfies Record<string, AssetManifestEntry>;

    const result = await loadManifestWith(manifest, async (entry) => entry.path);

    expect(result).toEqual({ hero: 'hero.png', ship: 'ship.glb' });
  });

  it('reports size-weighted progress, reaching exactly 1', async () => {
    const manifest = {
      big: { type: 'raw', path: 'big.bin', bytes: 900 },
      small: { type: 'raw', path: 'small.bin', bytes: 100 },
    } satisfies Record<string, AssetManifestEntry>;

    const seen: Array<[number, number, number]> = [];
    await loadManifestWith(
      manifest,
      async (entry) => entry.path,
      (fraction, loaded, total) => seen.push([fraction, loaded, total]),
    );

    // Completion order isn't guaranteed, so assert order-independent invariants: two callbacks,
    // each fraction is loaded/total against the fixed 1000 total, the intermediate weighted total
    // is one of the two asset sizes, and the final callback is exactly full.
    expect(seen).toHaveLength(2);
    for (const [fraction, loaded, total] of seen) {
      expect(total).toBe(1000);
      expect(fraction).toBe(loaded / total);
    }
    expect([100, 900]).toContain(seen[0][1]);
    expect(seen.at(-1)).toEqual([1, 1000, 1000]);
  });

  it('treats an entry without bytes as one unit', async () => {
    const manifest = {
      a: { type: 'raw', path: 'a.bin' },
      b: { type: 'raw', path: 'b.bin' },
    } satisfies Record<string, AssetManifestEntry>;

    const loadedValues: number[] = [];
    await loadManifestWith(
      manifest,
      async (entry) => entry.path,
      (_fraction, loaded, total) => {
        expect(total).toBe(2);
        loadedValues.push(loaded);
      },
    );

    expect(loadedValues.slice().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('reports 1 immediately for an empty manifest', async () => {
    const onProgress = vi.fn();
    const result = await loadManifestWith({}, async () => 'unused', onProgress);

    expect(result).toEqual({});
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(1, 0, 0);
  });

  it('rejects if any entry fails to load', async () => {
    const manifest = {
      ok: { type: 'raw', path: 'ok.bin' },
      bad: { type: 'raw', path: 'bad.bin' },
    } satisfies Record<string, AssetManifestEntry>;

    await expect(
      loadManifestWith(manifest, async (entry) => {
        if (entry.path === 'bad.bin') {
          throw new Error('boom');
        }
        return entry.path;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('audioMimeFromUrl', () => {
  it('maps every format the engine accepts', () => {
    expect(audioMimeFromUrl('assets/sounds/theme.ogg')).toBe('audio/ogg');
    expect(audioMimeFromUrl('theme.opus')).toBe('audio/ogg; codecs=opus');
    expect(audioMimeFromUrl('theme.mp3')).toBe('audio/mpeg');
    expect(audioMimeFromUrl('theme.wav')).toBe('audio/wav');
    expect(audioMimeFromUrl('theme.m4a')).toBe('audio/mp4');
    expect(audioMimeFromUrl('theme.flac')).toBe('audio/flac');
  });

  it('is case-insensitive', () => {
    expect(audioMimeFromUrl('THEME.OGG')).toBe('audio/ogg');
  });

  it('is empty for an unrecognized or absent extension, leaving the browser to sniff', () => {
    expect(audioMimeFromUrl('theme.xyz')).toBe('');
    expect(audioMimeFromUrl('theme')).toBe('');
  });
});

describe('withAudioSizes', () => {
  const SIZES = {
    'assets/sounds/Step.ogg': { sha256: 'a', bytes: 1_200, pcmBytes: 96_000 },
    'assets/sounds/Theme.ogg': { sha256: 'b', bytes: 900_000, pcmBytes: 30_000_000 },
  };

  it('fills bytes and pcmBytes on a banked clip', () => {
    const manifest: Record<string, AudioManifestEntry> = {
      step: { type: 'audio', path: 'assets/sounds/Step.ogg', bank: 'level_1' },
    };

    const merged = withAudioSizes(manifest, SIZES);

    expect(merged.step).toMatchObject({ bytes: 1_200, pcmBytes: 96_000 });
  });

  it('leaves a streamed clip without a pcmBytes hint', () => {
    // A `stream: true` clip is played from a blob URL and never decoded, so it has no PCM
    // footprint. Handing bank costing a number the documented contract says the entry cannot
    // carry is exactly the mismatch `validate()` reports.
    const manifest: Record<string, AudioManifestEntry> = {
      theme: { type: 'audio', path: 'assets/sounds/Theme.ogg', stream: true },
    };

    const merged = withAudioSizes(manifest, SIZES);

    expect(merged.theme.bytes).toBe(900_000);
    expect(merged.theme.pcmBytes).toBeUndefined();
  });

  it('clears a hand-written pcmBytes on a streamed clip rather than trusting it', () => {
    const manifest: Record<string, AudioManifestEntry> = {
      theme: {
        type: 'audio',
        path: 'assets/sounds/Theme.ogg',
        stream: true,
        pcmBytes: 12_345,
      },
    };

    const merged = withAudioSizes(manifest, SIZES);

    expect(merged.theme.pcmBytes).toBeUndefined();
  });

  it('passes a non-audio entry through untouched', () => {
    const manifest = {
      ship: { type: 'model', path: 'models/ship.glb', bytes: 42 },
    } as const;

    const merged = withAudioSizes(manifest, SIZES);

    expect(merged.ship).toEqual(manifest.ship);
  });

  it('leaves an audio entry the sidecar does not cover as declared', () => {
    const manifest: Record<string, AudioManifestEntry> = {
      ghost: { type: 'audio', path: 'assets/sounds/Ghost.ogg', bytes: 7, pcmBytes: 11 },
    };

    const merged = withAudioSizes(manifest, SIZES);

    expect(merged.ghost).toEqual(manifest.ghost);
  });
});
