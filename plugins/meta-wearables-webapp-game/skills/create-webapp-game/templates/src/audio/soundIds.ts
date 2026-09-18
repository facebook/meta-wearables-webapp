/**
 * The game's sound ids, and the typed view of `audioSettings.json`.
 *
 * `audioSettings.json` is the source of truth for what a sound *is* — a designer edits it without
 * touching TypeScript. This file is its two-line TypeScript companion: the list of event names, so
 * that `audio.play('lazer')` is a **compile error** rather than a runtime warning.
 *
 * ## Keep this list in step with the JSON
 *
 * Add an event to `audioSettings.json`, add its name here. There is deliberately no codegen step;
 * instead `audioSettings.test.ts` cross-checks the two and fails on drift in either direction, so
 * forgetting is caught by `npm test`, not by a silent bug on the glasses. `SOUND_IDS` is the
 * runtime list that check uses, and {@link SoundId} is derived from it — one list, both jobs.
 */

import rawSettings from '@/audio/audioSettings.json';
import type { AudioSettings } from '@/framework/audio/audioSettings';

/**
 * Every event in `audioSettings.json`, in the same order. Keep in sync — see the note above.
 */
export const SOUND_IDS = ['select', 'laser', 'explosion', 'pickup', 'shield', 'hit'] as const;

/** The game's sound-id union. Type your `AudioPlayer<SoundId>` with this for checked `play()` calls. */
export type SoundId = (typeof SOUND_IDS)[number];

/**
 * The parsed settings document.
 *
 * The cast is the one place JSON meets TypeScript. `resolveJsonModule` widens every string in a
 * `.json` import to `string`, so an imported config can never structurally match a schema with
 * literal unions in it (`"type": "square"` infers as `string`, not `LayerType`). Rather than
 * scatter that cast, it lives here once — and the runtime guard is `audio.validate()`, which is
 * built for exactly this: hand-authored JSON is not type-checked, so a typo has to surface as a
 * readable issue instead of a compile error. `audioSettings.test.ts` runs it.
 */
export const AUDIO_SETTINGS = rawSettings as unknown as AudioSettings;
