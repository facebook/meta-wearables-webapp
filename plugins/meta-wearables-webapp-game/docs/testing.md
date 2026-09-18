# Testing game logic

Because gameplay depends only on the [`Renderer`, `InputManager`, and `AudioPlayer`
contracts](framework-api.md) — never on Three.js, the DOM, or the Web Audio API — you can drive it
with tiny fakes in a plain `node` environment: no GPU, no browser. This is the whole point of the
[renderer/input-agnostic architecture](game-architecture.md#why-this-matters). Write a test
like this for every piece of non-trivial logic.

## The pattern (from the starter `src/core/Game.test.ts`)

Construct the `Game` (or any system) with a fake renderer and a scripted input, call
`update(dt)`, and assert on what the fake recorded. **The fakes already exist** — the scaffold
ships them in `src/framework/testing/fakes.ts`, so import them instead of writing your own:

```ts
import { describe, expect, it } from 'vitest';
import { Game } from '@/core/Game';
import { FakeAudioPlayer, FakeInput, FakeRenderer } from '@/framework/testing/fakes';
import type { ModelId } from '@/models';

describe('Game', () => {
  it('plays a select sound on an index pinch tap', () => {
    const input = new FakeInput();
    const audio = new FakeAudioPlayer();
    new Game(new FakeRenderer<ModelId>(), input, audio);
    input.fire('pinchTap', undefined);
    expect(audio.count('select')).toBe(1);
  });
});
```

What each one gives you:

| Fake | Records / drives |
|---|---|
| `FakeRenderer<TModelId>` | `positions`, `scales`, `opacities`, `frames` — the last value per handle on each per-instance channel, so a test can assert a pickup pulses, a dying enemy fades, or a walk cycle advances. `scales` stores the per-axis form even for a uniform factor. `remove(handle)` retires the handle and drops its entries, matching `ThreeRenderer`: a write to a removed instance is a silent no-op there, so it is one here too, and `opacities.has(handle)` answers "did the cue stop?" rather than returning the last value written while it ran. Everything else no-ops. Pass your `ModelId` union, like the real contract. |
| `FakeInput` | `fire(event, payload)` dispatches a discrete event; `setDelta(...)` sets what `consumeMovementDelta()` returns. |
| `FakeAudioPlayer` | `count(id)` / `ids()` over every `play()` call, with its `PlayOptions`; `bankRequests` over every bank load. |

`Game.ts` and `Game.test.ts` are examples to throw away when you build your real game; the fakes
are not. They live under `src/framework/` because they implement *framework* interfaces — so
they are managed code you don't hand-edit, and re-deriving them costs several typecheck
round-trips for nothing. Need more than they record (a scripted input sequence, a renderer that
tracks visibility)? Subclass one in your test file.

### The audio config is testable too, without a fake

The audio subsystem's config layers are **pure** — `soundDefinitions.ts`, `audioSettings.ts` and
`VoicePool.ts` build no Web Audio nodes at all — so they unit-test in plain `node` with no
`AudioContext` mock and no stub. The scaffold uses that for its own catalog in
`src/audio/audioSettings.test.ts`: it asserts `audioSettings.json` validates clean, and that the
hand-written `SoundId` union matches the JSON's event names exactly.

**Keep that file when you replace the starter's sounds.** It is what makes typed sound ids safe
without a codegen step: adding an event to the JSON and forgetting to add its id (or the reverse)
fails there instead of at `play()` time. See [audio.md](audio.md#why-the-ids-are-hand-written).

**`noUnusedLocals` applies to tests too**, and the usual test shapes trip it. `npm run
typecheck` covers `*.test.ts`, so `const game = new Game(...)` you never read afterwards is
`TS6133: 'game' is declared but its value is never read` — when you only want the constructor's
side effects, don't bind it (`new Game(renderer, input, audio)`, as the starter's sound test
does). Same for an import you stopped using: drop the `beforeEach` from your `vitest` import
list once the setup moved into the test body.

Persistence needs no fake at all: a game that takes a `KeyValueStore` (see
[game-architecture.md § Persisting state across sessions](game-architecture.md#persisting-state-across-sessions))
gets `MemoryKeyValueStore` from `@/framework/storage/KeyValueStore`, which starts empty in every
test so no best score leaks between cases.

## What to test — and what not to

**Do** unit-test the logic behind the game: movement, collisions, scoring, timers, spawn
rules, state-machine transitions. The starter tests five things worth copying:

- **Input applies correctly** — a delta from `consumeMovementDelta()` moves the player.
- **Frame-delta independence** — the same drag moves the player the same distance whether the
  frame took `0.1s` or `1s`, because the delta is an accumulated per-frame displacement (not a
  velocity to multiply by `dt`). This catches the classic "multiply the drag by dt" bug.
- **Clamping / bounds** — a huge delta clamps to `PLAYER.bound`.
- **Discrete events** — `fire('pinchTap')` increments the score.
- **Audio is triggered** — `fire('pinchTap')` records a `play('select')` on the `FakeAudioPlayer`
  (assert on ids, not real sound). Test *that* a sound fires, not how it sounds.

**Don't** unit-test rendering or DOM: the Three.js `ThreeRenderer`, the HUD, and pixel output
aren't the logic — drive them on-device or in the browser instead. The framework's own pure
modules (input mapping, asset-format helpers) already ship with Vitest coverage
(`PointerKeyboardInput.test.ts`, `assetFormats.test.ts`); you don't need to re-test them.

**Do** measure balance the same way when the design claims an outcome — a win rate, a run length,
a difficulty curve. Because gameplay needs no GPU or DOM, a scripted bot can play thousands of
full runs from fixed seeds in milliseconds, and that is the only check that can see whether a
tuned number does what it says.

## Checking the real thing in a browser

A unit test drives `Game` directly and never proves the assembled app works — it can pass on a
game that renders nothing. The complement is `?drive`, which pauses the loop so an external
driver advances it a known number of frames (`window.__webappGame.step(30)`) and then reads
`window.__game` or takes a screenshot at *that* state, rather than at wherever the frame clock
happened to be. Same benefit as an injected clock, applied to the whole running app.

It fixes timing, not randomness: a game calling `Math.random()` still runs differently each time.
Where an outcome must be repeatable, take a seed as a parameter, as the balance-measurement bot
above does. See [query-parameters.md § Drive mode](query-parameters.md#drive-mode-drive).

## Running tests

| Command | What it does |
|---------|--------------|
| `npm test` | Run the whole suite once (`vitest run`) — game tests and framework tests together. |
| `npm run test:game` | Run only the game's own tests: everything under `src/` except `src/framework/`. |
| `npm run test:framework` | Run only the framework tests that shipped with the scaffold. |
| `npm run test:watch` | Re-run on change (TDD loop). |

`npm test` is the gate: it is what Step 7 of `create-webapp-game`, the game director's
build pass, and CI all run, and it must stay green in full. The two narrower scripts exist for
*reporting*, not for gating.

**A game scaffolded before these two scripts existed will not have them.**
`update-webapp-game-framework` re-syncs `src/framework/` and deliberately leaves
`package.json` alone, so in such a project `npm run test:game` fails with `Missing script` — a
different thing from the `No test files found` exit the split expects from a game with no tests
of its own. Run the same filters directly, or paste the two scripts into the project's
`package.json`:

```bash
npx vitest run --exclude "framework/**"   # what test:game runs
npx vitest run --dir src/framework        # what test:framework runs
```

Vitest is configured inside `vite.config.ts` with `environment: 'node'` and
`include: ['**/*.test.ts']` — put tests next to the code as `X.test.ts`. The split is a CLI
filter on that one config, so adding a test never means touching the config:

| Script | Filter | Relative to |
|---|---|---|
| `test:game` | `--exclude "framework/**"` | the Vite `root`, `src/` |
| `test:framework` | `--dir src/framework` | the project directory |

Both are anchored on the scaffold's own `src/framework/`, deliberately. A looser
`--exclude "**/framework/**"` or a bare `framework/` path filter also matches a directory the
*game* happens to call `framework` (`src/entities/framework/`), which would file the game's own
tests under "inherited scaffold" — the exact confusion this split exists to remove. The double
quotes matter too: `cmd.exe` does not strip single ones, so a single-quoted glob reaches Vitest
with the quotes still attached. See [project-structure.md](project-structure.md) for the
full tooling setup, and [framework-api.md](framework-api.md) for the contracts these fakes
implement.

## Report the game count, never the total

**A suite total says nothing about whether the game has been tested.** A fresh scaffold already
passes 133 tests (measured on the starter project, plugin 1.40.0) — 127 of them framework tests
under `src/framework/`, inherited unchanged and identical in every game built from this scaffold.
The starter's own `Game.test.ts` contributes the other 6, and it is example code meant to be
thrown away. Write nothing, and the total is still three digits.

So the total moves barely at all with the thing it appears to measure. In one round of six games
built from this scaffold (Meta Display Glasses game eval, 2026-08-26), the six totals spanned 121–165 while
the game-test counts behind them were 4, 8, 14, 28, 36 and 49 — a 12x spread compressed into a
range that looks like noise. (Those six ran against an earlier plugin release, so their framework
baseline was not today's 127; the two sets of numbers do not add up to each other, and the spread
is the point rather than the arithmetic.) All six reported the total. None of them were lying; the
number they quoted was the one the test runner printed.

Quote `npm run test:game` and `npm run test:framework` as two numbers — "14 game tests, 127
framework" — and the reader can see which half is yours. Run both rather than copying either
figure out of this page: the framework half moves with every plugin release, and the game half is
the whole point of reporting it.
