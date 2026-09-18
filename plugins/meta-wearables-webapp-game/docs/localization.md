# Localization (i18next) — one language now, translatable later

Every scaffolded game is **localization-ready**: all user-facing text flows through
[i18next](https://www.i18next.com/), so a translator can add other languages later without
touching game logic. By default only **English** is implemented — you write English source
strings; localization is a later, separate step.

This doc is the *why* and *how*. The callable API is also in
[`framework-api-runtime.md`](framework-api-runtime.md#localization-srcframeworki18n); the reason all text is DOM
(the injection point) is in [`threejs-vs-dom.md`](threejs-vs-dom.md).

## Where the pieces live

| Piece | Location | Managed? |
|-------|----------|----------|
| Detection policy + `t` + DOM applier (`initI18n`, `t`, `applyStaticTranslations`) | `src/framework/i18n/i18n.ts` | **Framework** — re-copyable engine code; owns *how* a locale is picked. Imports no game code. |
| The strings (source of truth) | `src/i18n/en.json` | Game code — edit freely. |
| Bootstrap: injects the strings into the framework, re-exports `t` | `src/i18n/index.ts` | Game code. |

The split mirrors the rest of the framework: the framework owns reusable *policy* (which locale to
use, how translated text reaches the DOM); the game owns the *data* (the strings) and injects it in
— exactly like `config/` tunables are injected into the renderer/input.

## Adding a user-facing string

1. Add a key + English text to `src/i18n/en.json`:
   ```json
   { "gameOver": "Game Over" }
   ```
2. Render it — **never hardcode the copy in the DOM**:
   - **Dynamic text (TS/JS):** `import { t } from '@/i18n'`, then `el.textContent = t('gameOver')`.
   - **Static text (HTML):** add a `data-i18n="key"` attribute to an (empty) element; the boot code
     fills it. A `<title data-i18n="…">` in `<head>` sets the document title too.
     ```html
     <div class="title" data-i18n="title"></div>
     ```

Bare numbers and symbols are **not** copy — `el.textContent = String(score)` and glyph-only labels
(`▲▼◀▶`) stay as they are. The score in the starter `Hud.ts` is a plain number for this reason.

`npm run validate` enforces this — see [Enforcement](#enforcement) below.

## How a locale is chosen (and how to test one)

Locale detection uses the official `i18next-browser-languagedetector`, configured with this order —
the first source that yields a language wins:

| Order | Source | Role |
|-------|--------|------|
| 1 | **`querystring`** (`?lng=<code>`) | **Testing** a specific locale — the canonical override. |
| 2 | **`localStorage`** | Persists a chosen/tested locale across reloads (also the detector's cache). |
| 3 | **`navigator`** | The device/browser language — the **runtime default** on-glasses. |
| 4 | **`htmlTag`** (`<html lang>`) | Final fallback hint. |

Any key missing in the active language falls back to English (`fallbackLng: 'en'`).

**To test a locale**, append `?lng=<code>` to the URL — e.g. `http://localhost:5173/?lng=fr`. This
works in the desktop dev server, in the Chrome that `iterate-webapp-game` drives over
CDP, and on-device.
(`?lng` is one of the game's URL flags — see [query-parameters.md](query-parameters.md) for all of them.)
With only English bundled, `?lng=fr` simply falls back to English until a `fr.json` exists; add a
throwaway locale (below) to see switching actually work.

## Adding a language later (the localization step)

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json` (e.g. `fr.json`) and translate the values
   (keep the keys).
2. Register it in `src/i18n/index.ts`:
   ```ts
   import en from './en.json';
   import fr from './fr.json';
   initI18n({ resources: { en: { translation: en }, fr: { translation: fr } } });
   ```

No game logic changes. Untranslated keys fall back to English automatically.

## Framework API

From `src/framework/i18n/i18n.ts` (import `t` from `@/i18n`, which re-exports it):

```ts
initI18n(options: {
  resources: Resource;      // e.g. { en: { translation: {...} } }
  fallbackLng?: string;     // default 'en'
}): i18n;

t(key: string, options?: Record<string, unknown>): string;

applyStaticTranslations(root?: ParentNode): void;   // fills [data-i18n]; default root = document
```

`initI18n` runs synchronously (`initImmediate: false`) because resources are **bundled**, so `t()`
works before first paint — no async boot, no runtime network request. It asserts this by throwing if
the singleton is not initialized by the time it returns, so a future change that makes init async
(e.g. an HTTP backend) fails loudly at boot rather than letting callers read an uninitialized
i18next. `main.ts` triggers init via a side-effect `import '@/i18n'`, then calls
`applyStaticTranslations()` before rendering.
`applyStaticTranslations` is DOM **output** only (it attaches no listeners), so it complies with the
[no-input-through-DOM rule](game-architecture.md#input-must-not-flow-through-the-dom-enforced).

## Constraints

- **Bundle, don't fetch.** Resources are imported (`resolveJsonModule` is on) and bundled — no HTTP
  backend. This keeps the game within the `< 10 network requests` / offline budgets in
  [`performance-guidelines.md`](performance-guidelines.md#targets). i18next + the detector add only a
  few KB gzipped; three.js dominates the `< 500 KB` budget.
- **No external fonts.** Non-Latin scripts (CJK, Arabic, Devanagari, …) render only if the system
  font stack covers them — [`performance-guidelines.md`](performance-guidelines.md#assets) forbids
  external font downloads. Verify glyph coverage before shipping such a locale.

## Enforcement

`npm run validate` (the `validate-webapp-game` skill) runs a dependency-free scanner
(`scripts/validate-localized-strings.mjs`) that fails on hardcoded user-facing text — a string
literal with letters assigned to `.textContent` / `.innerText` / `.innerHTML` / `document.title`, or
passed to `insertAdjacent*` — outside the `src/i18n/` and `src/framework/` layers. HTML text without
a `data-i18n` attribute, and hardcoded `title` / `alt` / `placeholder` / `aria-label` attribute
values, are flagged *ambiguous* for review (those attributes can't use `data-i18n`, which localizes
element text only — set them from JS with `t('key')`). Run it before considering a change done.

The scanner is line-based, so it deliberately does **not** flag element-property attribute setters in
JS (`el.title = …`, `el.setAttribute('title', …)`): `.title` / `.alt` collide with ordinary
data-model fields, and flagging them would be too noisy. Route those through `t()` yourself.
