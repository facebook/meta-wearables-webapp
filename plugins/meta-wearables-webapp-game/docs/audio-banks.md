# Audio banks — memory, preloading, and streaming music

Everything here is about **memory**. Skip it entirely if your game's sounds are synthesized (the
starter's are): synth costs no bytes, belongs to no bank, and is always playable. Read it the moment
you add recorded audio. For events, tuning and playback, see [`audio.md`](audio.md).

## Banks manage decode, not download

The instinct carried over from native platforms is "download at startup, save to disk, load at bank
switch", which manages *download* cost. On the web, for audio, download is not the scarce resource:

| | stereo 48 kHz |
|---|---|
| Decoded `AudioBuffer` (Float32: channels × frames × 4) | **~0.37 MB / second** |
| Ogg Vorbis @ ~96 kbps | ~0.012 MB / second |

A ~30× ratio. It was corroborated on a Meta Ray-Ban Display device during an earlier audio
bring-up: 33 clips whose compressed payload was a couple of megabytes expanded to **10.28 MB** of
resident PCM, which freed on unload.

That ratio is why **the source format matters to the bank model, not just to download size.** Any
browser-decodable format plays, but an uncompressed one undercuts the design:

| stereo 48 kHz | held forever (the `Blob`) | held while the bank is loaded (the `AudioBuffer`) |
|---|---|---|
| Ogg Vorbis @ ~96 kbps | ~0.012 MB / s | ~0.37 MB / s |
| 16-bit WAV | ~0.18 MB / s | ~0.37 MB / s |

A clip's compressed bytes stay resident for the whole session, so with Ogg they round to nothing and
unloading a bank reclaims essentially all of that clip's cost. With WAV the permanent half is **~15×
larger** and unloading reclaims only about two thirds. WAV is fine for a handful of short clips;
for anything bank-sized, normalize to Ogg first. Native AMP's ancestor of this problem is on record
too — an early web port eagerly decoded every clip, held roughly 70 MB of PCM, and tripped the
on-device Low Memory Killer, which killed the WebView renderer.

So compressed bytes are cheap and stay resident for the whole session; **decoded PCM is what has to
be managed**:

- **load a bank** = decode its clips into `AudioBuffer`s.
- **unload a bank** = drop those `AudioBuffer`s and let GC reclaim them. The compressed bytes never
  leave memory and are never re-fetched.

Three consequences worth stating plainly:

1. **Zero network access at runtime.** Every byte arrives through the preload manifest before the
   game loop starts, so the project's preload rule keeps its teeth — there is no audio carve-out in
   `npm run validate`, and a `fetch` appearing in an audio path is a real regression.
2. **Total audio may exceed the memory budget**, as long as no *simultaneously resident* set does.
   That was the actual goal.
3. **A bank switch costs a decode, not a round trip**, so it is far cheaper than the native model
   implies.

## Declaring a bank

Banks are a memory *group*, not a container: an event says which bank(s) it belongs to, so one clip
can belong to several, and a bank is a query over events rather than something that owns them. The
`banks` block is optional — a bank an event names is registered implicitly. Declare it when you want
a description, `persistent`, or `transitionsTo`.

```jsonc
"banks": [
  { "id": "shared",  "persistent": true, "description": "UI + player sounds, always resident" },
  { "id": "level_1", "transitionsTo": ["level_2"] },
  { "id": "level_2" }
],
"events": [
  { "name": "UI_Click",   "clips": ["Click.ogg"],  "bank": "shared" },
  { "name": "L1_Step",    "clips": ["Step.ogg"],   "bank": "level_1" },
  { "name": "Transition", "clips": ["Whoosh.ogg"], "bank": ["level_1", "level_2"] }
]
```

An event that declares no bank lands in the always-resident `default` bank, which cannot be unloaded.
A game with no levels can leave `bank` off everything and never call `loadBank` — banks are opt-in
complexity that only appears when a game has levels.

## Preloading the bytes

Every sample clip needs a manifest entry so its bytes are in memory before the loop starts. The entry
path must equal the key the settings resolve, i.e. `soundsBasePath` + the filename in `clips`;
`audio.validate()` reports any clip nothing supplies.

```ts
import { preloadManifest } from '@/framework/render/AssetLoader';
import type { AssetManifestEntry } from '@/framework/render/AssetLoader';
import { withAudioSizes } from '@/framework/render/assetFormats';
import SIZES from '@/audio/audioSizes.json';

const MANIFEST = withAudioSizes({
  step:   { type: 'audio', path: 'assets/sounds/Step.ogg',   bank: 'level_1' },
  click:  { type: 'audio', path: 'assets/sounds/Click.ogg',  bank: 'shared' },
  theme:  { type: 'audio', path: 'assets/sounds/Theme.ogg',  stream: true },
} as const satisfies Record<string, AssetManifestEntry>, SIZES);

const assets = await preloadManifest(MANIFEST, (f) => loading.setProgress(f), 0, audio);
await audio.init({ initialBanks: ['level_1'] });
```

