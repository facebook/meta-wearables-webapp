# Framework API — the contracts gameplay imports

The ports gameplay code depends on — `Renderer`, `InputManager`, `AudioPlayer` and
`KeyValueStore` — plus the framework-free value types (`Vector3`, `clamp`). Part of the
[framework API reference](framework-api.md); the Three.js / DOM / Web-Audio adapters that
satisfy these ports are in
[`framework-api-implementations.md`](framework-api-implementations.md).

## `Renderer<TModelId>` — rendering contract

`framework/render/Renderer.ts`. Generic over the game's model-id union (`TModelId`), so the
framework stays agnostic to which models exist. Positions are the framework
[`Vector3`](#vector3--clamp); colors are `0xRRGGBB` numbers; instances are opaque handles.

| Method | Signature | Semantics |
|--------|-----------|-----------|
| `addModel` | `(modelId: TModelId, color?: number) => RenderHandle` | Instantiate a model from the catalog, add it to the scene, return its handle. Omitting `color` uses the model's `defaultColor`. |
| `setTransform` | `(handle: RenderHandle, position: Vector3) => void` | Move an instance. Position only — `setRotation` spins it and `setScale` resizes it. |
| `setRotation` | `(handle: RenderHandle, radians: number) => void` | Rotate an instance about the view axis (Z), angle in radians. Framework extension for 2D games that need spin (rolling ball, swinging flippers, spinning pickups). |
| `setScale?` | `(handle: RenderHandle, scale: number \| Vector3) => void` | **Optional.** Resize an instance: one factor for all three axes (a pickup pulsing, a hazard growing as it arms, a hit popping), or a `Vector3` for squash and stretch, the one case a single factor can't express. Composes with position and rotation. **Throws** on a non-finite factor, which would otherwise vanish the instance with no error anywhere. |
| `setOpacity?` | `(handle: RenderHandle, opacity: number) => void` | **Optional.** Fade an instance — `1` opaque, `0` invisible — across every material it carries, so a multi-material 3D model fades as one object. For fade in/out, damage flashes, and ghosting a preview; `setVisible` is cheaper for hiding outright. A value outside `0..1` is **clamped** (a dt-driven fade overshoots the ends routinely); a non-finite one **throws**. |
| `setFrame?` | `(handle: RenderHandle, frame: number) => void` | **Optional.** Show frame `frame` of the instance's model — the 2D sprite-animation channel. Frames are declared per model on its [`ModelSpec`](framework-api-implementations.md#threerenderertmodelid) (`sheet` + `frames`) and indexed from 0 in declaration order. **Throws** on a model that declares no frames, an index that is not a non-negative integer, or an integer index outside its list. A frame-declaring model must build exactly one material with a texture map — zero or several is ambiguous, and `ThreeRenderer` throws for it from `addModel`, when the instance is created rather than on the first swap. |
| `setVisible` | `(handle: RenderHandle, visible: boolean) => void` | Show / hide an instance without removing it. |
| `remove` | `(handle: RenderHandle) => void` | Destroy an instance. The Three.js impl also **disposes its GPU geometry + material** (see [Disposal in asset-loading.md](asset-loading.md#disposal)). |
| `resize` | `(width: number, height: number) => void` | Resize the drawing surface and fix the camera aspect. |
| `render` | `() => void` | Draw one frame. The camera is owned by the renderer. |
| `getStats?` | `() => RenderStats` | **Optional.** Backend-agnostic GPU counters for the [`?stats` overlay](framework-api-debug.md#performance-overlay-stats). Absent on backends (or test fakes) that can't report them. Call after `render()`. |

`setScale` / `setOpacity` / `setFrame` are **per-instance channels, not an animation system**.
There is no tween, easing curve, frame duration or loop mode anywhere in the contract: a game
computes the value in its own `update(dt)` and pushes it each frame. That is the whole feature —
it exists so a 2D game stops hand-rolling stacked quads toggled with `setVisible`, or one model
id per animation frame.

They are optional on the interface (like `getStats`) so that a backend can decline a channel and
so that re-syncing the framework never turns into a compile error in a game that wrote its own
`Renderer`. Both shipped implementations provide all three, so call them as
`renderer.setScale?.(handle, 1.2)` and they never silently no-op.

**Every channel is isolated per instance**, including between two instances of the same model —
that is a contract guarantee, not a Three.js detail. See
[`ThreeRenderer`](framework-api-implementations.md#threerenderertmodelid) for how it holds when models share GPU resources.

`RenderStats` is a framework-free struct (plain numbers, no `three` types):
`{ drawCalls, triangles, points, lines, geometries, textures }`. The first four are
**per-frame** counters for the last-drawn frame (Three.js resets them each `render()`, so read
them *after* rendering); `geometries` / `textures` are **live gauges** (total resources held).

`RenderHandle` is a **branded** `number` (`number & { readonly __brand: 'RenderHandle' }`) —
distinct from a plain number so you can't accidentally pass the wrong value.

## `InputManager` — input contract

`framework/input/InputManager.ts`. The gameplay-facing input surface; no DOM types appear
here, so the same game runs on desktop (mouse + keyboard) and on the glasses (EMG + D-pad).
The gesture families behind these events are explained in
[game-architecture.md § The input model](game-architecture.md#the-input-model-read-this-before-changing-input).

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `on` | `(event, handler) => void` | Subscribe to a discrete event. |
| `off` | `(event, handler) => void` | Unsubscribe a previously registered handler. |
| `isPinchActive` | `() => boolean` | Whether an index pinch-and-move drag is currently held (always `false` if drag isn't opted in). |
| `consumeMovementDelta` | `() => MovementDelta` | **Poll-and-clear**: returns the movement accumulated since the last call and resets the accumulator. Returns `{x:0, y:0}` when no drag is active. Call it once per frame from `update()`. |

Discrete events (`InputEventMap`) — payloads are `void` except `dpadSwipe`:

| Event | Payload | Fires when |
|-------|---------|------------|
| `pinchTap` | — | An index pad-pinch SELECT (a quick pinch / `Enter` / a zero-travel click). |
| `pinchBegin` | — | An index pinch-and-move drag started (drag opt-in only). |
| `pinchEnd` | — | That drag ended (drag opt-in only). |
| `dpadSwipe` | `DpadDirection` | A single D-pad swipe. `DpadDirection = 'up' \| 'down' \| 'left' \| 'right'`. |

`MovementDelta` is a plain `{ x: number; y: number }`. Because it is an **accumulated
per-frame displacement**, apply it directly — do **not** multiply by `dt` (see the dt note
under [Game loop](framework-api-runtime.md#gameloop--the-game-loop) and the starter `Game.ts`).

`TypedEventEmitter<EventMap>` is a reusable typed `on`/`off`/`emit` emitter used by input
implementations; `emit` copies the handler set before dispatch, so a handler that
unsubscribes mid-dispatch is safe. Reuse it if you build your own event source.

## `AudioPlayer<TSoundId>` — audio contract

`framework/audio/AudioPlayer.ts`. The gameplay-facing sound surface; no Web Audio types appear here
except the `createVoice` / `getContext` escape hatch. Generic over the game's sound-id union
(`TSoundId`), like `Renderer<TModelId>`.

What a sound *is* is declared in `src/audio/audioSettings.json`, not through this interface: named
**events**, each owning one or more **clips** (a sample filename, or an inline synth stack) plus its
tuning. The full guide is [`audio.md`](audio.md); the memory model behind `loadBank` is
[`audio-banks.md`](audio-banks.md).

### Lifecycle

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `init` | `(options?: AudioInitOptions) => Promise<void>` | Parse the settings, then decode the default bank plus every `persistent` bank and any `initialBanks`. Resolves once they are resident. Idempotent. Everything below is a cheap no-op before it, and when Web Audio is unavailable. |
| `resume` | `() => void` | Unlock/resume the context after a user gesture (browsers start it suspended). Call from the first input event. |
| `suspend` | `() => void` | Suspend to save battery (e.g. when backgrounded). |
| `destroy` | `() => Promise<void>` | Stop everything, free all decoded PCM, close the backend. |

`AudioInitOptions`: `{ globalVoiceLimit?: number; defaultCooldown?: number; soundsBasePath?: string;
initialBanks?: string[] }` — each overrides the JSON's `global` block.

### Declaring sounds

`audioSettings.json` is the source of truth; these are escape hatches for sounds a designer cannot
author ahead of time.

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `registerEvents` | `(events: readonly AudioEventConfig[]) => void` | Merge extra events at runtime, resolved exactly as JSON-declared ones are. An existing name is replaced. |
| `registerSoundDefinitions` | `(defs: Partial<Record<TSoundId, SoundDefinition>>) => void` | Sugar: register each definition as a single-clip event with default tuning. Build them with the `soundDefinitions.ts` helpers. |
| `registerSounds` | `(buffers: Partial<Record<TSoundId, AudioBuffer>>) => void` | Sugar over the above for an `AudioBuffer` the game decoded itself. |

### Playing

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `play` | `(sound: TSoundId, options?: PlayOptions) => SoundHandle \| null` | Fire an event. `null` when skipped — unknown event, `cooldown`, a `chanceToPlay` roll, muted, bank not loaded, or a `preventNew` group at its limit. Never throws. |
| `stop` | `(handle: SoundHandle) => void` | Stop one voice and release its nodes. Safe on a finished handle. |
| `stopSound` | `(sound: TSoundId, fadeMs?: number) => void` | Stop every instance of an event, honouring its `fadeOutDuration` unless overridden. Events sharing a voice group are unaffected. |
| `stopAll` | `(fadeMs?: number) => void` | Stop every active voice. |
| `setVolume` | `(handle: SoundHandle, volume: number) => void` | Set a live voice's linear gain (`0..1`); ramps briefly so ducking a running voice doesn't click. |
| `setPosition` | `(handle: SoundHandle, position: Vector3) => void` | Update a live spatial voice's world position. No-op on a non-spatial voice. |
| `setListener` | `(position: Vector3) => void` | Set the listener reference point; recomputes all active spatial voices. |

### Mix

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `setBusVolume` | `(bus: 'sfx' \| 'music' \| 'master', volume: number) => void` | Set a bus's (or master's) linear volume. |
| `setMuted` / `toggleMute` / `isMuted` | `(muted: boolean) => void` / `() => boolean` / `() => boolean` | Master mute (ramped). Muting also fades out what is already sounding. |

### Banks and memory

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `loadBank` / `loadBanks` | `(bankId: string) => Promise<void>` / `(bankIds: readonly string[]) => Promise<void>` | Decode the bank's sample clips. Idempotent, and never fetches — the bytes came from the preload manifest. Refused with a warning if it would exceed `maxResidentBytes`. |
| `unloadBank` | `(bankId: string) => void` | Free the bank's decoded PCM, keeping clips another loaded bank references. The `default` bank cannot be unloaded. |
| `swapBanks` | `(keep: readonly string[], load: readonly string[], mode?: 'sequential' \| 'overlapped') => Promise<void>` | Level transition. `'sequential'` (default) peaks at `max(out, in)`; `'overlapped'` hides the gap but peaks at `out + in`, and **falls back to sequential with a warning** when that would exceed the budget. |
| `loadedBanks` | `string[]` | Banks whose clips are currently decoded. |
| `estimateBankBytes` | `(bankId: string) => number` | Approximate decoded bytes the bank would cost, from `pcmBytes` hints and measured sizes. |
| `residentBytes` / `maxResidentBytes` | `number` / `number` | Decoded PCM in use, and the budget (`AUDIO.maxResidentBytes`, default 24 MB). Shown by the `?stats` overlay. |

### Concurrency, introspection, dev

| Member | Signature | Semantics |
|--------|-----------|-----------|
| `isPlaying` / `activeVoices` | `(sound: TSoundId) => boolean` / `=> number` | Whether, and how many instances of, an event are sounding. Fading tails do not count. |
| `voiceGroupCount` | `(groupId: string) => number` | Live voices in a shared voice group. |
| `activeVoiceCount` | `number` | Total live voices, fading tails included. |
| `globalVoiceLimit` | `number` (settable) | The polyphony cap. Lower it at runtime to profile a device; clamped to `AUDIO.maxVoices`. |
| `validate` | `() => string[]` | Every config problem as a readable string (see [audio.md § Config health](audio.md#config-health)). `[]` when clean. |
| `createVoice` | `(options?: PlayOptions) => CustomVoice \| null` | **Custom-graph escape hatch.** Returns a pooled, routed input node (bus + master, spatialized when `position` is set) plus a handle; connect your own source(s) and `stop(handle)` yourself. You own cleanup — `disconnect()` your node(s) and `stop(handle)` when your source ends, or the voice leaks its nodes and holds a slot against the cap. See [audio.md § Custom voices](audio.md#custom-voices). |
| `getContext` | `() => AudioContext \| null` | The live `AudioContext`, for a custom graph. `null` on a fake, and until the first `play` / `createVoice` / `resume` creates it. |

`PlayOptions`: `{ bus?: 'sfx' \| 'music'; volume?: number; rate?: number; detune?: number; loop?:
boolean; position?: Vector3; ignoreCooldown?: boolean }` — an unset field falls back to the event's
own tuning, `detune` defaults to `0`, and a `position` spatializes the voice (stereo-pan +
distance). `SoundHandle` is a **branded** `number` (like `RenderHandle`). `CustomVoice` is
`{ input: AudioNode; handle: SoundHandle }`. Synth layers for `registerSoundDefinitions` come from
the `soundDefinitions.ts` helpers: `synth({ gain, layers })`, `sample(buffer, opts?)`, `tone(...)` /
`note(...)` for layers, and `roundRobin(...)` / `randomOf(...)` / `variants(...)`.

## `Vector3` & `clamp`

`framework/math/Vector3.ts` — framework-free value types so gameplay never imports `three`.

- `class Vector3` — `new Vector3(x = 0, y = 0, z = 0)`; `set(x, y, z): this`; `clone(): Vector3`.
  Public mutable `x` / `y` / `z`. The Three.js renderer converts these into its own vectors
  internally; this is the boundary type used across the render contract.
- `clamp(value, min, max): number` — clamp to the inclusive range (used by the starter
  `Game.ts` to keep the player in bounds).

## `KeyValueStore` — persistence contract

`framework/storage/KeyValueStore.ts`. The port for anything that must survive a session — a
best score, settings, unlocks. Gameplay takes the interface; `main.ts` injects the browser
implementation; tests inject the memory one. Gameplay must not call `localStorage` itself —
it is a DOM global, so `npm run validate`'s layer-boundary check rejects it outside the
DOM adapters (see [game-architecture.md § Persisting state across sessions](game-architecture.md#persisting-state-across-sessions)).

```ts
interface KeyValueStore {
  get(key: string): string | null;   // null when never set
  set(key: string, value: string): void;
  remove(key: string): void;
}
```

Values are strings, like the Web Storage API underneath: persist a number with `String(n)` and
read it back with `Number(...)`, an object with `JSON.stringify` / `JSON.parse`.

- `class BrowserKeyValueStore implements KeyValueStore` —
  `new BrowserKeyValueStore({ namespace, storage? })`. `namespace` prefixes every key
  (`"<namespace>:<key>"`) so two games served from one origin don't collide — they routinely
  are, since every game runs on `http://localhost:5173` under `npm run dev`. `storage`
  overrides the backing `Storage` (tests); it defaults to `globalThis.localStorage`.
  Also exposes `isPersistent(): boolean`.
- `class MemoryKeyValueStore implements KeyValueStore` — the test fake, and the fallback the
  browser store degrades to.

**It never throws.** Web Storage fails in ways a game has to survive: reading
`window.localStorage` throws a `SecurityError` when storage is blocked for the origin, and
`setItem` throws `QuotaExceededError` when the quota is full — which is also how Safari's
private mode reports its zero-size quota. So the constructor probes with a real write/remove
round-trip and falls back to a session-lifetime memory store when that fails, and every
operation is guarded on top in case storage breaks later. The game keeps working; it just
forgets. `isPersistent()` reports which mode it ended up in, if the game wants to tell the
player.
