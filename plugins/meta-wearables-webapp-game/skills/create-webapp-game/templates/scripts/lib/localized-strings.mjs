/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Localized-string detector for webapp games — the deterministic core shared by
 * `validate-localized-strings.mjs`.
 *
 * The rule it enforces (see the plugin's docs/localization.md): all USER-FACING text must flow
 * through i18next — `t('key')` for dynamic text in TS/JS, `data-i18n="key"` for static text in
 * HTML. Hardcoded human-readable copy written straight into the DOM defeats localization.
 *
 * What it flags:
 *   - JS/TS: a string literal *containing letters* assigned to `.textContent` / `.innerText` /
 *     `.innerHTML` / `document.title`, or passed to `insertAdjacentText` / `insertAdjacentHTML`,
 *     outside the allowlist. Text wrapped in `t(...)`, bare numbers (`String(score)`), symbol-only
 *     glyphs, and the `insertAdjacent*` position keyword are NOT flagged.
 *   - HTML: an element with human-readable text but no `data-i18n` attribute, or a user-facing
 *     attribute (`title` / `alt` / `placeholder` / `aria-label`) whose value contains letters —
 *     reported as `ambiguous` for an LLM to adjudicate (a line-based scan can't reliably tell copy
 *     from markup, and the framework's `data-i18n` applier localizes text only, not attributes).
 *
 * Allowlisted (never scanned): `src/i18n/` (defines the strings), `src/framework/` (managed engine
 * code, incl. the i18n wrapper and the non-localized `?stats` overlay), test files, and `scripts/`.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * Known limitations: detection is regex/line based. HTML `<!-- … -->` comments are stripped before
 * scanning, but JS/TS comments are not, so a match inside one (or spread across a multi-line
 * expression) may be mis-reported. Because the scan can't do scope analysis, it trusts any
 * `t(...)` / `i18next.t(...)` as a translation call — a shadowed `t` (e.g. `arr.map((t) => t('x'))`)
 * can therefore mask a real hardcoded string; name your locale helper `t` and don't shadow it.
 * Element-property attribute setters in JS (`el.title = …`, `el.setAttribute('title', …)`) are
 * deliberately NOT scanned — `.title`/`.alt` collide with ordinary data-model fields, so flagging
 * them line-by-line would be too noisy; localize those via `t()`. Definite cases surface as
 * `violations`; genuinely undecidable ones surface as `ambiguous` for review.
 */

import fs from 'node:fs';
import path from 'node:path';

/** DOM sinks whose assigned value is rendered as user-facing text (plain or compound assignment). */
const TEXT_SINK_ASSIGN_RE = /\.(textContent|innerText|innerHTML)\s*(?:\+|\?\?|\|\||&&)?=(?!=)\s*(.*)$/;
/** `document.title` assignment — the browser title bar, a user-facing string. */
const DOCUMENT_TITLE_ASSIGN_RE = /\bdocument\.title\s*(?:\+|\?\?|\|\||&&)?=(?!=)\s*(.*)$/;
/** DOM insertion calls whose content argument is rendered as user-facing text. */
const INSERT_ADJACENT_RE = /\.(insertAdjacentText|insertAdjacentHTML)\s*\((.*)$/;
/** Opening tag with same-line text content, e.g. `<div class="x">Hello<`. */
const HTML_TEXT_RE = /<([a-zA-Z][\w-]*)((?:[^<>]*?))>([^<>]*)</g;
/** User-facing HTML attributes (tooltip, alt text, placeholder, a11y label); whitespace-anchored so
 *  it never matches a data-* prefixed variant like `data-title`. */
const HTML_ATTR_RE = /(?:^|\s)(title|alt|placeholder|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** `insertAdjacent*` position keywords — legitimate literals, never user copy. */
const INSERT_POSITIONS = new Set([
  'beforebegin',
  'afterbegin',
  'beforeend',
  'afterend',
]);

const TARGET_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

// `public/` is copied verbatim into the build: static assets, plus (with the add-webapp-game-logging
// skill) the developer log portal. That is tooling and build output, never game source.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.vite',
  'public',
]);

/** Basenames of this validator's own tooling — excluded so it never flags its own examples. */
const SELF_FILES = new Set([
  'validate-localized-strings.mjs',
  'localized-strings.mjs',
]);

const MAX_SNIPPET = 200;

/** POSIX-style relative path for stable matching regardless of OS separators. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * Files exempt from the rule: the i18n resources/bootstrap, all managed framework code, test
 * files, and tooling under `scripts/`.
 */
export function isAllowlisted(relPath) {
  const posix = toPosix(relPath);
  return (
    /^src\/i18n\//.test(posix) ||
    /^src\/framework\//.test(posix) ||
    /^scripts\//.test(posix)
  );
}

function isExcludedFile(relPath) {
  const posix = toPosix(relPath);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posix)) {
    return true;
  }
  return SELF_FILES.has(path.basename(posix));
}

