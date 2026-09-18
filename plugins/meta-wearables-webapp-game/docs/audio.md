# Audio — events, sound design, mixing, spatialization, synthesis

Sound in a scaffolded game is **declared as data, not written as code**. `src/audio/audioSettings.json`
is the source of truth: named *events*, each owning one or more *clips* plus the tuning that decides
how they play. Gameplay only ever fires an event by id:

```ts
this.audio.play('explosion');
```

A sound designer can retune the whole game — volumes, variation, fades, how many can sound at once —
without opening a `.ts` file.

- Memory (banks, decode-vs-download, budgets, streaming music) lives in
  [`audio-banks.md`](audio-banks.md). Read it once your game has real recorded audio.
- The callable API surface is in [`framework-api.md`](framework-api.md).
- The layering rule that keeps gameplay audio-agnostic is
  [`game-architecture.md`](game-architecture.md).

## The four files

| File | Who owns it | What it holds |
|------|-------------|---------------|
| `src/audio/audioSettings.json` | the sound designer | every event and its tuning |
| `src/audio/soundIds.ts` | the engineer | the `SoundId` union, so `play()` is compile-checked |
| `src/config/gameplayConstants.ts` → `AUDIO` | the engineer | device tunables: voice cap, memory budget, spatial model, starting mix |
| `src/framework/audio/` | managed framework | the engine. Don't edit; it is overwritten by `update-webapp-game-framework` |

### Why the ids are hand-written

`play('lazer')` should be a compile error, and a designer should own the JSON. Those pull in opposite
directions: a `.json` import cannot produce a literal union (TypeScript widens every string in it to
`string`), so a typed id normally means a codegen step.

Instead the union is **one hand-written line** next to the JSON:

```ts
// src/audio/soundIds.ts
export const SOUND_IDS = ['select', 'laser', 'explosion', 'pickup', 'shield', 'hit'] as const;
export type SoundId = (typeof SOUND_IDS)[number];
```

and `src/audio/audioSettings.test.ts` fails if the list and the JSON disagree in either direction.
Add an event, add its name — `npm test` tells you if you forget. No build step, and the union and the
runtime list stay one list.

## Declaring a sound

An event's `clips` array is its **variation pool**. Each entry is either a **filename** (a recorded
sample) or an **inline synth stack** (oscillators and noise; no asset bytes at all).

```jsonc
{
  "name": "laser",
  "clips": [
    { "synth": { "gain": 0.4, "layers": [
      { "type": "square", "startFreq": 900, "endFreq": 420, "decay": 0.08, "peak": 0.5 }
    ] } }
  ],
  "voiceLimit": 4
}
```

```jsonc
{
  "name": "L1_Step",
  "clips": ["Step_01.ogg", "Step_02.ogg", "Step_03.ogg"],
  "bank": "level_1",
  "clipSelect": "randomNonRepeating",
  "cooldown": 120,
  "voiceGroup": "footsteps"
}
```

The starter's catalog is **entirely synthesized**, so a new game ships zero audio bytes and needs no
banks. The framework ships the synthesis engine and the format but **no specific sounds** — designing
your game's `playerFire` / `pickup` / `explosion` is your job.

