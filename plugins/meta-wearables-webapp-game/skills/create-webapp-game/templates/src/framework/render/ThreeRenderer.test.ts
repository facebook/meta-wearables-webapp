/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Vector3 } from '@/framework/math/Vector3';
import { ThreeRenderer } from '@/framework/render/ThreeRenderer';
import type { ModelCatalog } from '@/framework/render/ThreeRenderer';

/**
 * `ThreeRenderer` is the only framework class that needs a GPU, and only for the one object it
 * constructs: `THREE.WebGLRenderer` asks the canvas for a WebGL context, which node has no way to
 * supply. Everything the per-instance channels touch — the scene graph, materials, textures — is
 * plain JavaScript, so stubbing that single class runs the real renderer headless.
 */
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class StubWebGLRenderer {
    public readonly info = {
      render: { calls: 0, triangles: 0, points: 0, lines: 0 },
      memory: { geometries: 0, textures: 0 },
    };
    public setClearColor(): void {}
    public setSize(): void {}
    public render(): void {}
  }
  return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

const CANVAS = {} as HTMLCanvasElement;

/** A stand-in for a loaded sheet: `THREE.Texture` reads its size straight off `image`. */
function sheetTexture(width: number, height: number): THREE.Texture {
  return new THREE.Texture({ width, height } as unknown as HTMLImageElement);
}

type ModelId = 'sprite' | 'cube';

/**
 * The catalog under test, plus the objects it built. `sprite` reproduces the preload-then-clone
 * pattern from `docs/asset-loading.md`: one source mesh, `clone()`d per instance, so every
 * instance would share ONE material unless the renderer intervenes. `cube` is procedural and
 * declares no frames.
 */
function makeCatalog(): {
  catalog: ModelCatalog<ModelId>;
  sheet: THREE.Texture;
  source: THREE.Mesh;
  built: THREE.Object3D[];
} {
  const sheet = sheetTexture(64, 32);
  const source = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: sheet, transparent: true }),
  );
  const built: THREE.Object3D[] = [];

  const catalog: ModelCatalog<ModelId> = {
    sprite: {
      defaultColor: 0xffffff,
      sheet,
      frames: [
        { x: 0, y: 0, w: 32, h: 32 },
        { x: 32, y: 0, w: 32, h: 32 },
      ],
      build(): THREE.Object3D {
        const object = source.clone();
        built.push(object);
        return object;
      },
    },
    cube: {
      defaultColor: 0x00ff00,
      build(color: number): THREE.Object3D {
        const object = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
          new THREE.LineBasicMaterial({ color }),
        );
        built.push(object);
        return object;
      },
    },
  };
  return { catalog, sheet, source, built };
}

/** The single material of a mesh built by the catalog above. */
function materialOf(object: THREE.Object3D): THREE.MeshBasicMaterial {
  return (object as THREE.Mesh).material as THREE.MeshBasicMaterial;
}

describe('ThreeRenderer per-instance materials', () => {
  it('gives each instance its own material even when the spec clones one source', () => {
    const { catalog, source, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);

    renderer.addModel('sprite');
    renderer.addModel('sprite');

    expect(materialOf(built[0])).not.toBe(materialOf(built[1]));
    expect(materialOf(built[0])).not.toBe(materialOf(source));
    // The clones still share the source's texture, so per-instance materials cost no GPU memory.
    expect(materialOf(built[0]).map).toBe(materialOf(source).map);
  });

  it('disposes only the removed instance material, leaving the shared source usable', () => {
    const { catalog, source, built } = makeCatalog();
    const sourceDispose = vi.spyOn(materialOf(source), 'dispose');
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);

    const first = renderer.addModel('sprite');
    renderer.addModel('sprite');
    const instanceDispose = vi.spyOn(materialOf(built[0]), 'dispose');
    renderer.remove(first);

    expect(instanceDispose).toHaveBeenCalled();
    expect(sourceDispose).not.toHaveBeenCalled();
  });
});

