/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Drag-opt-in coherence detector for webapp games — the deterministic core behind
 * `validate-drag-optin.mjs`.
 *
 * The rule it enforces (see the plugin's docs/drag-channel.md): the EMG index pinch-and-MOVE
 * channel is opt-in, and opting in is THREE coordinated edits — `touch-action: none` in the CSS,
 * `{ pointerDrag: true }` on the input, and game code that actually consumes the movement delta.
 * Any two of the three without the third is a bug:
 *
 *   - flag + CSS, nothing consuming it — the classic one. It appears when someone turns the flag
 *     on so a desktop mouse CLICK produces a `pinchTap` while iterating in a browser. That is not
 *     what the flag is for: it opts the *device* into the pointer stream and moves the tap source
 *     off `Enter` onto that stream, so the game ships a different input contract to the glasses.
 *     `Enter` is the index pinch on the desktop exactly as it is on the device — press that.
 *   - flag without the CSS — the device never delivers the pointer stream, so the drag silently
 *     never fires (and the `Enter` select is being ignored in favour of a channel that is mute).
 *   - CSS without the flag — the stream arrives and no listener is wired, so it is dropped.
 *   - consumers without the flag — `consumeMovementDelta()` returns `{0, 0}` forever.
 *
 * It also enforces a fourth thing the three edits imply: a project `CLAUDE.md` that ASSERTS the
 * game is tap-only while the flag is on. That file is the first thing an agent reads, and the
 * claim sends it to `Enter` — the one key drag mode deliberately ignores — so it "tests" the game
 * with an input that can never register.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * Comments are blanked before matching (reusing `stripComments` from the layer-boundary scanner),
 * because every one of the words this looks for — `pointerDrag`, `touch-action: none`,
 * `consumeMovementDelta` — appears in the scaffold's own explanatory comments.
 *
 * Known limitations:
 *   - A tap-only game that leaves a dead `consumeMovementDelta()` call in `update()` reads as a
 *     drag consumer and passes. Whether a call does anything with its result is undecidable here.
 *   - A `pointerDrag` whose value is not a literal `true`/`false` is reported as `ambiguous` for
 *     an LLM to adjudicate rather than guessed at.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './layer-boundaries.mjs';

/** Code and style files. `.css`/`.html` carry the `touch-action` half of the contract. */
const TARGET_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
]);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const STYLE_EXTENSIONS = new Set(['.css', '.html']);

/** Build output and tooling state — never game source, at any depth. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.vite',
]);

/**
 * `public/` is copied verbatim into the build (and, in a game with remote logging, holds the
 * `/logs` portal — a separate page, not the game), `scripts/` is Node tooling, `api/` is
 * serverless handlers. None of them is game source.
 *
 * Matched against the project-relative path, not the bare name: a game's own `src/scripts/` or
 * `src/api/` IS game source, and skipping it by name would drop it from the scan silently.
 */
const SKIP_ROOT_DIRS = new Set(['public', 'scripts', 'api']);

const MAX_SNIPPET = 200;

/** Docs link every finding points at. */
export const RECIPE =
  'docs/drag-channel.md';

/** POSIX-style relative path for stable matching regardless of OS separators. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * The managed framework layer implements the input contract, so it names every symbol here —
 * `pointerDrag`, `consumeMovementDelta`, `pinchBegin`. Scanning it would match the definitions.
 */
export function isAllowlisted(relPath) {
  return /(^|\/)framework\//.test(toPosix(relPath));
}

/**
 * Test files are not game runtime code: a fake `InputManager` necessarily *implements*
 * `consumeMovementDelta`, which would read as a consumer. Mirrors the sibling scanners.
 */
export function isExcludedFile(relPath) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(toPosix(relPath));
}

