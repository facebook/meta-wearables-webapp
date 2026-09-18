---
name: update-webapp-game-framework
description: >-
  Update an existing webapp game's managed framework code
  (`src/framework/`) to the latest version bundled with this plugin. Use after
  updating the plugin to pull the newest renderer / input / game-loop / math
  engine code into a game project without touching game files — i.e. "get the
  latest framework code", "upgrade the game framework", "re-sync src/framework".
argument-hint: "[project-dir]"
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# Update a webapp game's framework code

A game scaffolded by `create-webapp-game` keeps all reusable engine code under
`src/framework/` — the renderer/input contracts and their implementations, the game loop, and
framework-free math. That directory is **managed**: it depends on no game code and is meant to
be re-pulled wholesale when the plugin ships an improved framework. This skill does that re-pull.

It overwrites only `src/framework/`. It never touches game code (`src/models.ts`, `src/core/`,
`src/hud/`, `src/config/`, `src/main.ts`, `style.css`) or tooling (`package.json`,
`tsconfig.json`, `vite.config.ts`) on its own — Steps 7.5 and 7.6 *offer* edits to `src/main.ts`,
`vite.config.ts` and `scripts/`, but only for a subsystem the game is missing and only after
explicit confirmation.

**One narrow exception in `src/index.html`:** the `content` of its `<meta name="generator">` — the
attribution marker that tells anyone looking at a released game which skill and version built it —
is re-stamped, and the tag is inserted if the game predates it. Nothing else in that file is
touched.

Because it doesn't edit `package.json`, a framework version that adds a new runtime dependency
requires a one-time `npm install` — Step 6 detects this. (The i18n layer, for instance, pulls in
`i18next` and `i18next-browser-languagedetector`, so a project scaffolded before it has neither.)

**Source of truth** (the latest framework, bundled in this installed plugin):

```
${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/templates/src/framework/
```

## Workflow

### Step 1: Locate and validate the game project

Use the `[project-dir]` argument if given, otherwise the current directory. A valid target has
both a `package.json` and a `src/framework/` directory:

```bash
PROJECT="${1:-$(pwd)}"
test -f "$PROJECT/package.json" && test -d "$PROJECT/src/framework" \
  && echo "OK: $PROJECT" \
  || echo "NOT a meta-wearables-webapp game with src/framework/"
```

If `src/framework/` is **absent**, this game predates the framework/game split. Do **not** try
to reorganize it automatically — tell the user their game predates `src/framework/` and stop.

### Step 2: Report current vs latest version

The framework version is just the plugin version (no separate version file to maintain). Read
the latest from the installed plugin, and the project's stamped version if present:

```bash
LATEST=$(node -p "require('${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json').version" 2>/dev/null || echo "unknown")
CURRENT=$(cat "$PROJECT/src/framework/VERSION" 2>/dev/null || echo "unknown")
echo "framework: current ${CURRENT} -> latest ${LATEST}"
```

`CURRENT` is `unknown` for games scaffolded before version stamping existed — that's fine, the
diff below is what actually decides whether anything changes.

### Step 3: Preview what would change (authoritative)

Diff the bundled framework against the project's copy. The `VERSION` stamp is excluded so it
never shows as spurious drift:

```bash
FRAMEWORK_SRC="${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/templates/src/framework"
diff -rq --exclude=VERSION --exclude=framework-license.txt --exclude=LICENSE \
  "$FRAMEWORK_SRC" "$PROJECT/src/framework"
diff -q "$FRAMEWORK_SRC/framework-license.txt" "$PROJECT/src/framework/LICENSE"
```

Interpret the output: `Only in $FRAMEWORK_SRC/...` = a file that would be **added**; `Only in
$PROJECT/...` = a file that would be **removed** (pruned); `Files ... differ` = **changed**.

Both names of the licence file are excluded from the recursive diff because they are one file: the
source ships `framework-license.txt` and a scaffolded game holds it as `LICENSE` (Step 5 renames
it). Comparing them by name would report a phantom add/remove on every run, and the "no
differences" check below would then never fire. The second `diff` pairs them up explicitly, so the
exclusion suppresses the phantom without also hiding a real change to the licence text — or a
`LICENSE` a game deleted or hand-edited.

