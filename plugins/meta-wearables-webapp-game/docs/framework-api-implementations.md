# Framework API — the concrete implementations

The Three.js / DOM / Web-Audio adapters that satisfy the
[contracts](framework-api-contracts.md), and the options each takes. `main.ts` constructs them
once and injects them; gameplay never imports them. Part of the
[framework API reference](framework-api.md). The two `KeyValueStore` adapters are short enough
to be documented inline with their contract, in
[`framework-api-contracts.md`](framework-api-contracts.md#keyvaluestore--persistence-contract).

## `ThreeRenderer<TModelId>`

`framework/render/ThreeRenderer.ts` — the Three.js `Renderer`. One of only three files that
import `three` (the others are `AssetLoader.ts` and the game's own `src/models.ts`).

```ts
new ThreeRenderer(canvas: HTMLCanvasElement, catalog: ModelCatalog<TModelId>, options?);
```

The game supplies a `ModelCatalog<TModelId>` — `Record<TModelId, ModelSpec>`, one `ModelSpec`
per model id — from `src/models.ts`. Add models there, not in the framework.

```ts
interface ModelSpec {
  build(color: number): THREE.Object3D;
  defaultColor: number;
  sheet?: THREE.Texture;          // the loaded spritesheet `frames` are cut from
  frames?: readonly AtlasFrame[]; // frame rects, in sheet pixels from the top-left
}
```

`sheet` + `frames` are what enable [`setFrame`](framework-api-contracts.md#renderertmodelid--rendering-contract) for that
model. The renderer cuts **one windowed texture per rect at construction** and `setFrame` only
reassigns `material.map`, so a frame swap allocates nothing and re-uploads nothing (the frames
share the sheet's GPU `Source` — see [`spritesheets.md`](spritesheets.md)). Which material to
reassign is resolved once per instance, in `addModel`, so a swap is a map lookup rather than a
walk of the instance's hierarchy. Those textures live for the renderer's lifetime and are not
freed by `remove()`; they hold no GPU memory of their own, but build one renderer per session
rather than rebuilding it per level. Declare the two fields together: `frames` without a `sheet`, an
empty `frames`, or a rect that doesn't fit the sheet throws at construction rather than
rendering wrong art.

**The renderer clones an instance's materials in `addModel`**, before the object reaches the
scene. That is what makes `setOpacity` / `setFrame` per-instance even for a spec that builds by
cloning one preloaded object — `Object3D.clone()` and `cloneModel` both share the source's
material, so without this a fade would apply to every instance at once. It also makes
`remove()`'s disposal safe: it frees a material that instance alone uses (see
[Disposal](asset-loading.md#disposal)).

| Option | Default | Applies to | Meaning |
|--------|---------|-----------|---------|
| `projection` | `'perspective'` | — | `'perspective'` (3D) or `'orthographic'` (flat 2D). |
| `cameraDistance` | `10` | both | Camera distance from the origin along +Z. |
| `fov` | `60` | perspective | Vertical field of view in degrees. |
| `viewSize` | `5` | orthographic | Half-height of the visible area in world units. |

The scene has a transparent (black) background and **no lights** — correct for the additive
display. See [asset-loading.md § 2D vs 3D camera](asset-loading.md#2d-vs-3d-camera) and
[§ Lighting & unlit materials](asset-loading.md#lighting--unlit-materials-3d-models).

## `PointerKeyboardInput`

`framework/input/PointerKeyboardInput.ts` — the `InputManager` over DOM Pointer + keyboard
events. **The only framework file that touches DOM input events.**

```ts
new PointerKeyboardInput(options?: {
  sensitivity?: number;    // multiplier on raw movementX/Y. Default 0.01
  tapMaxTravelPx?: number; // max raw px travel for a pinch to count as a tap. Default 6
  pointerDrag?: boolean;   // opt into the index pinch-and-move (drag) channel. Default false
});
```

| Method | Semantics |
|--------|-----------|
| `attach(target = window)` | Wire DOM listeners. Re-entrant (detaches first). Pointer (drag) listeners are wired **only when `pointerDrag: true`**. |
| `detach()` | Remove listeners and reset pinch state **silently** (no synthetic `pinchEnd`/`pinchTap`). |

Behavior that matters when choosing options:

- **Tap-only game (`pointerDrag: false`, the default — and the scaffold's):** the index select
  is the `Enter` keydown → `pinchTap`; no pointer listeners, no movement. Keep `<body>` without
  `touch-action: none`. A desktop mouse click does nothing in this mode, which is correct —
  press `Enter`.
- **Drag game (`pointerDrag: true`):** also set `touch-action: none` on `<body>` so the
  device delivers the pointer stream. The pointer stream is then the tap source (a zero-travel
  pinch → `pinchTap`; a moved pinch → drag), and the redundant `Enter` is ignored so the pinch
  never double-fires. Full recipe:
  [drag-channel.md](drag-channel.md).
- **Never enable `pointerDrag` to make a desktop mouse click select.** The flag changes what
  the *device* delivers and where the tap comes from; it is a gameplay decision, not a
  dev-ergonomics one. `npm run validate` fails a project that sets it without consuming the
  drag.
- A missed `pointerup` can't strand the pinch: `handlePointerMove` reconciles the pinch gate
  against `event.buttons`, closing it when the primary button is no longer held.

The handler methods accept minimal event-shaped objects (`KeyEventLike`,
`PointerButtonLike`, `PointerMoveLike`) so the mapping is unit-testable in plain `node` —
see [`testing.md`](testing.md).

## `AmpAudioPlayer<TSoundId>`

`framework/audio/AmpAudioPlayer.ts` — the `AudioPlayer` implementation. It owns events, banks and
concurrency and makes **no Web Audio calls**; it delegates nodes to `AudioEngine.ts` (the only
framework file that touches the Web Audio API) and bytes to `BankStore.ts`. The `AudioContext` is
created lazily and starts suspended (autoplay policy); `resume()` unlocks it.

```ts
new AmpAudioPlayer<SoundId>(settings: AudioSettings, options?: {
  masterVolume?: number;       // default 0.8
  sfxVolume?: number;          // default 1
  musicVolume?: number;        // default 1
  mutedByDefault?: boolean;    // default false
  maxVoices?: number;          // size of the channel-strip pool = hard voice ceiling. Default 16
  globalVoiceLimit?: number;   // runtime-tunable soft cap, clamped to maxVoices. Defaults to maxVoices
  maxResidentBytes?: number;   // decoded-PCM budget. Default 24 * 1024 * 1024
  panRange?: number;           // world half-width -> full L/R pan. Default 6
  refDistance?: number;        // no attenuation at/inside this distance. Default 1
  rolloffFactor?: number;      // how sharply gain falls off past refDistance. Default 1
  maxDistance?: number;        // silent at/beyond this distance. Default 20
});
```

`settings` is the parsed `src/audio/audioSettings.json` — import it from `src/audio/soundIds.ts`,
which holds the one cast where JSON meets TypeScript along with the `SoundId` union.

Beyond the `AudioPlayer` contract it adds three members used only by `main.ts` and tests:

| Member | Semantics |
|--------|-----------|
| `storeClip(key, blob, options?)` | Register a clip's compressed bytes. Called by `preloadManifest` per `{ type: 'audio' }` entry that declares a `bank` or `stream`. `options` is `{ pcmBytes?, streamed? }`; nothing is decoded here. |
| `decode(bytes: ArrayBuffer)` | Decode compressed audio into an `AudioBuffer` on this player's context (so sample rates match). Used for bank-less `{ type: 'audio' }` entries. Works while suspended. |
| `setRandom(random: () => number)` | Replace the RNG behind clip selection and `chanceToPlay`, for deterministic tests. |

It also exposes `bankIds`, `soundIds`, `describeEvent(name)`, `voiceGroupIds` and
`describeVoiceGroup(id)` for dev overlays and a future JSON editor.

`muteRequested(search: string): boolean` (exported from `AudioEngine.ts`) parses the `?mute` flag —
same convention as `?stats` / `?strict`. See [query-parameters.md](query-parameters.md).