export function isTargetFile(relPath) {
  return TARGET_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/** Recursively collect scannable files under `rootDir`, `rel` relative to `rootDir`. */
export function walk(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = toPosix(path.relative(rootDir, abs));
        if (!SKIP_DIRS.has(entry.name) && !SKIP_ROOT_DIRS.has(relDir)) {
          stack.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const rel = path.relative(rootDir, abs);
      if (!isTargetFile(rel) || isAllowlisted(rel) || isExcludedFile(rel)) {
        continue;
      }
      results.push({ abs, rel: toPosix(rel) });
    }
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

function truncate(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

/** 1-based line number of `index` within `text`. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/** Blank `<!-- ... -->` so an HTML comment can't supply a `touch-action` match. */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

/**
 * Read the balanced-paren argument text of a call that starts at `open` (the index of its `(`).
 * Returns `null` if the parens never close. Quote state is tracked so a `)` inside a string
 * literal doesn't close the call early.
 */
export function readCallArgs(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  return null;
}

const CONSTRUCTION_RE = /\bnew\s+PointerKeyboardInput\s*\(/g;
const POINTER_DRAG_RE = /\bpointerDrag\s*:\s*([^,}\s]+)/;

const POINTER_DRAG_SHORTHAND_RE = /\bpointerDrag\s*(?=[,}]|$)/;
const OPTIONS_SPREAD_RE = /\.\.\./;

/**
 * The two ways the option can be present without a readable value: ES2015 shorthand
 * (`{ pointerDrag }`) and a spread that may carry the key in from elsewhere (`{ ...defaults }`).
 * Both are `ambiguous`, not the `false` default — the key IS being set, just not visibly here.
 *
 * Only the top level of the options object counts, and string literals are skipped: a `...` inside
 * `{ ariaLabel: 'Press ...' }` and a `pointerDrag` inside a nested object are not this call's
 * option, and reporting them as ambiguous would train the reader to ignore the finding.
 */
export function hasUnreadablePointerDrag(args) {
  let depth = 0;
  let quote = null;
  let top = '';
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (quote !== null) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      if (depth === 1) {
        continue; // the options object's own opening brace
      }
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
    }
    if (depth === 1) {
      top += char;
    }
  }
  return OPTIONS_SPREAD_RE.test(top) || POINTER_DRAG_SHORTHAND_RE.test(top);
}

/**
 * Every `new PointerKeyboardInput(...)` in `text`, with the literal value of its `pointerDrag`
 * option: `true`, `false` (including "the key is absent", which is the documented default), or
 * `'ambiguous'` when the value is not a boolean literal.
 */
export function findConstructions(text, relPath) {
  const stripped = stripComments(text);
  const found = [];
  for (const match of stripped.matchAll(CONSTRUCTION_RE)) {
    const open = match.index + match[0].length - 1;
    const args = readCallArgs(stripped, open);
    const option = args === null ? null : POINTER_DRAG_RE.exec(args);
    const hidden = args !== null && option === null && hasUnreadablePointerDrag(args);
    let value;
    if (hidden) {
      value = 'ambiguous';
    } else if (!option) {
      value = false; // no `pointerDrag` key at all — the framework default
    } else if (option[1] === 'true') {
      value = true;
    } else if (option[1] === 'false') {
      value = false;
    } else {
      value = 'ambiguous';
    }
    // Anchor on the `pointerDrag` option itself when there is one — that is the line to edit.
    const anchor = option ? open + 1 + option.index : match.index;
    found.push({
      file: relPath,
      line: lineAt(stripped, anchor),
      value,
      snippet: truncate(option ? option[0] : match[0]),
    });
  }
  return found;
}

const TOUCH_ACTION_RE = /touch-action\s*:\s*none/i;

/** Every `touch-action: none` declaration in a stylesheet or an HTML page. */
export function findTouchAction(text, relPath) {
  const stripped = stripComments(stripHtmlComments(text));
  const found = [];
  const lines = stripped.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (TOUCH_ACTION_RE.test(line)) {
      found.push({ file: relPath, line: index + 1, snippet: truncate(line) });
    }
  }
  return found;
}

