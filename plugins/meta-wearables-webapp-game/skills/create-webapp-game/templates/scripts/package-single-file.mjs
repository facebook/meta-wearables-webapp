#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Turn a Vite build into a self-contained single-file bundle plus its two companion files.
 *
 * Usage: node scripts/package-single-file.mjs [distDir] [artifactJson]
 *
 * Emits `index.single.html` with every script and stylesheet inlined, alongside the two
 * root-level files a web app is still expected to serve separately — `manifest.webmanifest`
 * and `favicon.png` — and a `prototype-artifact.json` that lists all three with a combined
 * sha256. Three files with no relative asset fetches host anywhere and play offline.
 *
 * The packager deliberately fails closed. It supports procedural/data-URI games today;
 * any build file that was not consumed into index.html is rejected instead of shipping a
 * multi-file app that becomes a black screen when a host omits Content-Type headers.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';

const distDir = resolve(process.argv[2] ?? 'dist');
const artifactPath = resolve(
  process.argv[3] ?? join(distDir, 'prototype-artifact.json'),
);
const htmlPath = join(distDir, 'index.html');
const singlePath = join(distDir, 'index.single.html');
const manifestPath = join(distDir, 'manifest.webmanifest');
const iconPath = join(distDir, 'favicon.png');
const swPath = join(distDir, 'sw.js');
const MAX_BYTES = 8 * 1024 * 1024;
const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