**Generate the sidecar before you first typecheck.** The scaffold ships no
`src/audio/audioSizes.json` — a synth-only game never needs one — and `npm run build` / `npm run
ship` start with `tsc --noEmit`, which runs *before* anything that would create it. So the first
time you add audio files and that import, run:

```bash
npm run audio-sizes
```

After that the Vite plugin refreshes it **at the start of** every `vite`, `vite build` and `vitest`
run. It regenerates in `buildStart` and watches nothing, so an audio file added or replaced while a
dev server is already running is picked up on the next start, not live.
Commit it: it is what makes a fresh clone typecheck, and it puts the measurements in review.

Note what is *not* in that manifest: any numbers. `bytes` and `pcmBytes` are measurements, so they
are measured — see [Sizes are generated, not maintained](#sizes-are-generated-not-maintained).

The fourth argument is the audio subsystem itself, and the entry says how its bytes are held:

| declare | held as | decoded |
|---|---|---|
| `bank: 'level_1'` | `Blob` | when that bank loads; freed when it unloads |
| `stream: true` | `Blob` | never — played from a `blob:` URL |
| neither | — | eagerly during preload, into an `AudioBuffer` the game holds |

`stream: true` has to agree with the event: a clip on the `music` bus (or with `stream: true` in
`audioSettings.json`) is played as a stream, so its manifest entry must say so too. `validate()`
reports either half of that mismatch — without the flag the bytes would be held for a decode that
never comes, and a bank would demand a `pcmBytes` hint for PCM that never exists.

## Sizes are generated, not maintained

Run `npm run audio-sizes` (or just start `vite` — the plugin does it) and every audio file under
`public/` is measured into `src/audio/audioSizes.json`:

```json
{
  "assets/sounds/Step.ogg": { "sha256": "9f2c…", "bytes": 24004, "pcmBytes": 1400000 }
}
```

`withAudioSizes()` merges those into the manifest at import, so the hand-written half stays
declarative — which clip, which bank — and the measured half is never out of date.

The `sha256` is what makes staleness detectable rather than silent:

| | |
|---|---|
| `vite` / `vite build` / Vitest | regenerate on hash mismatch, and warn to commit the result |
| `npm run audio-sizes:check` | exit 1 if the committed sidecar no longer matches the committed audio (wired into `npm run ship`) |

The sidecar is **committed**, not generated on demand, because `npm run build` runs `tsc` before
Vite — a file that only appeared once Vite started would break typecheck on a fresh clone.

A format the parser does not cover (MP3, M4A, or a compressed WAV) is listed with `bytes` but no
`pcmBytes`. That is safe: an unknown decoded size makes bank swaps sequential rather than trusting
an estimate. `withAudioSizes` **clears** a hand-written `pcmBytes` in that case rather than keeping
it — for the number bank costing depends on, unknown is handled and stale is not.

An `audio` entry whose `path` matches no sidecar key is left exactly as declared, and warns in dev.
The keys are `public/`-relative paths, so a typo otherwise looks identical to an unsupported
format. Absolute and remote paths (`/assets/x.ogg`, `https://…`, `data:…`) resolve as-is and are
never sidecar keys, so they are exempt from the warning.

Two different byte counts, easy to confuse:

- **`bytes`** — the compressed file size. Only weights the loading-progress bar.
- **`pcmBytes`** — the *decoded* size, and **optional**. Normally generated; the formula is
  `channels × 48000 × seconds × 4`. It is sized against **48 kHz** because `decodeAudioData`
  resamples to the AudioContext's rate, not the file's, and that is the device's rate (measured on
  device during bring-up; confirm it from a page with `new AudioContext().sampleRate`). On a
  44.1 kHz laptop that over-estimates by ~9%, which is the safe direction for a budget.

  Its only job is costing a bank *before* anything in it has been decoded. Omit it and nothing is
  unsafe: an overlapped swap into that bank falls back to sequential, and a declared
  `transitionsTo` pair involving it is reported as unverifiable rather than passing silently. After
  one decode the real measured size is recorded and supersedes the hint anyway, so the field only
  ever buys you a smoother *first* swap. `audio.validate()` reports a missing hint once for the
  whole set, and flags any hint more than 10% off the measured size.

## Switching banks

```ts
await audio.loadBank('level_2');
audio.unloadBank('level_1');

// or, for a level transition, in one call:
await audio.swapBanks(['shared'], ['level_2']);
```

`unloadBank` frees only clips no *still-loaded* bank references — a set difference computed fresh, so
there is no reference counting to get wrong. Voices already playing a released buffer hold their own
reference and finish normally, and any event whose backing clips just went away is stopped.