/** Uses of the drag channel. Any one of these means the game reads the pinch-and-move stream. */
const CONSUMER_RES = [
  { re: /\bconsumeMovementDelta\s*\(/, what: 'consumeMovementDelta()' },
  { re: /\bisPinchActive\s*\(/, what: 'isPinchActive()' },
  { re: /['"]pinchBegin['"]/, what: "'pinchBegin'" },
  { re: /['"]pinchEnd['"]/, what: "'pinchEnd'" },
];

/** Every place game code consumes the drag channel. */
export function findConsumers(text, relPath) {
  const stripped = stripComments(text);
  const found = [];
  const lines = stripped.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const { re, what } of CONSUMER_RES) {
      if (re.test(line)) {
        found.push({
          file: relPath,
          line: index + 1,
          what,
          snippet: truncate(line),
        });
      }
    }
  }
  return found;
}

/** The project's LLM-orientation file, read from the project root and nowhere else. */
const ORIENTATION_FILE = 'CLAUDE.md';

/**
 * Assertions that the game is tap-only.
 *
 * These are anchored on the ASSERTION form, never on the bare words `tap-only` or `Enter`,
 * because a correct `CLAUDE.md` describes BOTH modes in prose — "In tap-only, the pinch is
 * `Enter` … In drag mode the pinch is a click" — and a substring search would fail every game
 * that documents the input model properly.
 */
const TAP_ONLY_CLAIM_RES = [
  {
    // The subject (`this game`) is what makes it a claim about THIS project rather than a
    // description of the tap-only mode in general.
    re: /\bthis\s+(?:game|app|project)\s+is\s+tap[-\s]?only\b/gi,
    scopable: false,
  },
  {
    // The imperative the claim leads to. Optional backticks around `Enter`; the negation is
    // spelled `don't`, `do not` or a bare `not`. It carries no subject of its own, so it is the
    // one pattern a tap-only naming clause can disown.
    re: /\bpress\s+`?Enter`?\s*,?\s*(?:don[’']?t|do\s+not|not)\s+click\b/gi,
    scopable: true,
  },
];

/** A clause scoping the sentence to tap-only. The imperative then describes that mode. */
const TAP_ONLY_SCOPE_RE = /\b(?:in\s+(?:the\s+)?tap[-\s]?only|tap[-\s]?only\s+mode)\b/i;

/** A clause naming drag mode anywhere earlier in the sentence. */
const DRAG_SCOPE_RE = /\b(?:in\s+(?:the\s+)?drag|drag\s+mode)\b/i;

/** A drag clause that runs straight into the imperative, with only a comma between. */
const DRAG_LEAD_IN_RE = /\b(?:in\s+(?:the\s+)?drag(?:\s+mode)?|drag\s+mode)\s*,?\s*$/i;

/**
 * Whether a mode-naming clause earlier in the sentence disowns the imperative that follows.
 *
 * A tap-only clause always does: the imperative IS the tap-only instruction, so a sentence
 * scoped to tap-only is describing the mode, not asserting anything about this game.
 *
 * A drag clause usually does too — a correct `CLAUDE.md` documents both modes, and
 * "In drag mode the pinch is a click instead, so press `Enter` not click applies only to the
 * other mode" is right prose. But a drag clause running straight into the imperative attributes
 * it to drag mode — "In drag mode, press `Enter`, don't click." — which is wrong whatever this
 * game's mode is, because it tells the reader to press the key drag mode ignores. Disowning that
 * would suppress a real defect, so it does not count as scope.
 */
function claimIsScoped(precedingText) {
  if (TAP_ONLY_SCOPE_RE.test(precedingText)) {
    return true;
  }
  return DRAG_SCOPE_RE.test(precedingText) && !DRAG_LEAD_IN_RE.test(precedingText);
}

/** The start of the line `index` falls on. */
function lineStart(text, index) {
  const nl = text.lastIndexOf('\n', index - 1);
  return nl + 1;
}

/**
 * The start of the sentence `index` falls in, bounded by the enclosing paragraph.
 *
 * Markdown prose wraps, so the clause that scopes an imperative routinely sits on the line above
 * it — "In tap-only mode,\npress `Enter`, don't click." A line-local search would miss that
 * antecedent and flag a correctly documented `CLAUDE.md`.
 */
function sentenceStart(text, index) {
  const prefix = text.slice(0, index);
  let paragraph = 0;
  for (const match of prefix.matchAll(/\n[ \t]*\r?\n/g)) {
    paragraph = match.index + match[0].length;
  }
  let sentence = 0;
  for (const match of prefix.slice(paragraph).matchAll(/[.!?]["'`)\]]*\s+/g)) {
    sentence = match.index + match[0].length;
  }
  return paragraph + sentence;
}

/** The full source line `index` falls on, for reporting. */
function lineTextAt(text, index) {
  const end = text.indexOf('\n', index);
  return text.slice(lineStart(text, index), end === -1 ? text.length : end);
}

/**
 * Assertions in `<rootDir>/CLAUDE.md` that the game is tap-only. Empty when the project has no
 * such file, which many do not.
 *
 * One finding per line: the claim and the imperative it leads to are usually the same sentence,
 * and reporting the same line twice reads as two separate problems.
 */
export function findTapOnlyClaims(rootDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(rootDir, ORIENTATION_FILE), 'utf8');
  } catch (err) {
    // Most projects have no CLAUDE.md. Anything else — a directory, a permission error — would
    // otherwise read as "no claims" and pass the very check that exists to catch silent drift.
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return [];
  }
  const byLine = new Map();
  for (const { re, scopable } of TAP_ONLY_CLAIM_RES) {
    for (const match of text.matchAll(re)) {
      if (
        scopable &&
        claimIsScoped(text.slice(sentenceStart(text, match.index), match.index))
      ) {
        continue;
      }
      const line = lineAt(text, match.index);
      if (!byLine.has(line)) {
        byLine.set(line, {
          file: ORIENTATION_FILE,
          line,
          snippet: truncate(lineTextAt(text, match.index)),
        });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Scan a whole project. Returns the three facts, the violations they imply, anything ambiguous,
 * and human-readable notes for the cases that are deliberately not failures.
 */
export function scanProject(rootDir) {
  const files = walk(rootDir);
  const constructions = [];
  const touchAction = [];
  const consumers = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    const ext = path.extname(file.rel).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      constructions.push(...findConstructions(text, file.rel));
      consumers.push(...findConsumers(text, file.rel));
    }
    if (STYLE_EXTENSIONS.has(ext)) {
      touchAction.push(...findTouchAction(text, file.rel));
    }
  }

  const violations = [];
  const ambiguous = [];
  const notes = [];

  const undecided = constructions.filter((c) => c.value === 'ambiguous');
  for (const construction of undecided) {
    ambiguous.push({
      file: construction.file,
      line: construction.line,
      reason: `\`pointerDrag\` is not a boolean literal, so the drag mode can't be decided statically — confirm it matches the CSS and the game's use of the delta (${RECIPE})`,
      snippet: construction.snippet,
    });
  }

  const dragEnabled = constructions.some((c) => c.value === true);
  const touchActionNone = touchAction.length > 0;
  const dragConsumed = consumers.length > 0;

  if (constructions.length === 0) {
    notes.push(
      'No `new PointerKeyboardInput(...)` found — this project builds its own `InputManager`, so the drag opt-in cannot be checked.',
    );
    return {
      pass: true,
      filesScanned: files.length,
      dragEnabled: false,
      touchActionNone,
      dragConsumed,
      constructions,
      touchAction,
      consumers,
      violations,
      ambiguous,
      notes,
    };
  }

  const enabledAt = constructions.filter((c) => c.value === true);
  const anchor = (enabledAt[0] ?? constructions[0]);

  if (dragEnabled && !dragConsumed) {
    violations.push({
      file: anchor.file,
      line: anchor.line,
      reason: `\`pointerDrag: true\` but no game code consumes the drag channel (no consumeMovementDelta() / isPinchActive() / 'pinchBegin' / 'pinchEnd'). The index SELECT arrives as \`Enter\` -> \`pinchTap\` WITHOUT this flag, on the glasses and in a desktop browser alike — never enable it so a desktop mouse click selects; press Enter. Remove the flag and \`touch-action: none\`, or use the movement delta (${RECIPE})`,
      snippet: anchor.snippet,
    });
  }

  if (dragEnabled && !touchActionNone) {
    violations.push({
      file: anchor.file,
      line: anchor.line,
      reason: `\`pointerDrag: true\` but no \`touch-action: none\` in the CSS — without it the device never delivers the pointer stream, so the drag never fires AND the redundant \`Enter\` select is being ignored. Add the CSS rule or drop the flag (${RECIPE})`,
      snippet: anchor.snippet,
    });
  }

  if (dragEnabled) {
    for (const claim of findTapOnlyClaims(rootDir)) {
      violations.push({
        file: claim.file,
        line: claim.line,
        reason: `\`${ORIENTATION_FILE}\` asserts the game is tap-only, but this game is in drag mode (\`pointerDrag: true\`), so the index pinch is a mouse CLICK and \`Enter\` is deliberately ignored. This is the first file an agent reads, so the claim sends it to press a key the framework drops, and it reads the unchanged frame as the game working. Derive the mode instead of asserting it — the scaffold's text says to run \`node scripts/validate-drag-optin.mjs\`, which prints \`mode: tap-only\` or \`mode: drag (opted in)\` — or turn the drag flag off (${RECIPE})`,
        snippet: claim.snippet,
      });
    }
  }

  if (!dragEnabled && touchActionNone && undecided.length === 0) {
    const site = touchAction[0];
    violations.push({
      file: site.file,
      line: site.line,
      reason: `\`touch-action: none\` without \`pointerDrag: true\` — the device delivers the pinch-and-move pointer stream and nothing listens to it. Add the flag if a drag drives gameplay, otherwise remove this rule (${RECIPE})`,
      snippet: site.snippet,
    });
  }

  if (!dragEnabled && dragConsumed && undecided.length === 0) {
    const site = consumers[0];
    violations.push({
      file: site.file,
      line: site.line,
      reason: `uses the drag channel (${site.what}) but \`pointerDrag\` is off, so the movement delta is always {0, 0}. Opt in, or drive this from \`dpadSwipe\` / \`pinchTap\` instead (${RECIPE})`,
      snippet: site.snippet,
    });
  }

  return {
    pass: violations.length === 0,
    filesScanned: files.length,
    dragEnabled,
    touchActionNone,
    dragConsumed,
    constructions,
    touchAction,
    consumers,
    violations,
    ambiguous,
    notes,
  };
}