### Event fields

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | string | required | The id `play()` takes. Must appear in `soundIds.ts`. |
| `clips` | array | required | Filenames and/or inline synth stacks. Several form a variation pool. |
| `bank` | string \| string[] | `"default"` | Memory group(s) for this event's *sample* clips. See [`audio-banks.md`](audio-banks.md). |
| `volume` | 0..1 | `1` | Linear gain. |
| `pitch` | number | `1` | Playback rate; shifts pitch and duration together. Scales a synth clip's frequencies. |
| `clipSelect` | `random` \| `randomNonRepeating` \| `roundRobin` | `random` | How a multi-clip event picks. |
| `randomNonRepeating` | boolean | `false` | Native-AMP spelling of `clipSelect: "randomNonRepeating"`. Kept so a config written for native AMP carries over; prefer `clipSelect`. |
| `fadeInDuration` | ms | `0` | Gain ramp up at start. |
| `fadeOutDuration` | ms | `0` | Gain ramp down applied by `stopSound()`. |
| `loop` | boolean | `false` | Repeat until stopped. Retriggering crossfades over `fadeOutDuration`. |
| `chanceToPlay` | 0..100 | `100` | Percent chance the trigger actually sounds. For sparse incidental audio. |
| `bus` | `sfx` \| `music` | `sfx` | Mixer routing. |
| `stream` | boolean | `true` on `music` | Play from a `blob:` URL instead of decoding. See [`audio-banks.md`](audio-banks.md). |
| `cooldown` | ms | `global.defaultCooldown` | Per-event retrigger guard, in the **time** domain. |
| `voiceLimit` | int \| `"max"` | `1`, or none with `voiceGroup` | Max concurrent instances, in the **count** domain. |
| `voiceLimitStrategy` | `killOldest` \| `preventNew` | `killOldest` | What happens at the limit. |
| `voiceGroup` | string \| string[] | none | Shared budget(s) this event draws from. |

### Synth layer fields

Only `type` and `decay` are required; the rest default exactly as the `tone()` builder does.

| Field | Default | Meaning |
|-------|---------|---------|
| `type` | required | `sine` \| `square` \| `sawtooth` \| `triangle` \| `noise` |
| `freq` | `0` | Flat pitch (Hz). Shorthand for `startFreq === endFreq`. |
| `startFreq` / `endFreq` | `freq` / `startFreq` | A pitch bend. `noise` ignores both. |
| `peak` | `1` | Envelope peak. |
| `attack` / `decay` | `0.005` / required | Envelope ramps, in **seconds**. |
| `delay` | `0` | Start offset in seconds — how you sequence an arpeggio inside one clip. |
| `detune` | `0` | Cents. Two identical layers a few cents apart shimmer. |

Techniques worth stealing, all in the starter's `audioSettings.json`: a **pitch bend** reads as motion
(a downward square sweep is a laser); **stacked layers** make a body (bright flash + noise + low
rumble = explosion); **`delay` offsets** turn one clip into an arpeggio; **`detune`** makes a metallic
shimmer; **two near-identical clips** stop a repeated sound machine-gunning.

### Global block

| Field | Default | Meaning |
|-------|---------|---------|
| `globalVoiceLimit` | `24` | Hard polyphony cap across all events. Clamped to `AUDIO.maxVoices`. |
| `defaultCooldown` | `50` ms | Retrigger guard for events that set none. |
| `soundsBasePath` | `"assets/sounds/"` | Prefix joined to each sample filename to form its manifest key. |

Anything passed to `init()` overrides the JSON, so a game can retune per device tier without editing
the designer's file.