### The two swap modes

`swapBanks` takes a mode, and the choice is a real trade-off:

| mode | order | peak residency | cost |
|------|-------|----------------|------|
| `'sequential'` (default) | unload, then decode | `max(outgoing, incoming)` | a gap at the switch |
| `'overlapped'` | decode, then unload | `outgoing + incoming` | none, if it fits |

`'overlapped'` hides the gap by decoding the incoming banks while the outgoing ones are still
playing. That is exactly the case where peak residency is at its worst, so **the player refuses to
overlap when `outgoing + incoming` would exceed `AUDIO.maxResidentBytes` and falls back to sequential
with a warning** rather than risking an out-of-memory kill of the WebView.

It also refuses when the incoming cost is simply **unknown** — clips with no `pcmBytes` hint that
have never been decoded. An unknown clip contributes nothing to the estimate, so trusting the number
there would wave through the first swap into an unmeasured bank, which is the case the check exists
for. The fallback is a sequential swap; the swap after that can use the sizes measured during this
one.

You can catch that at authoring time instead of on-device: declare `transitionsTo` on a bank and
`validate()` fails any declared pair whose combined estimate does not fit.

## The budget

`AUDIO.maxResidentBytes` (default **24 MB**, about 65 seconds of stereo 48 kHz) is the ceiling on
decoded PCM for the whole subsystem — a conservative slice of the platform's < 128 MB app budget (see
[`performance-guidelines.md`](performance-guidelines.md)). Raise it for a game whose levels genuinely
need more.

A `loadBank` that would take residency past it is **refused with a warning**, so an oversized bank
degrades to "some clips silent" rather than to a killed renderer. Watch it live with the `?stats`
overlay, which shows `Snd  <resident>/<budget> MB  <voices>v` — worth having on while playtesting on
the glasses, because decoded audio is the one memory cost that moves at runtime and has no
browser-visible counter.

## Music streams; SFX decodes

A two-minute music loop is ~44 MB of PCM on its own — nearly twice the whole default budget. So music
does not decode. An event on the `music` bus **streams** by default: its clip plays through a
`MediaElementAudioSourceNode` fed from a `blob:` URL over the preloaded bytes, which decodes
incrementally and holds almost no PCM. It routes into the same music bus, so mixing, ducking and mute
are unchanged.

A streamed clip has no bank lifecycle: its compressed bytes are always resident and it costs nothing
against the budget. Override the default either way with `stream`:

```jsonc
{ "name": "Theme",    "clips": ["Theme.ogg"],   "bus": "music", "loop": true },
{ "name": "Sting",    "clips": ["Sting.ogg"],   "bus": "music", "stream": false },
{ "name": "Ambience", "clips": ["Wind.ogg"],    "stream": true }
```

Decode a short music sting for lower start latency; stream a long sfx-bus ambience to keep it off the
budget.

## Hitching

`decodeAudioData` is async and decodes off the main thread in Chromium, so a bank switch should not
block the render loop; the residual hitch is allocation and GC pressure, not the decode itself.
Mitigate it with the overlapped mode where the budget allows, or hide it behind the existing loading
screen or a transition.

**How much hitch actually remains on Meta Ray-Ban Display is a device measurement, not something to
reason about from here.** It has not been measured for this implementation yet; if you have a
device, that number is worth taking and adding to this doc.

## Why bytes are held as `Blob`s

An implementation note that matters if you touch `BankStore`.

`decodeAudioData` **detaches (neuters) the `ArrayBuffer` you hand it**, so the same buffer cannot be
decoded twice. Holding a `Blob` and materializing a fresh `ArrayBuffer` per decode avoids that
cleanly. Holding a raw `ArrayBuffer` and remembering to `.slice(0)` on every decode does not — it is a
latent bug that only fires on the *second* `loadBank` of the same clip, which is to say the second
time a player revisits a level. `BankStore.test.ts` pins this.

## Future work: the Cache API

Bytes live in memory for the session. `caches.open(...)` + `cache.put(url, response)` at startup, and
`cache.match(url)` at bank-load time, would make the *second* launch need no download at all — and
still no `fetch` in game code, so still preload-rule clean.

It is deferred because cache invalidation is unsolved for this workflow: a dev rebuild must always
refetch, and a shipped bank change must force a redownload, so it needs a content-hash or build-id
keyed cache name plus an explicit dev bypass. Note also that origin cache is evictable under storage
pressure unless `navigator.storage.persist()` is granted, so it can only ever be an optimization
layered over the in-memory path, never a correctness dependency.

OPFS (`navigator.storage.getDirectory()`) — the literal filesystem API — works in the glasses WebView
but is more machinery than this needs.
