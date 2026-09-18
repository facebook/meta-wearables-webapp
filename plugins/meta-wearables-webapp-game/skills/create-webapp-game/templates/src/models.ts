/**
 * The game's model registry: the id union and the Three.js geometry for each model. This is one
 * of only three files that import `three` (the others are the framework's `ThreeRenderer` and
 * `AssetLoader`) — model geometry is inherently renderer-specific. Gameplay never imports
 * `three`; it refers to models by their `ModelId` and calls `renderer.addModel(id)`.
 *
 * Add a model: extend `ModelId` and add a matching entry to `MODELS`. That's the only edit —
 * the renderer builds whatever the catalog describes. Models can be procedural geometry (like
 * the wireframe cube below) or built from a loaded texture / 3D file — see `docs/asset-loading.md`
 * for the preload-then-clone pattern using `framework/render/AssetLoader.ts`.
 *
 * A spritesheet-backed model also declares `sheet` + `frames` (pixel rects) on its spec; that is
 * what `renderer.setFrame(handle, i)` swaps between. See `docs/spritesheets.md`.
 */

import * as THREE from 'three';

import { COLORS } from '@/config/gameplayConstants';
import type { ModelCatalog, ModelSpec } from '@/framework/render/ThreeRenderer';

/** Identifies an in-code model. Add your own ids as the game grows. */
export type ModelId = 'player';

/** A wireframe cube: bright edges, no fill — ideal for the additive display. */
const player: ModelSpec = {
  defaultColor: COLORS.player,
  build(color: number): THREE.Object3D {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    // The box is only a source for the edges; free it now so it doesn't leak.
    box.dispose();
    const material = new THREE.LineBasicMaterial({ color });
    return new THREE.LineSegments(edges, material);
  },
};

export const MODELS: ModelCatalog<ModelId> = {
  player,
};
