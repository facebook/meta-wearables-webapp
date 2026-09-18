/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { atlasFrameTexture, atlasSprite } from '@/framework/render/AssetLoader';

/**
 * A stand-in for a loaded sheet. `THREE.Texture` needs no GPU and reads its size from
 * `image.width` / `image.height`, so a plain object is enough to exercise the UV math.
 */
function sheetTexture(width: number, height: number): THREE.Texture {
  return new THREE.Texture({ width, height } as unknown as HTMLImageElement);
}

describe('atlasFrameTexture', () => {
  it('windows a frame from the sheet top-left', () => {
    const frame = atlasFrameTexture(sheetTexture(256, 128), { x: 64, y: 32, w: 32, h: 64 });

    // repeat is the frame's fraction of the sheet; offset is its lower-left corner in bottom-up V.
    expect(frame.repeat.x).toBeCloseTo(32 / 256);
    expect(frame.repeat.y).toBeCloseTo(64 / 128);
    expect(frame.offset.x).toBeCloseTo(64 / 256);
    expect(frame.offset.y).toBeCloseTo(1 - (32 + 64) / 128);
  });

  it('flips V, so the top row and the bottom row land at different offsets', () => {
    const sheet = sheetTexture(128, 256);
    const top = atlasFrameTexture(sheet, { x: 0, y: 0, w: 128, h: 64 });
    const bottom = atlasFrameTexture(sheet, { x: 0, y: 192, w: 128, h: 64 });

    // flipY leaves V = 1 at the sheet's top row, so the TOP frame sits at the HIGH offset.
    expect(top.offset.y).toBeCloseTo(0.75);
    expect(bottom.offset.y).toBeCloseTo(0);
    expect(top.offset.y).toBeGreaterThan(bottom.offset.y);
  });

  it('covers the whole sheet for a full-sheet frame', () => {
    const frame = atlasFrameTexture(sheetTexture(64, 64), { x: 0, y: 0, w: 64, h: 64 });

    expect(frame.offset.toArray()).toEqual([0, 0]);
    expect(frame.repeat.toArray()).toEqual([1, 1]);
  });

  it('gives each frame of one sheet an independent window', () => {
    const sheet = sheetTexture(256, 256);
    const first = atlasFrameTexture(sheet, { x: 0, y: 0, w: 128, h: 128 });
    const second = atlasFrameTexture(sheet, { x: 128, y: 0, w: 128, h: 128 });

    expect(first.offset.x).toBeCloseTo(0);
    expect(second.offset.x).toBeCloseTo(0.5);
    expect(first).not.toBe(second);
    // The clones share the sheet's Source (one GPU upload) while holding separate windows.
    expect(first.source).toBe(sheet.source);
    expect(second.source).toBe(sheet.source);
    expect(sheet.offset.toArray()).toEqual([0, 0]);
  });

  it('throws when the sheet has no decoded image', () => {
    expect(() => atlasFrameTexture(new THREE.Texture(), { x: 0, y: 0, w: 8, h: 8 })).toThrow(
      /no decoded image/,
    );
    expect(() => atlasFrameTexture(sheetTexture(0, 0), { x: 0, y: 0, w: 8, h: 8 })).toThrow(
      /no decoded image/,
    );
  });

  it('throws when the frame does not fit inside the sheet', () => {
    const sheet = sheetTexture(128, 128);

    expect(() => atlasFrameTexture(sheet, { x: 96, y: 0, w: 64, h: 32 })).toThrow(
      /does not fit inside the 128x128 sheet/,
    );
    expect(() => atlasFrameTexture(sheet, { x: 0, y: 96, w: 32, h: 64 })).toThrow(/does not fit/);
    expect(() => atlasFrameTexture(sheet, { x: -8, y: 0, w: 32, h: 32 })).toThrow(/does not fit/);
    expect(() => atlasFrameTexture(sheet, { x: 0, y: 0, w: 0, h: 32 })).toThrow(/does not fit/);
  });

  it('throws on a non-finite frame rather than windowing to NaN', () => {
    const sheet = sheetTexture(128, 128);

    // NaN is the case the bounds check cannot catch on its own: comparisons with it are all false.
    expect(() => atlasFrameTexture(sheet, { x: Number.NaN, y: 0, w: 32, h: 32 })).toThrow(
      /not a finite pixel rect/,
    );
    expect(() => atlasFrameTexture(sheet, { x: 0, y: 0, w: Number.NaN, h: 32 })).toThrow(
      /not a finite pixel rect/,
    );
    expect(() =>
      atlasFrameTexture(sheet, { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 32 }),
    ).toThrow(/not a finite pixel rect/);
  });
});

describe('atlasSprite', () => {
  it('builds a quad whose material map is the windowed frame', () => {
    const sheet = sheetTexture(256, 256);
    const mesh = atlasSprite(sheet, { x: 128, y: 128, w: 128, h: 128 }, { width: 2, height: 3 });

    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.map).not.toBe(sheet);
    expect(material.map?.offset.toArray()).toEqual([0.5, 0]);
    expect(material.map?.repeat.toArray()).toEqual([0.5, 0.5]);
    expect(material.transparent).toBe(true);

    const geometry = mesh.geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(2);
    expect(geometry.parameters.height).toBe(3);
  });

  it('gives two sprites from one sheet independent textures', () => {
    const sheet = sheetTexture(64, 32);
    const left = atlasSprite(sheet, { x: 0, y: 0, w: 32, h: 32 });
    const right = atlasSprite(sheet, { x: 32, y: 0, w: 32, h: 32 });

    const leftMap = (left.material as THREE.MeshBasicMaterial).map;
    const rightMap = (right.material as THREE.MeshBasicMaterial).map;
    expect(leftMap).not.toBe(rightMap);
    expect(leftMap?.offset.x).toBeCloseTo(0);
    expect(rightMap?.offset.x).toBeCloseTo(0.5);
  });

  it('propagates the frame check', () => {
    expect(() => atlasSprite(sheetTexture(32, 32), { x: 0, y: 0, w: 64, h: 64 })).toThrow(
      /does not fit/,
    );
  });
});