describe('ThreeRenderer.setScale', () => {
  let catalog: ModelCatalog<ModelId>;
  let built: THREE.Object3D[];
  let renderer: ThreeRenderer<ModelId>;

  beforeEach(() => {
    ({ catalog, built } = makeCatalog());
    renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
  });

  it('applies a single factor to every axis', () => {
    const handle = renderer.addModel('cube');

    renderer.setScale(handle, 2.5);

    expect(built[0].scale.toArray()).toEqual([2.5, 2.5, 2.5]);
  });

  it('applies a Vector3 per axis, for squash and stretch', () => {
    const handle = renderer.addModel('cube');

    renderer.setScale(handle, new Vector3(1.4, 0.6, 1));

    expect(built[0].scale.toArray()).toEqual([1.4, 0.6, 1]);
  });

  it('scales one instance without touching another', () => {
    const first = renderer.addModel('cube');
    renderer.addModel('cube');

    renderer.setScale(first, 3);

    expect(built[0].scale.toArray()).toEqual([3, 3, 3]);
    expect(built[1].scale.toArray()).toEqual([1, 1, 1]);
  });

  it('ignores a handle that is no longer live', () => {
    const handle = renderer.addModel('cube');
    renderer.remove(handle);

    expect(() => renderer.setScale(handle, 2)).not.toThrow();
  });

  it('rejects a non-finite factor, which would vanish the instance silently', () => {
    const handle = renderer.addModel('cube');

    expect(() => renderer.setScale(handle, NaN)).toThrow(/finite/);
    expect(() => renderer.setScale(handle, Infinity)).toThrow(/finite/);
    expect(() => renderer.setScale(handle, new Vector3(1, NaN, 1))).toThrow(/finite/);
    expect(built[0].scale.toArray()).toEqual([1, 1, 1]);
  });
});

describe('ThreeRenderer.setOpacity', () => {
  it('fades one instance without fading its siblings', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const first = renderer.addModel('sprite');
    renderer.addModel('sprite');

    renderer.setOpacity(first, 0.25);

    expect(materialOf(built[0]).opacity).toBe(0.25);
    expect(materialOf(built[1]).opacity).toBe(1);
  });

  it('turns on transparency and forces a program rebuild when a material becomes see-through', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('cube');
    const material = materialOf(built[0]);
    const versionBefore = material.version;

    renderer.setOpacity(handle, 0.5);

    expect(material.transparent).toBe(true);
    expect(material.version).toBeGreaterThan(versionBefore);
  });

  it('never clears transparency, so a sprite keeps its alpha cutout at full opacity', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');
    const material = materialOf(built[0]);
    const versionBefore = material.version;

    renderer.setOpacity(handle, 1);

    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(1);
    // Already transparent, so nothing about the shader changed — no needless recompile.
    expect(material.version).toBe(versionBefore);
  });

  it.each([
    [1.0001, 1],
    [-0.2, 0],
  ])('clamps %p to %p rather than handing Three an out-of-range alpha', (given, expected) => {
    // A fade accumulating dt overshoots the ends by a fraction of a frame routinely; throwing for
    // that would crash a game over a rounding error.
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');

    renderer.setOpacity(handle, given);

    expect(materialOf(built[0]).opacity).toBe(expected);
  });

  it.each([[NaN], [Infinity]])('throws on a %p opacity instead of vanishing the instance', (bad) => {
    const { catalog } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');

    expect(() => renderer.setOpacity(handle, bad)).toThrow(/finite number/);
  });

  it('fades every material in a multi-material hierarchy', () => {
    const parent = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    const child = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    parent.add(child);
    const renderer = new ThreeRenderer<'rig'>(CANVAS, {
      rig: { defaultColor: 0xffffff, build: () => parent },
    });

    const handle = renderer.addModel('rig');
    renderer.setOpacity(handle, 0.4);

    expect(materialOf(parent).opacity).toBe(0.4);
    expect(materialOf(child).opacity).toBe(0.4);
  });

  it('does not walk the instance hierarchy on a fade', () => {
    // Same budget argument as the frame swap below: a fade is pushed from `update(dt)` every
    // frame for every fading instance, so resolving the materials per call would traverse and
    // allocate on each of them, on a 128 MB device with no headroom for GC.
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');
    const traverse = vi.spyOn(built[0], 'traverse');

    renderer.setOpacity(handle, 0.5);
    renderer.setOpacity(handle, 0.25);

    expect(traverse).not.toHaveBeenCalled();
  });

  it('ignores a handle that is no longer live', () => {
    const { catalog } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');
    renderer.remove(handle);

    expect(() => renderer.setOpacity(handle, 0.5)).not.toThrow();
  });
});