export function isTargetFile(relPath) {
  return TARGET_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function isHtml(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

/**
 * Recursively collect scannable files under `rootDir`. Returns objects with the absolute path and
 * the path relative to `rootDir`. Skips build/vendor dirs, the allowlisted areas, test files, and
 * this validator's own scripts.
 */
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
        if (!SKIP_DIRS.has(entry.name)) {
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
  return trimmed.length > MAX_SNIPPET
    ? `${trimmed.slice(0, MAX_SNIPPET)}…`
    : trimmed;
}

/** Strip HTML entities (`&nbsp;`, `&#9650;`, …) so decorative-only text isn't mistaken for copy. */
function stripEntities(text) {
  return text.replace(/&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;/g, '');
}

/**
 * Blank out `<!-- … -->` comment regions (including multi-line and unterminated ones) with spaces,
 * preserving newlines so line/column numbers of the surviving markup stay accurate. Commented-out
 * markup is not rendered, so it must not be reported as hardcoded copy.
 */
function blankHtmlComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<!--[\s\S]*$/, blank);
}

function hasLetter(text) {
  return /\p{L}/u.test(text);
}

/**
 * True when an expression assigns/inserts hardcoded human text — a string or template literal with
 * letters that is NOT inside a `t(...)` translation call or an `insertAdjacent*` position keyword.
 *
 * Scans character by character (rather than one regex) so it tracks parenthesis depth and can tell
 * a literal that sits inside a `t(...)` call — at any nesting depth, e.g. `t('key', format('x'))` —
 * from one outside it.
 */
function hasHardcodedText(expr) {
  // Drop template-literal interpolations first — only the static parts are hardcoded copy.
  const s = expr.replace(/\$\{[^}]*\}/g, ' ');
  const parenIsTranslation = [];
  let translationDepth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let content = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === ch) {
          closed = true;
          break;
        }
        content += s[j];
        j += 1;
      }
      // Only a properly terminated literal counts — an unterminated quote is almost always a
      // line-based artifact (e.g. an inline-code backtick in a comment), not real copy.
      if (closed && translationDepth === 0 && !INSERT_POSITIONS.has(content) && hasLetter(content)) {
        return true;
      }
      i = closed ? j + 1 : j;
      continue;
    }
    if (ch === '(') {
      // A `(` opens a translation call when preceded by a bare `t` or `i18next.t`.
      const isTranslation = /(?:^|[^.\w])(?:i18next\.)?t\s*$/.test(s.slice(0, i));
      parenIsTranslation.push(isTranslation);
      if (isTranslation) {
        translationDepth += 1;
      }
    } else if (ch === ')') {
      if (parenIsTranslation.pop()) {
        translationDepth -= 1;
      }
    }
    i += 1;
  }
  return false;
}

/**
 * Scan a single file's `text`. `relPath` selects HTML-vs-JS rules and the `file` field on findings.
 * Returns `{ violations, ambiguous }`, each an array of `{ file, line, snippet, reason }`.
 */
export function scanContent(text, relPath) {
  const violations = [];
  const ambiguous = [];
  const file = toPosix(relPath);
  const html = isHtml(relPath);
  const lines = (html ? blankHtmlComments(text) : text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const snippet = truncate(line);

    if (html) {
      for (const m of line.matchAll(HTML_TEXT_RE)) {
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        const inner = m[3];
        if (tag === 'script' || tag === 'style') {
          continue;
        }
        // Match the exact `data-i18n` attribute only. `\b` treats `-` as a boundary, so a plain
        // word-boundary check also matches `data-i18n-key`, which `applyStaticTranslations` (it
        // reads `el.dataset.i18n`) does NOT localize — that would wrongly skip the element.
        if (/(?:^|\s)data-i18n\s*=/.test(attrs)) {
          continue;
        }
        if (!hasLetter(stripEntities(inner))) {
          continue;
        }
        ambiguous.push({
          file,
          line: lineNo,
          snippet,
          reason: `<${tag}> has text with no data-i18n attribute — is it user-facing copy?`,
        });
      }
      for (const m of line.matchAll(HTML_ATTR_RE)) {
        const attr = m[1].toLowerCase();
        const value = m[2] ?? m[3] ?? '';
        if (!hasLetter(stripEntities(value))) {
          continue;
        }
        ambiguous.push({
          file,
          line: lineNo,
          snippet,
          reason: `${attr}="…" may be user-facing copy — set it from JS via t('key') (data-i18n localizes text only, not attributes)`,
        });
      }
      continue;
    }

    const assign = line.match(TEXT_SINK_ASSIGN_RE);
    if (assign && hasHardcodedText(assign[2])) {
      violations.push({
        file,
        line: lineNo,
        snippet,
        reason: `hardcoded text assigned to .${assign[1]} — use t('key') from @/i18n`,
      });
    }

    const insert = line.match(INSERT_ADJACENT_RE);
    if (insert && hasHardcodedText(insert[2])) {
      violations.push({
        file,
        line: lineNo,
        snippet,
        reason: `hardcoded text passed to .${insert[1]}(…) — use t('key') from @/i18n`,
      });
    }

    const docTitle = line.match(DOCUMENT_TITLE_ASSIGN_RE);
    if (docTitle && hasHardcodedText(docTitle[1])) {
      violations.push({
        file,
        line: lineNo,
        snippet,
        reason: "hardcoded text assigned to document.title — use t('key') from @/i18n",
      });
    }
  }

  return { violations, ambiguous };
}

/**
 * Walk and scan an entire project directory. Returns `{ filesScanned, violations, ambiguous }`.
 */
export function scanProject(rootDir) {
  const files = walk(rootDir);
  const violations = [];
  const ambiguous = [];
  for (const { abs, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const result = scanContent(text, rel);
    violations.push(...result.violations);
    ambiguous.push(...result.ambiguous);
  }
  return { filesScanned: files.length, violations, ambiguous };
}
