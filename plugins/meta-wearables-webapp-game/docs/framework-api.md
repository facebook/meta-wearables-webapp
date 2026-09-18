# Framework API reference — the core contracts

The callable surface of the managed engine code under `src/framework/`. This is the *what*
(signatures and semantics); for the *why* (the renderer/input-agnostic layering and the EMG
gesture model) read [`game-architecture.md`](game-architecture.md) first, and for how the
render/DOM split works see [`threejs-vs-dom.md`](threejs-vs-dom.md).

Gameplay code imports only the **contracts** — `Renderer`, `InputManager`, `AudioPlayer`, and
`KeyValueStore` if the game persists anything — plus the value types (`Vector3`); the concrete
Three.js / DOM / Web-Audio / Web-Storage **implementations** (`ThreeRenderer`,
`PointerKeyboardInput`, `AmpAudioPlayer`, `BrowserKeyValueStore`) are constructed once in
[`main.ts`](framework-api-runtime.md#composition-root-maints) and injected. Nothing under
`src/framework/` imports game code — tunables arrive as constructor options, never via `import`.

## Where each symbol is documented

This page is the map; open the one part you need rather than the whole reference.

| Document | Covers |
|----------|--------|
| [`framework-api-contracts.md`](framework-api-contracts.md) — **what gameplay imports** | `Renderer<TModelId>`, `RenderHandle`, `RenderStats`; `InputManager`, `InputEventMap`, `MovementDelta`, `TypedEventEmitter`; `AudioPlayer<TSoundId>`, `PlayOptions`, `SoundHandle`; `Vector3`, `clamp`; `KeyValueStore` and its two shipped stores |
| [`framework-api-implementations.md`](framework-api-implementations.md) — **what `main.ts` constructs** | `ThreeRenderer<TModelId>` (and the game's `ModelCatalog` / `ModelSpec`), `PointerKeyboardInput`, `AmpAudioPlayer<TSoundId>`, `muteRequested` |
| [`framework-api-assets.md`](framework-api-assets.md) — **load time** | `AtlasFrame`, `atlasFrameTexture`, `atlasSprite`; `preloadManifest`, `AssetManifestEntry`, `LoadProgress`, `loadDelayFromSearch`; `LoadingScreen`; `sealAssetLoaders`, `sealAssetNetwork`, `strictSealRequested`, `isInMemoryUrl` |
| [`framework-api-assets.md`](framework-api-assets.md) — **the service worker** | `registerGameServiceWorker`, `swResetRequested`, `resetServiceWorker`; `PrecacheEntry`, `installPrecache`, `activatePrecache`, `matchPrecached` |
| [`framework-api-debug.md`](framework-api-debug.md) — **opt-in surfaces behind URL flags** | `driveModeRequested`, `installDriveHarness`, `DriveHarness`; `statsOverlayRequested`, `PerfSampler`, `PerfOverlay`; `logLevelFromSearch`, `Logger`, `consoleSink`, `captureGlobalErrors`, `LogOverlay`, `RemoteLogSink`, `ConsentGate`, `TransmissionBadge` |
| [`framework-api-runtime.md`](framework-api-runtime.md) — **the loop and the boot wiring** | `GameLoop`, `Updatable`; `initI18n`, `t`, `applyStaticTranslations`; the `main.ts` composition root |