**The bus mix is not in this block.** `masterVolume`, `sfxVolume` and `musicVolume` live in the
`AUDIO` block in `src/config/gameplayConstants.ts`, which is passed to the `AmpAudioPlayer`
constructor, and are changed at runtime with `setBusVolume()` — see
[Volume, buses, and mute](#volume-buses-and-mute). The split is
the one the JSON's own header states: tune the *sound* in `audioSettings.json`, the *mix* in
`AUDIO`.

## Playing

```ts
const handle = this.audio.play('explosion');           // fire and forget
this.audio.play('laser', { volume: 0.5, rate: 1.2 });  // per-play overrides
this.audio.play('step', { position: enemy.position }); // spatialized

this.audio.stop(handle);                // one voice
this.audio.stopSound('Ambience_Wind');  // every instance of an event, honouring its fadeOut
this.audio.stopAll();
```

`play()` returns `null` when the play was skipped — unknown event, cooldown, a `chanceToPlay` roll,
muted, bank not loaded, or a `preventNew` group at its limit. It never throws: audio must not be able
to break gameplay. Hold the handle only for a loop or a moving spatial source; a one-shot cleans
itself up.

## Voice concurrency

Two independent guards, answering different questions.

- **`cooldown`** is the *time* domain: "not more often than every N ms". It stops a bomb that hits
  twenty enemies in one frame from firing twenty times.
- **`voiceLimit`** is the *count* domain: "not more than N at once". It stops twenty overlapping
  copies if they do all fire.

Every event also owns an implicit private group, `@event:<name>`, which is what makes `stopSound()`
and `isPlaying()` work per event — including for one-shots — even when a shared budget is in play.
Whether that private group is *capped* depends on what the event declares:

| Event config | Effective cap on that event |
|---|---|
| neither field | **1** — the monophonic default |
| `voiceLimit: 3` | 3 |
| `voiceGroup: "ui"` | no private cap; the group governs |
| both | both apply, whichever bites first |

A **voice group** is one budget spent across several events:

```jsonc
"voiceGroups": [
  { "id": "footsteps", "voiceLimit": 4, "description": "One budget for every surface" }
]
```

An eviction can end a voice belonging to a *different* event when the two share a group. That is the
point of a shared budget.

Two semantics that are easy to get wrong and worth knowing:

1. **Group budgets are enforced before the global cap.** An unrelated voice is never stolen to make
   room for a play a `preventNew` group is about to refuse.
2. **A fading voice leaves its group count immediately but keeps its global slot.** That is why
   retriggering a loop crossfades with its own tail instead of being blocked by it. Global eviction
   prefers already-fading voices, then the oldest one-shot, then the oldest voice — so an ambience
   survives a burst of SFX.

`globalVoiceLimit` is settable at runtime, which is how you profile a device: lower it under a burst
until stealing becomes audible. The ceiling is CPU on the audio render thread, not any platform track
count — Web Audio mixes in-process to a single output stream.

## Volume, buses, and mute

Two buses under a master. Two is a deliberate floor: independent music volume is the one mix control
players actually expect.

```ts
audio.setBusVolume('master', 0.8);
audio.setBusVolume('music', 0.4);   // duck under a cutscene
audio.setMuted(true);               // gates new plays AND fades out what is sounding
audio.toggleMute();
```

Load the game with **`?mute`** to silence a session — handy for capturing or demoing on the glasses,
where there is no volume control. See [`query-parameters.md`](query-parameters.md).

## Spatialization (stereo pan + distance)

Pass a `position` and the voice is panned and attenuated relative to the listener:

```ts
audio.setListener(player.position);                        // once, for a fixed camera
const h = audio.play('engine', { position: car.position, loop: true });
audio.setPosition(h, car.position);                        // each frame, for a moving source
```

Deliberately **not** HRTF. The glasses' open-ear speakers carry little binaural cue, so full 3D
panning would cost CPU for something the hardware cannot reproduce; a stereo pan plus a distance curve
is cheap and reads clearly. A game that genuinely wants a `PannerNode` can build one through
[`createVoice`](#custom-voices).

Tune the model in `AUDIO`: `panRange` (world half-width mapped to full left/right), `refDistance` (no
attenuation inside this), `rolloffFactor` (how sharply it falls off), `maxDistance` (silent at or
beyond).

## Performance: the voice pool

Web Audio source nodes are **single-use by spec** — once started and stopped they cannot be restarted
— so a fresh source *must* be created per play. The spec makes that cheap. The real hitch risks are
JS-side garbage and re-allocating the nodes that *could* be reused.

So the engine pools everything reusable: a fixed set of channel strips
(`inputGain → stereoPanner → distanceGain`), their bookkeeping, and one shared white-noise buffer.
Only the spec-mandated source (and per-layer envelope) nodes are allocated per play. Voice handles are
generation-encoded integers, so `stop` / `setPosition` validate a handle with no per-play `Map` churn,
and each strip has a single bound `onended` handler rather than a per-play closure.

`AUDIO.maxVoices` (default 16) is the size of that pool and therefore the hard ceiling.
`globalVoiceLimit` is a soft cap clamped to it — raising it past the pool size would allocate at
runtime, so it clamps instead.

## Autoplay unlock and battery

Browsers start the `AudioContext` suspended until a user gesture, and the framework creates it
**lazily** for the same reason — constructing one outside a gesture trips the autoplay policy. The
scaffold's `main.ts` unlocks it on the first pinch and suspends it when the app is backgrounded so it
draws no audio-thread power:

```ts
input.on('pinchTap', () => audio.resume());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else if (audio.getContext()) audio.resume();
});
```

The `getContext()` guard matters: before the first pinch there is no context, and calling `resume()`
would construct one outside a gesture.

## Custom voices

For a graph the event format cannot express — a live-modulated drone, a real `PannerNode`, an
`AudioWorklet` — `createVoice()` hands back a routed, bus-connected (and optionally spatialized) input
node plus a handle from the same voice pool:

```ts
const voice = audio.createVoice({ bus: 'sfx', position: drone.position });
if (voice) {
  const ctx = audio.getContext()!;            // createVoice forced lazy init, so this is non-null
  const osc = ctx.createOscillator();
  osc.connect(voice.input);
  osc.start();
  osc.onended = () => { osc.disconnect(); audio.stop(voice.handle); };
}
```

**You own cleanup.** Unlike `play`, a custom voice has no framework source to watch, so it never
auto-releases: it holds a slot against the voice cap until you `stop(handle)`. You must also
`disconnect()` your own nodes, or a still-connected source re-mixes into the next play that reuses the
slot.

## Registering sounds from TypeScript

`audioSettings.json` is the source of truth, but two escape hatches exist for sounds a designer cannot
author ahead of time:

```ts
audio.registerEvents([{ name: 'proc_hum', clips: [{ synth: { layers: [/* … */] } }] }]);
audio.registerSoundDefinitions({ blip: synth({ layers: [tone('square', 660, 880, 0.08)] }) });
audio.registerSounds({ voiceover: someAudioBuffer });   // an AudioBuffer you decoded yourself
```

The last two register single-clip events with default tuning. A sound that needs a voice group, a
cooldown, or a bank belongs in the JSON.

## Config health

`validate()` returns every problem in the loaded config as a readable string — empty clips, undeclared
banks or voice groups, a misspelled `voiceLimitStrategy` (which would otherwise silently fall through
to `killOldest`), out-of-range `chanceToPlay`, stacked loops that will comb-filter, missing or stale
`pcmBytes` hints, and drift against the `SoundId` union. Hand-authored JSON is not type-checked, so
this is what stands between a typo and a silently wrong mix. The scaffold runs it in
`src/audio/audioSettings.test.ts`; wire it into a dev overlay too if you like.

## Testing

Gameplay takes an injected `AudioPlayer<SoundId>`, so a test drives it with `FakeAudioPlayer` — no
`AudioContext`, no browser:

```ts
const audio = new FakeAudioPlayer();
new Game(new FakeRenderer<ModelId>(), input, audio);
input.fire('pinchTap', undefined);
expect(audio.count('select')).toBe(1);
```

See [`testing.md`](testing.md). Never import `AmpAudioPlayer` or `AudioEngine` from gameplay —
`npm run validate` fails it, because it locks the fake out.

## Format policy

**Ogg Vorbis is the standard.** It compresses well and decodes natively in the Chromium WebView
Meta Display Glasses runs. Any browser-decodable format works (`.ogg`, `.m4a`, `.mp3`, `.wav`, `.flac`) — the
engine calls `decodeAudioData` and does not inspect the extension — but one format across a project
means one predictable decode path and one predictable memory profile.

For a **bank-backed** clip the choice also has a memory cost, because its compressed bytes stay
resident for the whole session: an uncompressed WAV leaves ~15× more behind after its bank unloads
than the same audio as Ogg. See [audio-banks.md](audio-banks.md). Normalize with:

```bash
ffmpeg -i input.wav -c:a libvorbis -q:a 5 output.ogg
```

Raw PCM (`.raw`) is not supported and never will be: it is a container-less byte dump with no sample
rate or channel count, so no browser can decode it.

**This plugin ships no audio files.** The starter catalog is synth-only; a sample pack, if one ever
happens, is a separate optional download.