function fail(message) {
  console.error(`[package-single-file] FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(htmlPath)) {
  fail(`no Vite build at ${htmlPath}; run npm run build first`);
}

const consumed = new Set([resolve(htmlPath)]);
let html = readFileSync(htmlPath, 'utf8');
const title = decodeEntities(
  html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1]?.trim() || 'Prototype',
);

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function localPath(url) {
  const clean = url.split(/[?#]/, 1)[0];
  if (!clean || /^(?:[a-z]+:|\/\/|#)/i.test(clean)) return null;
  const file = resolve(distDir, clean.replace(/^\.?\//, ''));
  const rel = relative(distDir, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? file : null;
}

function scriptSafe(source) {
  return source.replace(/<\/script/gi, '<\\/script');
}

function styleSafe(source) {
  return source.replace(/<\/style/gi, '<\\/style');
}

const deferredScripts = [];
html = html.replace(
  /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  (whole, attrs, body) => {
    const srcMatch = attrs.match(
      /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
    );
    if (!srcMatch) {
      deferredScripts.push(`<script${attrs.trim() ? ` ${attrs.trim()}` : ''}>${scriptSafe(body)}</script>`);
      return '';
    }
    const src = srcMatch[1] ?? srcMatch[2] ?? '';
    const file = localPath(src);
    if (!file || !existsSync(file)) {
      deferredScripts.push(whole);
      return '';
    }
    const inlineAttrs = attrs
      .replace(/\s*\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/i, '')
      .replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '')
      .trim();
    consumed.add(file);
    deferredScripts.push(
      `<script${inlineAttrs ? ` ${inlineAttrs}` : ''}>\n${scriptSafe(readFileSync(file, 'utf8'))}\n</script>`,
    );
    return '';
  },
);

html = html.replace(
  /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
  (whole, href) => {
    const file = localPath(href);
    if (!file || !existsSync(file)) return whole;
    consumed.add(file);
    return `<style>\n${styleSafe(readFileSync(file, 'utf8'))}\n</style>`;
  },
);

const icon = existingOrGeneratedIcon(title);
const iconData = icon.toString('base64');
html = html.replace(/<link\b[^>]*\brel=["'][^"']*icon[^"']*["'][^>]*>/gi, '');
html = insertBeforeHeadClose(
  html,
  `<link rel="icon" type="image/png" href="data:image/png;base64,${iconData}">`,
);
if (!/<link\b[^>]*\brel=["']manifest["']/i.test(html)) {
  html = insertBeforeHeadClose(
    html,
    '<link rel="manifest" href="manifest.webmanifest">',
  );
}

html = injectBootShell(html, title);
if (deferredScripts.length > 0) {
  const block = `${deferredScripts.join('\n')}\n`;
  html = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, () => `${block}</body>`)
    : `${html}${block}`;
}

verifyBootOrder(html);
verifyInlineScripts(html);
verifyNoExternalReferences(html);
verifyNoUnconsumedBuildFiles();

const manifest = `${JSON.stringify(
  {
    name: title,
    short_name: [...graphemeSegmenter.segment(title)]
      .slice(0, 24)
      .map(({segment}) => segment)
      .join(''),
    start_url: './',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [{src: 'favicon.png', sizes: '64x64', type: 'image/png'}],
  },
  null,
  2,
)}\n`;

const files = [
  {name: 'index.html', encoding: 'utf8', content: html},
  {name: 'favicon.png', encoding: 'base64', content: iconData},
  {name: 'manifest.webmanifest', encoding: 'utf8', content: manifest},
];
const bytes = Buffer.byteLength(html) + icon.length + Buffer.byteLength(manifest);
if (bytes > MAX_BYTES) fail(`artifact is ${bytes} bytes, over the ${MAX_BYTES}-byte ceiling`);

writeFileSync(singlePath, html);
writeFileSync(manifestPath, manifest);
writeFileSync(iconPath, icon);

const artifact = {
  schemaVersion: 1,
  files,
  bytes,
  sha256: createHash('sha256')
    .update(html)
    .update(icon)
    .update(manifest)
    .digest('hex'),
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(
  JSON.stringify({
    status: 'pass',
    artifactPath,
    singleHtmlPath: singlePath,
    bytes,
    sha256: artifact.sha256,
    files: files.map(file => file.name),
  }),
);

function insertBeforeHeadClose(source, tag) {
  return /<\/head>/i.test(source)
    ? source.replace(/<\/head>/i, () => `    ${tag}\n  </head>`)
    : `${tag}\n${source}`;
}

function injectBootShell(source, appTitle) {
  if (/data-prototype-boot/i.test(source)) return source;
  const safeTitle = appTitle.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const shell = `
    <style id="prototype-boot-style">
      #prototype-boot{position:fixed;inset:0;display:grid;place-items:center;background:#000;color:#61f4d8;font:600 22px/1.3 system-ui,sans-serif;letter-spacing:.04em;z-index:2147483647}
    </style>
    <div id="prototype-boot" data-prototype-boot>Loading ${safeTitle}…</div>
    <script>addEventListener('DOMContentLoaded',()=>requestAnimationFrame(()=>{document.getElementById('prototype-boot')?.remove();document.getElementById('prototype-boot-style')?.remove()}),{once:true})</script>
`;
  return /<body\b[^>]*>/i.test(source)
    ? source.replace(/<body\b[^>]*>/i, match => `${match}${shell}`)
    : `${shell}${source}`;
}

function verifyBootOrder(source) {
  const boot = source.search(/data-prototype-boot/i);
  const script = source.search(/<script\b/i);
  if (boot < 0) fail('no literal boot shell was emitted');
  if (script >= 0 && boot > script) {
    fail(`boot shell at byte ${boot} appears after the first script at byte ${script}`);
  }
}

function verifyInlineScripts(source) {
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const probeDir = mkdtempSync(join(tmpdir(), 'hn-single-file-'));
  try {
    scripts.forEach((match, index) => {
      const typeMatch = match[1].match(
        /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
      );
      const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? '').toLowerCase();
      if (['importmap', 'speculationrules', 'application/json', 'application/ld+json'].includes(type)) {
        return;
      }
      if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') {
        fail(`inline script ${index + 1} has unrecognized type ${JSON.stringify(type)}`);
      }
      const probe = join(probeDir, `script-${index}.${type === 'module' ? 'mjs' : 'cjs'}`);
      writeFileSync(probe, match[2].replace(/<\\\/script/gi, '</script'));
      const result = spawnSync(process.execPath, ['--check', probe], {encoding: 'utf8'});
      if (result.status !== 0) {
        const detail = (result.stderr || '')
          .split('\n')
          .slice(0, 5)
          .map(line => (line.length > 180 ? `${line.slice(0, 180)} …` : line))
          .join('\n');
        fail(`inline script ${index + 1} does not parse:\n${detail}`);
      }
    });
  } finally {
    rmSync(probeDir, {recursive: true, force: true});
  }
}

function verifyNoExternalReferences(source) {
  const refs = [];
  const htmlTags = source.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi,
    (_whole, open, close) => `${open}${close}`,
  );
  for (const match of htmlTags.matchAll(
    /<(script|link|img|source|audio|video|object|embed|image|use)\b[^>]*?\b(?:src|href|data|srcset|imagesrcset|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
  )) {
    const url = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!url || url.startsWith('data:') || url.startsWith('#')) continue;
    if (url === 'manifest.webmanifest' || url === './manifest.webmanifest') continue;
    refs.push(`<${match[1]}> ${url}`);
  }
  for (const style of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const match of style[1].matchAll(
      /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))/gi,
    )) {
      const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (url && !url.startsWith('data:')) refs.push(`css @import ${url}`);
    }
    for (const match of style[1].matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
      const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (url && !url.startsWith('data:') && !url.startsWith('#')) refs.push(`css url(${url})`);
    }
  }
  if (refs.length > 0) fail(`external references remain: ${refs.join(', ')}`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file));
    else if (entry.isFile()) out.push(resolve(file));
  }
  return out;
}

function verifyNoUnconsumedBuildFiles() {
  const generated = new Set([
    resolve(singlePath), resolve(manifestPath), resolve(iconPath), resolve(artifactPath),
    // The service worker is deliberately not inlined. The single-file artifact is self-contained
    // and fetches nothing, so it has nothing to precache; the multi-file dist/ it is built from
    // keeps its worker. Leaving it out of this check is what lets a procedural game still ship.
    resolve(swPath),
  ]);
  const leftovers = walkFiles(distDir).filter(
    file => !consumed.has(file) && !generated.has(file),
  );
  if (leftovers.length > 0) {
    fail(
      `build contains files that were not inlined: ${leftovers
        .map(file => relative(distDir, file))
        .join(', ')}; v1 packaging supports procedural/data-URI builds only`,
    );
  }
}

function existingOrGeneratedIcon(appTitle) {
  const existing = join(distDir, 'favicon.png');
  if (existsSync(existing)) {
    consumed.add(resolve(existing));
    const png = readFileSync(existing);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(signature) ||
      png.subarray(12, 16).toString() !== 'IHDR'
    ) {
      fail('favicon.png exists but is not a valid PNG');
    }
    if (png.readUInt32BE(16) <= 52 || png.readUInt32BE(20) <= 52) {
      fail('favicon.png must be larger than 52x52');
    }
    return png;
  }
  return generatePng(appTitle);
}

function generatePng(seedText) {
  const size = 64;
  const hash = createHash('sha256').update(seedText).digest();
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const band = ((x + y + hash[3]) >> 3) % 2;
      raw[offset] = edge < 4 ? 0 : Math.min(255, hash[0] / 3 + band * 25);
      raw[offset + 1] = edge < 4 ? 0 : 150 + (hash[1] % 90);
      raw[offset + 2] = edge < 4 ? 0 : 145 + (hash[2] % 100);
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, {level: 9})),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