describe('ThreeRenderer.setFrame', () => {
  it('windows the instance material onto the requested frame', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');

    renderer.setFrame(handle, 1);

    const map = materialOf(built[0]).map;
    expect(map?.offset.x).toBeCloseTo(0.5);
    expect(map?.repeat.toArray()).toEqual([0.5, 1]);
  });

  it('shows different frames on two instances of one model', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const first = renderer.addModel('sprite');
    const second = renderer.addModel('sprite');

    renderer.setFrame(first, 0);
    renderer.setFrame(second, 1);

    expect(materialOf(built[0]).map?.offset.x).toBeCloseTo(0);
    expect(materialOf(built[1]).map?.offset.x).toBeCloseTo(0.5);
  });

  it('reuses one texture per frame instead of cutting a new one per call', () => {
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const first = renderer.addModel('sprite');
    const second = renderer.addModel('sprite');

    renderer.setFrame(first, 1);
    const afterFirstCall = materialOf(built[0]).map;
    renderer.setFrame(first, 0);
    renderer.setFrame(first, 1);
    renderer.setFrame(second, 1);

    expect(materialOf(built[0]).map).toBe(afterFirstCall);
    expect(materialOf(built[1]).map).toBe(afterFirstCall);
  });

  it('throws for a model that declares no frames', () => {
    const { catalog } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('cube');

    expect(() => renderer.setFrame(handle, 0)).toThrow(/model "cube" declares no frames/);
  });

  it('throws for an index outside the declared frames', () => {
    const { catalog } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');

    expect(() => renderer.setFrame(handle, 2)).toThrow(/outside model "sprite"'s 2 declared/);
  });

  // 1.5 is inside the range, so reporting it as out of range would send the reader hunting a
  // frame-count bug. All three land on `undefined` from the array lookup, hence the split.
  it.each([[-1], [1.5], [NaN]])(
    'separates the malformed index %p from an out-of-range one',
    (bad) => {
      const { catalog } = makeCatalog();
      const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
      const handle = renderer.addModel('sprite');

      expect(() => renderer.setFrame(handle, bad)).toThrow(/non-negative integer/);
    },
  );

  it('throws at spawn when the model declares frames but builds nothing that can show one', () => {
    const sheet = sheetTexture(32, 32);
    const renderer = new ThreeRenderer<'ghost'>(CANVAS, {
      ghost: {
        defaultColor: 0xffffff,
        sheet,
        frames: [{ x: 0, y: 0, w: 32, h: 32 }],
        build: () => new THREE.Group(),
      },
    });
    // At addModel, not at the first swap: whether a model builds one textured material is a
    // property of the model, so a game finds out when it spawns the thing.
    expect(() => renderer.addModel('ghost')).toThrow(/material with a texture map/);
  });

  it('rejects at spawn a frame-declaring model that builds more than one textured material', () => {
    const sheet = sheetTexture(32, 32);
    const renderer = new ThreeRenderer<'pair'>(CANVAS, {
      pair: {
        defaultColor: 0xffffff,
        sheet,
        frames: [{ x: 0, y: 0, w: 32, h: 32 }],
        build: () => {
          const texturedQuad = (): THREE.Mesh =>
            new THREE.Mesh(
              new THREE.PlaneGeometry(1, 1),
              new THREE.MeshBasicMaterial({ map: sheetTexture(32, 32) }),
            );
          const group = new THREE.Group();
          group.add(texturedQuad(), texturedQuad());
          return group;
        },
      },
    });
    expect(() => renderer.addModel('pair')).toThrow(/builds 2 materials with a texture map/);
  });

  it('does not count an untextured sibling as a second textured material', () => {
    // Every standard Three material declares `map` and initialises it to `null`, so a presence
    // test counts a solid-colour shadow quad and rejects a legal model — with a message saying it
    // builds two textured materials, which is false for it.
    const sheet = sheetTexture(32, 32);
    const renderer = new ThreeRenderer<'hero'>(CANVAS, {
      hero: {
        defaultColor: 0xffffff,
        sheet,
        frames: [{ x: 0, y: 0, w: 32, h: 32 }],
        build: () => {
          const group = new THREE.Group();
          group.add(
            new THREE.Mesh(
              new THREE.PlaneGeometry(1, 1),
              new THREE.MeshBasicMaterial({ map: sheetTexture(32, 32) }),
            ),
            // The shadow: same material class, no texture.
            new THREE.Mesh(
              new THREE.PlaneGeometry(1, 0.2),
              new THREE.MeshBasicMaterial({ color: 0x222222 }),
            ),
          );
          return group;
        },
      },
    });
    expect(() => renderer.addModel('hero')).not.toThrow();
  });

  it('rejects a frame-declaring model whose only material carries no texture', () => {
    // The converse: `'map' in material` passed this, so a model that can show nothing spawned
    // fine and failed later, in-page, on the first swap.
    const sheet = sheetTexture(32, 32);
    const renderer = new ThreeRenderer<'flat'>(CANVAS, {
      flat: {
        defaultColor: 0xffffff,
        sheet,
        frames: [{ x: 0, y: 0, w: 32, h: 32 }],
        build: () =>
          new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
          ),
      },
    });
    expect(() => renderer.addModel('flat')).toThrow(/material with a texture map/);
  });

  it('registers nothing when the frame target cannot be resolved', () => {
    // The throw lands mid-`addModel`. Entries written before it would be reachable by neither the
    // caller (who never receives the handle) nor `remove()`, and the next handle would silently
    // carry the failed spawn's model. Observable as handle parity plus which model the next
    // instance is treated as.
    const catalogFor = (): ModelCatalog<'ghost' | 'ok'> => ({
      ghost: {
        defaultColor: 0xffffff,
        sheet: sheetTexture(32, 32),
        frames: [{ x: 0, y: 0, w: 32, h: 32 }],
        build: () => new THREE.Group(),
      },
      ok: { defaultColor: 0xffffff, build: () => new THREE.Group() },
    });

    const clean = new ThreeRenderer<'ghost' | 'ok'>(CANVAS, catalogFor());
    const expected = clean.addModel('ok');

    const afterFailure = new ThreeRenderer<'ghost' | 'ok'>(CANVAS, catalogFor());
    expect(() => afterFailure.addModel('ghost')).toThrow();
    const handle = afterFailure.addModel('ok');

    // The failed spawn consumed no handle, ...
    expect(handle).toBe(expected);
    // ... and left nothing behind that would make this instance look like the ghost.
    expect(() => afterFailure.setFrame(handle, 0)).toThrow(/declares no frames/);
  });

  it('ignores a handle that is no longer live', () => {
    const { catalog } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');
    renderer.remove(handle);

    expect(() => renderer.setFrame(handle, 0)).not.toThrow();
  });

  it('does not walk the instance hierarchy on a swap', () => {
    // The contract promises a swap allocates nothing. Resolving the target material per call
    // would traverse and allocate once per animating sprite per frame, on a 128 MB device.
    const { catalog, built } = makeCatalog();
    const renderer = new ThreeRenderer<ModelId>(CANVAS, catalog);
    const handle = renderer.addModel('sprite');
    const traverse = vi.spyOn(built[0], 'traverse');

    renderer.setFrame(handle, 1);
    renderer.setFrame(handle, 0);

    expect(traverse).not.toHaveBeenCalled();
  });
});