**If there are no differences, the framework is already up to date** — run the stamp step (Step
5's `stamp-version.mjs` line only), report "already up to date", and stop. Do not run the rest.

Run the stamp **unconditionally** here, even when `CURRENT` already equals `LATEST`. A game
scaffolded before the `<meta name="generator">` marker existed is at the current framework
version and still has no marker; this is the path that backfills it. The script is idempotent, so
a game that already has it is left byte-identical.

### Step 4: Safety — protect against a bad overwrite, then confirm

`src/framework/` is managed, so overwriting it is expected — but a re-copy also **prunes** files
and would clobber any local edits. Guard first:

```bash
# Version control?
git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo git || echo none
```

- **Under git**: check for uncommitted changes under `src/framework/`
  (`git -C "$PROJECT" status --short -- src/framework`).
  If any exist, warn that they'll be overwritten and recommend committing/stashing first so the
  update stays reviewable and revertible. Local edits to a managed dir also mean the
  don't-hand-edit contract was broken — surface them.
- **Not under version control**: offer to make a one-time backup before overwriting:
  ```bash
  cp -R "$PROJECT/src/framework" "$PROJECT/src/framework.bak-$(date +%Y%m%d-%H%M%S)"
  ```

Then present the concrete list of files that will be added / changed / removed (from Step 3) and
use **AskUserQuestion to get explicit confirmation** before writing anything.

### Step 5: Apply the update

Mirror the source into the project, pruning files removed upstream, then stamp the version. The
stamp is one script — the same one `init-game.mjs` calls at scaffold time — which writes
`src/framework/VERSION` **and** re-stamps (or inserts) the `<meta name="generator">` marker in
`src/index.html`. Prefer `rsync`; fall back to remove-then-copy if it isn't available:

```bash
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude=VERSION "$FRAMEWORK_SRC/" "$PROJECT/src/framework/"
else
  find "$PROJECT/src/framework" -mindepth 1 -not -name VERSION -delete
  cp -R "$FRAMEWORK_SRC/." "$PROJECT/src/framework/"
fi
# The same rename `init-game.mjs` applies at scaffold time. Without it the prune deletes the
# game's `src/framework/LICENSE` and leaves an unrenamed `framework-license.txt` at a path
# nothing points at — the README, and the per-file headers in a game scaffolded from the public
# payload, both name `LICENSE`.
if [ -f "$PROJECT/src/framework/framework-license.txt" ]; then
  mv "$PROJECT/src/framework/framework-license.txt" "$PROJECT/src/framework/LICENSE"
fi
node "${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/scripts/stamp-version.mjs" "$PROJECT"
```

It prints a JSON summary whose `generator` field is `inserted`, `updated` or `unchanged` — carry
that into Step 8.

### Step 6: Install any new framework dependencies

The re-sync copies only code — it does not edit `package.json`. A newer framework may `import` an
npm package the project doesn't have yet (the i18n layer needs `i18next` and
`i18next-browser-languagedetector`). Detect bare imports under `src/framework/` that are missing
from the project's dependencies:

```bash
cd "$PROJECT"
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const have = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
const found = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.[cm]?tsx?$/.test(e.name)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["\x27]([^"\x27]+)["\x27]/g)) {
      const s = m[1];
      if (s.startsWith(".") || s.startsWith("@/") || s.startsWith("node:")) continue;
      found.add(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
    }
  }
};
walk("src/framework");
const missing = [...found].filter((d) => !have.has(d));
console.log(missing.length ? "MISSING: " + missing.join(" ") : "OK: framework deps present");
'
```

If it prints `MISSING: …`, install those packages (they are runtime deps) before the gate:

```bash
npm install <missing packages>
```

### Step 7: Verify the project still builds

Run the project's full gate from the project root:

```bash
cd "$PROJECT" && npm run typecheck && npm test && npm run build
```

- **All pass** → done. Report the changed files and the new stamped version.
- **`typecheck` fails** → the new framework changed an API the game's call sites depend on (a
  breaking / major framework change). The affected files are almost always `src/main.ts` (which
  wires `GameLoop` / `ThreeRenderer` / `PointerKeyboardInput`) and `src/models.ts` (which uses
  `ModelSpec` / `ModelCatalog`). Show the exact `tsc` errors, explain the cause, and **offer to
  update those call sites** for the user (with Edit). Do not silently rewrite game logic — this
  is a human-in-the-loop step.

### Step 7.5: Point out new framework features that need one-time wiring

The re-sync copies `src/framework/` only — it never touches `src/main.ts`, so a framework version
that *adds* an opt-in subsystem lands the code but leaves it unwired. `typecheck` still passes
(nothing broke), so this is silent: the user has the feature and no way to tell.

If Step 3 reported files **added** (not just changed), check whether the game wires them, and
offer to do it:

| Added file | Needs in `main.ts` | Reference |
|------------|--------------------|-----------|
| `debug/Logger.ts`, `debug/LogOverlay.ts`, `debug/RemoteLogSink.ts`, `ui/ConsentGate.ts` | A `src/log.ts` module, `consoleSink()` + `captureGlobalErrors()`, the optional `?logview` overlay, and the consent gate before the title/audio `pinchTap` handlers. Also adds `logConsent*` keys to `src/i18n/en.json` and a `validate-console-logging.mjs` step to `npm run validate`. | `${CLAUDE_PLUGIN_ROOT}/docs/logging.md` and the template's own `src/main.ts` / `src/log.ts` |
| `ui/LoadingScreen.ts` | A manifest + `preloadManifest` behind the loading screen. | `${CLAUDE_PLUGIN_ROOT}/docs/loading-screen.md` |
| `debug/DriveHarness.ts` | A `stepSeconds` in the `LOOP` block of `src/config/gameplayConstants.ts`, passed to the `GameLoop` options; `installDriveHarness(loop)` *instead of* `loop.start()` when `driveModeRequested(search)`; and a `visibilitychange` handler that restarts the loop only if it was running when the tab was hidden, or a driven game un-pauses the first time the tab regains focus. | `${CLAUDE_PLUGIN_ROOT}/docs/query-parameters.md` |
| `sw/register.ts`, `sw/precache.ts`, `sw/service-worker.ts` | `void registerGameServiceWorker({ search });` early in `main()`. **Never awaited** — precaching benefits the next launch, so blocking startup on it worsens the metric it exists to improve. Also needs the build wiring in Step 7.6, without which the code ships but no `sw.js` is ever generated. | `${CLAUDE_PLUGIN_ROOT}/docs/offline-caching.md` |

One template change is **not** signalled by an added framework file, because it is a change to
`main.ts` itself and the re-sync never touches that. Offer it whenever the game lacks it:

| Missing from `main.ts` | Add | Reference |
|------------------------|-----|-----------|
| `window.__game` | `if (import.meta.env.DEV) { (window as unknown as { __game?: Game }).__game = game; }` after the `Game` is constructed. Lets `cdp.mjs eval` read game state directly instead of diffing screenshots. | `${CLAUDE_PLUGIN_ROOT}/docs/project-structure.md` |

Compare against the shipped template rather than writing wiring from scratch:

```bash
diff "${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/templates/src/main.ts" "$PROJECT/src/main.ts"
```

The game's `main.ts` has diverged by design, so **do not overwrite it** — port the missing pieces
with Edit, and confirm with the user first.

### Step 7.6: Offer the service-worker build wiring (the one tooling exception)

The service worker is the one framework subsystem that **cannot work from `src/framework/` alone**.
Its worker source is there, but the step that turns it into `dist/sw.js` is a Vite plugin under
`scripts/`, registered in `vite.config.ts` — both outside the re-sync's reach. A game that gets
`sw/` from Step 5 and nothing else compiles, passes its gate, and silently never emits a worker.

So this is the one place the skill offers to touch tooling. It is **opt-in**: detect, then use
**AskUserQuestion** before writing, and skip without comment if the game already has it.

Detect:

```bash
test -f "$PROJECT/scripts/vite-service-worker.mjs" && echo "plugin: present" || echo "plugin: MISSING"
grep -q 'serviceWorker()' "$PROJECT/vite.config.ts" && echo "config: wired" || echo "config: MISSING"
grep -q "resolve(swPath)" "$PROJECT/scripts/package-single-file.mjs" && echo "packager: ok" || echo "packager: MISSING"
```

If anything is `MISSING`, offer these four edits together — they are one feature, and applying a
subset leaves the game worse off than applying none:

1. **Copy the plugin.** `cp "${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/templates/scripts/vite-service-worker.mjs" "$PROJECT/scripts/"`
2. **Register it** in `vite.config.ts`: import `serviceWorker` from `./scripts/vite-service-worker.mjs`
   (with the same `@ts-expect-error` line the `audioSizes` import above it carries — the `.mjs`
   tooling is deliberately outside the typechecked tree) and add `serviceWorker()` to `plugins`.
3. **Refresh the packager.** `scripts/package-single-file.mjs` fails closed on any `dist/` file it
   did not inline, so an emitted `sw.js` breaks `npm run ship` for a procedural game. The current
   copy allows it. Diff the game's against the template's and port the change, or replace the file
   outright if the game has not edited it.
4. **Add the `main.ts` call** from the Step 7.5 table, if it is not already there.

The game's `vercel.json` needs **no change**: the `no-cache` header it already puts on everything
outside `_vite/` is exactly what keeps a stale `sw.js` from pinning an old build.

Afterwards, re-run the gate and confirm the worker is actually produced:

```bash
cd "$PROJECT" && npm run build && test -f dist/sw.js && echo "sw.js emitted"
```

### Step 8: Summarize

Report: files added / changed / removed, any new subsystem left to wire (Step 7.5), the version
now stamped in `src/framework/VERSION` and whether the `<meta name="generator">` marker was
inserted or updated, the gate result, and how to revert (git history, or the
`src/framework.bak-*` backup). Remind the user that `src/framework/` is managed — don't hand-edit
it; re-run this skill to update.

## Notes

- **Same-plugin path only.** The framework source lives inside this same plugin, so
  `${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/...` resolves at runtime. Never
  reach into a sibling plugin via `${CLAUDE_PLUGIN_ROOT}/../`.
- **The diff, not the version, is authoritative.** The plugin version can bump without any
  framework file changing; in that case Step 3 shows no differences and the skill reports
  "already up to date" (just re-stamping the version).