describe('ThreeRenderer frame declarations', () => {
  it('rejects frames declared without a sheet', () => {
    expect(
      () =>
        new ThreeRenderer<'bad'>(CANVAS, {
          bad: {
            defaultColor: 0xffffff,
            frames: [{ x: 0, y: 0, w: 8, h: 8 }],
            build: () => new THREE.Group(),
          },
        }),
    ).toThrow(/declares "frames" but no "sheet"/);
  });

  it('rejects a sheet declared without frames', () => {
    expect(
      () =>
        new ThreeRenderer<'bad'>(CANVAS, {
          bad: {
            defaultColor: 0xffffff,
            sheet: sheetTexture(8, 8),
            build: () => new THREE.Group(),
          },
        }),
    ).toThrow(/declares a "sheet" but no "frames"/);
  });

  it('rejects an empty frame list', () => {
    expect(
      () =>
        new ThreeRenderer<'bad'>(CANVAS, {
          bad: {
            defaultColor: 0xffffff,
            sheet: sheetTexture(8, 8),
            frames: [],
            build: () => new THREE.Group(),
          },
        }),
    ).toThrow(/empty "frames" array/);
  });

  it('propagates the frame-rect check from atlasFrameTexture', () => {
    expect(
      () =>
        new ThreeRenderer<'bad'>(CANVAS, {
          bad: {
            defaultColor: 0xffffff,
            sheet: sheetTexture(8, 8),
            frames: [{ x: 0, y: 0, w: 16, h: 16 }],
            build: () => new THREE.Group(),
          },
        }),
    ).toThrow(/does not fit inside the 8x8 sheet/);
  });
});
