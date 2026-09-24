#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createGzip} from 'node:zlib';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {createServer} from 'node:net';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Writable} from 'node:stream';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(process.argv[2] ?? '.');
const artifactsArg = optionValue('--artifacts-dir');
const staticOnly = process.argv.includes('--static-only');
const artifactsDirectory = resolve(artifactsArg ?? join(appDirectory, '.wearables-test'));
const failures = [];
const warnings = [];
let sharp;
let chromium;
let firefox;
const npmCommand = 'npm';
const packageManagerShell = process.platform === 'win32';

if (!existsSync(join(appDirectory, 'package.json'))) fail(`Missing package.json in ${appDirectory}`);
if (!existsSync(join(appDirectory, 'index.html'))) fail(`Missing index.html in ${appDirectory}`);
if (!existsSync(join(appDirectory, 'src'))) fail(`Missing src directory in ${appDirectory}`);
if (failures.length) finish();

const packageJson = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8'));
const configPath = join(appDirectory, 'wearables.config.json');
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : {ui: 'meta-ray-ban-display-ui-toolkit'};
const html = readFileSync(join(appDirectory, 'index.html'), 'utf8');
const sourceFiles = collectFiles(join(appDirectory, 'src'), file => /\.(?:ts|tsx|js|jsx|css)$/.test(file));
const source = sourceFiles.map(file => readFileSync(file, 'utf8')).join('\n');
const cssSource = sourceFiles.filter(file => extname(file) === '.css').map(file => readFileSync(file, 'utf8')).join('\n');

validateMetadata();
validateProjectShape();
validateSource();
if (failures.length) finish();
if (config.ui === 'meta-ray-ban-display-ui-toolkit') validateToolkitStructure();
if (failures.length) finish();

if (dependenciesAreInstalled()) {
  console.log('Application dependencies are already installed; skipping npm install.');
} else {
  run(npmCommand, ['ci', '--no-audit', '--no-fund'], appDirectory, 'locked dependency installation');
}
if (failures.length) finish();
run(npmCommand, ['run', 'typecheck'], appDirectory, 'typecheck');
if (failures.length) finish();
run(npmCommand, ['run', 'build'], appDirectory, 'production build');
if (failures.length) finish();

const bundleBytes = await gzipJavaScript(join(appDirectory, 'dist'));
if (bundleBytes >= 300 * 1024) {
  fail(`JavaScript alone is ${formatBytes(bundleBytes)} gzipped; the total first-load transfer budget is under 300 KB`);
}
if (staticOnly) finish(null, bundleBytes);

await loadBrowserDependencies();
if (failures.length) finish(null, bundleBytes);
mkdirSync(artifactsDirectory, {recursive: true});
const browserResult = await runBrowserChecks();
if (failures.length) finish(browserResult, bundleBytes);

finish(browserResult, bundleBytes);

function validateMetadata() {
  const viewportTag = html.match(/<meta\s+[^>]*name=["']viewport["'][^>]*>/i)?.[0] ?? '';
  const viewport = viewportTag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? '';
  if (!/\bwidth\s*=\s*device-width\b/i.test(viewport)
      || !/\binitial-scale\s*=\s*1(?:\.0+)?\b/i.test(viewport)) {
    fail('Viewport metadata must declare width=device-width and initial-scale=1');
  }
  const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1]?.trim();
  if (!description || /A web app for Meta Ray-Ban Display glasses/i.test(description)) {
    fail('Replace the placeholder meta description with app-specific copy');
  }
  if (!/<meta\s+name=["']mrbd-web-app-capable["']\s+content=["']yes["']/i.test(html)) {
    fail('Missing <meta name="mrbd-web-app-capable" content="yes">');
  }
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  if (!title || title === 'Meta Wearables App') fail('Replace the placeholder document title');
}

function validateProjectShape() {
  for (const script of ['typecheck', 'build', 'preview']) {
    if (!packageJson.scripts?.[script]) fail(`package.json is missing the ${script} script`);
  }
  if (!existsSync(join(appDirectory, 'package-lock.json'))) {
    fail('package-lock.json is required for a reproducible npm build; run the UI installer or npm install and commit the lockfile');
  }
  if (existsSync(join(appDirectory, 'server.js'))) fail('server.js is unsupported; deploy the Vite static build directly');
  const vite = readFileSync(join(appDirectory, 'vite.config.ts'), 'utf8');
  if (/resolve\s*:\s*\{[\s\S]*alias/.test(vite) && /(?:@meta\/wearables-ui-toolkit|@wearables-ui-toolkit\/)/.test(vite)) {
    fail('vite.config.ts aliases UI Toolkit to source; consume package exports instead');
  }
  if (config.ui === 'meta-ray-ban-display-ui-toolkit') {
    for (const name of [
      '@wearables-ui-toolkit/mrbd',
      '@wearables-ui-toolkit/icons',
    ]) {
      const specifier = packageJson.dependencies?.[name];
      if (!specifier) {
        fail(`Missing UI Toolkit dependency ${name}`);
        continue;
      }
      if (!isRegistryDependencySpecifier(specifier)) {
        fail(`${name} must use an npm registry version or range, not a local path, URL, workspace, or Git dependency`);
      }
    }
    for (const legacy of [
      '@meta/wearables-ui-toolkit-androidx-shapes',
      '@meta/wearables-ui-toolkit-foundation',
      '@meta/wearables-ui-toolkit-icons',
      '@meta/wearables-ui-toolkit-mrbd',
    ]) {
      if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
        .some(field => packageJson[field]?.[legacy])) {
        fail(`Remove legacy UI Toolkit dependency ${legacy}; use the @wearables-ui-toolkit scope`);
      }
    }
  } else if (config.ui !== 'custom-explicit-opt-out') {
    fail(`Unknown wearables.config.json ui mode: ${config.ui}`);
  }
}

function validateSource() {
  if (config.ui === 'meta-ray-ban-display-ui-toolkit') validateResponsiveCanvasCss();
  else validateFixedCanvasCss();
  if (config.ui === 'meta-ray-ban-display-ui-toolkit') {
    if (!/from\s+["']@wearables-ui-toolkit\/mrbd(?:\/[A-Za-z0-9._-]+)?["']/.test(source)) {
      fail('Application does not import UI Toolkit public components');
    }
    if (/@wearables-ui-toolkit\/mrbd\/styles\.css/.test(source)) {
      fail('Do not import the toolkit stylesheet manually; App loads it automatically');
    }
    if (!/<(?:WearablesApp|ToolkitApp|UitApp|App)\b/.test(source)) {
      fail('Application must render inside the UI Toolkit App component');
    }
    if (/from\s+["'][^"']*wearables-ui-toolkit[^"']*\/src[^"']*["']/.test(source)) {
      fail('Application imports UI Toolkit implementation source');
    }
    if (/@meta\/wearables-ui-web/.test(source)) {
      fail('Application still imports the retired Wearables UI package');
    }
    if (/@meta\/wearables-ui-toolkit-/.test(source)) {
      fail('Application still imports a legacy @meta/wearables-ui-toolkit-* package');
    }
    if (/#[0-9a-f]{3,8}\b|rgba?\s*\(/i.test(source.replace(/\.no-wui\.[^\n]+/g, ''))) {
      warnings.push('Authored source contains literal colors; verify they are limited to intrinsic canvas/media content');
    }
  }
  if (/requestPointerLock\s*\(/.test(source)) fail('Pointer Lock is unsupported on Meta Display Glasses');
  if (/setInterval\s*\(/.test(source) && !/(clearInterval|visibilitychange)/.test(source)) {
    fail('setInterval is used without visible cleanup');
  }
  if (/watchPosition\s*\(/.test(source) && !/clearWatch\s*\(/.test(source)) fail('Geolocation watch is not cleared');
  if (/addEventListener\s*\(\s*["'](?:devicemotion|deviceorientation)/.test(source)
      && !/removeEventListener\s*\(\s*["'](?:devicemotion|deviceorientation)/.test(source)) {
    fail('Sensor event listeners are not removed');
  }
}

function validateResponsiveCanvasCss() {
  for (const selector of ['html', 'body', '#root']) {
    const declarations = declarationsForSelector(selector);
    if (!/(?:^|;)\s*(?:width|inline-size)\s*:\s*100%\s*(?:;|$)/i.test(declarations)
        || !/(?:^|;)\s*(?:height|block-size)\s*:\s*100%\s*(?:;|$)/i.test(declarations)) {
      fail(`${selector} must fill the available viewport with 100% width and height`);
    }
    if (/(?:^|;)\s*(?:min-|max-)?(?:width|height|inline-size|block-size)\s*:\s*600px\s*(?:;|$)/i.test(declarations)) {
      fail(`${selector} must not hardcode the 600px device dimensions`);
    }
  }
}

function validateFixedCanvasCss() {
  const rootRule = declarationsForSelector('#root');
  if (!/(?:^|;)\s*(?:width|inline-size)\s*:\s*600px\s*(?:;|$)/i.test(rootRule)
      || !/(?:^|;)\s*(?:height|block-size)\s*:\s*600px\s*(?:;|$)/i.test(rootRule)) {
    fail('#root must declare explicit width: 600px and height: 600px');
  }
  if (/(?:width|inline-size|height|block-size)\s*:\s*(?:100%|100v[wh])/i.test(rootRule)) {
    fail('#root must not scale with percentages or viewport units');
  }
  const bodyRules = declarationsForSelector('body');
  if (!/display\s*:\s*grid/i.test(bodyRules) || !/place-items\s*:\s*center/i.test(bodyRules)) {
    fail('body must center the fixed 600x600 #root canvas in larger desktop windows');
  }
}

function declarationsForSelector(selector) {
  const declarations = [];
  for (const match of cssSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(value => value.trim());
    if (selectors.includes(selector)) declarations.push(match[2]);
  }
  return declarations.join(';');
}

function validateToolkitStructure() {
  const validator = join(scriptDirectory, 'validate-ui-toolkit.mjs');
  if (!existsSync(validator)) {
    fail(`Missing UI Toolkit structure-validation wrapper: ${validator}`);
    return;
  }
  run(process.execPath, [validator, appDirectory], appDirectory, 'UI Toolkit structure validation');
}

async function runBrowserChecks() {
  const port = await freePort();
  const preview = spawn(
    npmCommand,
    ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: appDirectory,
      detached: process.platform !== 'win32',
      env: {...process.env, BROWSER: 'none'},
      shell: packageManagerShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let previewOutput = '';
  preview.stdout.on('data', chunk => { previewOutput += chunk; });
  preview.stderr.on('data', chunk => { previewOutput += chunk; });
  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(url, preview);
    const {browser, browserName} = await launchBrowser();
    try {
      const context = await browser.newContext({
        viewport: {width: 600, height: 600},
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const requests = new Set();
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => {
        if (/^https?:/.test(request.url())) requests.add(request.url().replace(/[?#].*$/, ''));
      });
      await page.addInitScript(sensorMocks);
      await page.goto(url, {waitUntil: 'load', timeout: 30000});
      await page.waitForTimeout(500);

      const runtime = await page.evaluate(async () => {
        const root = document.documentElement;
        const body = document.body;
        const mount = document.querySelector('#root');
        const mountRect = mount?.getBoundingClientRect();
        const nav = performance.getEntriesByType('navigation')[0];
        const focusables = [...document.querySelectorAll(
          'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        )].filter(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
        const unnamed = focusables.filter(element => {
          const name = element.getAttribute('aria-label')
            || element.getAttribute('title')
            || element.textContent
            || element.getAttribute('placeholder')
            || element.getAttribute('value');
          return !name?.trim();
        }).length;
        const clipped = focusables.filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
        }).length;
        const imagesWithoutAlt = [...document.querySelectorAll('img:not([alt])')].length;
        const fps = await new Promise(resolve => {
          const samples = [];
          let last = performance.now();
          const started = last;
          function frame(now) {
            samples.push(now - last);
            last = now;
            if (now - started >= 750) {
              const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
              resolve(1000 / average);
            } else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        });
        return {
          width: innerWidth,
          height: innerHeight,
          mountWidth: mountRect?.width ?? 0,
          mountHeight: mountRect?.height ?? 0,
          mountLeft: mountRect?.left ?? 0,
          mountTop: mountRect?.top ?? 0,
          horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) - innerWidth,
          verticalDocumentOverflow: Math.max(root.scrollHeight, body.scrollHeight) - innerHeight,
          focusableCount: focusables.length,
          unnamed,
          clipped,
          imagesWithoutAlt,
          loadMs: nav?.duration ?? 0,
          heapBytes: performance.memory?.usedJSHeapSize ?? 0,
          fps,
        };
      });

      if (runtime.width !== 600 || runtime.height !== 600) fail(`Browser viewport resolved to ${runtime.width}x${runtime.height}`);
      if (config.ui === 'meta-ray-ban-display-ui-toolkit') {
        if (Math.abs(runtime.mountWidth - runtime.width) > 1
            || Math.abs(runtime.mountHeight - runtime.height) > 1) {
          fail(`Application root does not fill the device viewport: ${runtime.mountWidth}x${runtime.mountHeight}`);
        }
        if (Math.abs(runtime.mountLeft) > 1 || Math.abs(runtime.mountTop) > 1) {
          fail(`Application root is not edge-to-edge in the device viewport: ${runtime.mountLeft},${runtime.mountTop}`);
        }
      } else {
        if (runtime.mountWidth !== 600 || runtime.mountHeight !== 600) {
          fail(`Custom-UI application root resolved to ${runtime.mountWidth}x${runtime.mountHeight}; required size is exactly 600x600`);
        }
        if (Math.abs(runtime.mountLeft) > 1 || Math.abs(runtime.mountTop) > 1) {
          fail(`Custom-UI application root is offset at ${runtime.mountLeft},${runtime.mountTop} in the device viewport`);
        }
      }
      if (runtime.horizontalOverflow > 1) fail(`Document has ${runtime.horizontalOverflow}px horizontal overflow`);
      if (runtime.verticalDocumentOverflow > 1) fail(`Document has ${runtime.verticalDocumentOverflow}px body-level vertical overflow`);
      if (!runtime.focusableCount) fail('No visible focus target exists');
      if (runtime.unnamed) fail(`${runtime.unnamed} visible focus target(s) have no accessible name`);
      if (runtime.clipped) fail(`${runtime.clipped} visible focus target(s) are clipped by the device viewport`);
      if (runtime.imagesWithoutAlt) fail(`${runtime.imagesWithoutAlt} image(s) lack alt text`);
      if (runtime.loadMs >= 3000) {
        fail(`Local production load took ${Math.round(runtime.loadMs)}ms; the fast-host smoke ceiling is under 3000ms. Run ai-glasses-webapp-optimize-performance for device-profile startup evidence`);
      }
      if (runtime.heapBytes >= 128 * 1024 * 1024) fail(`JavaScript heap is ${formatBytes(runtime.heapBytes)}; limit is under 128 MB`);
      if (runtime.fps < 27) fail(`Animation-frame sampling measured ${runtime.fps.toFixed(1)} fps; expected to sustain the 30 Hz panel target`);
      if (requests.size >= 15) fail(`Initial load made ${requests.size} network requests; limit is fewer than 15`);

      const focusResult = await exerciseFocus(page, runtime.focusableCount);
      if (!focusResult.focused) fail('Unable to focus the first visible interaction target');
      if (runtime.focusableCount > 1 && !focusResult.directionalMove) {
        fail('Arrow keys did not move focus between visible targets');
      }
      if (!focusResult.enterActivated) fail('Enter did not activate a visible button');
      if (!focusResult.focusRestored) fail('Escape/Back left focus unset after activation');
      const heapAfterScenario = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
      if (heapAfterScenario >= 128 * 1024 * 1024) {
        fail(`JavaScript heap after the interaction scenario is ${formatBytes(heapAfterScenario)}; limit is under 128 MB`);
      }
      if (consoleErrors.length) fail(`Browser console error: ${consoleErrors.join(' | ')}`);
      if (pageErrors.length) fail(`Browser page error: ${pageErrors.join(' | ')}`);

      const screenshotPath = join(artifactsDirectory, 'normal.png');
      await page.screenshot({path: screenshotPath});
      const background = await sharp({
        create: {width: 600, height: 600, channels: 4, background: {r: 74, g: 82, b: 91, alpha: 1}},
      }).png().toBuffer();
      await sharp(background)
        .composite([{input: screenshotPath, blend: 'screen'}])
        .png()
        .toFile(join(artifactsDirectory, 'additive-composite.png'));

      const desktopPage = await context.newPage();
      await desktopPage.setViewportSize({width: 1000, height: 800});
      await desktopPage.goto(url, {waitUntil: 'load', timeout: 30000});
      const desktopCanvas = await desktopPage.evaluate(() => {
        const rect = document.querySelector('#root')?.getBoundingClientRect();
        return rect ? {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          verticalOverflow: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
        } : null;
      });
      await desktopPage.close();
      if (config.ui === 'meta-ray-ban-display-ui-toolkit') {
        if (!desktopCanvas
            || Math.abs(desktopCanvas.width - desktopCanvas.viewportWidth) > 1
            || Math.abs(desktopCanvas.height - desktopCanvas.viewportHeight) > 1
            || Math.abs(desktopCanvas.left) > 1
            || Math.abs(desktopCanvas.top) > 1) {
          fail(`Desktop application root is not full-viewport and edge-to-edge: ${JSON.stringify(desktopCanvas)}`);
        } else if (desktopCanvas.horizontalOverflow > 1 || desktopCanvas.verticalOverflow > 1) {
          fail(`Desktop document overflows its viewport: ${JSON.stringify(desktopCanvas)}`);
        }
      } else if (!desktopCanvas || desktopCanvas.width !== 600 || desktopCanvas.height !== 600) {
        fail(`Desktop window scaled the custom-UI application root: ${JSON.stringify(desktopCanvas)}`);
      } else if (Math.abs(desktopCanvas.left - 200) > 1 || Math.abs(desktopCanvas.top - 100) > 1) {
        fail(`Desktop window did not center the custom-UI 600x600 canvas: ${JSON.stringify(desktopCanvas)}`);
      }

      return {
        url,
        requests: requests.size,
        loadMs: Math.round(runtime.loadMs),
        heapBytes: Math.max(runtime.heapBytes, heapAfterScenario),
        fps: Number(runtime.fps.toFixed(1)),
        focusableCount: runtime.focusableCount,
        screenshots: [screenshotPath, join(artifactsDirectory, 'additive-composite.png')],
        browserName,
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    fail(`Browser validation failed: ${error.message}\n${previewOutput.trim()}`);
    return null;
  } finally {
    await terminateProcessTree(preview);
  }
}

async function launchBrowser() {
  const cdpEndpoint = process.env.WEARABLES_CDP_ENDPOINT;
  if (cdpEndpoint) {
    return {
      browser: await chromium.connectOverCDP(cdpEndpoint),
      browserName: 'chromium-cdp',
    };
  }

  const executablePath = process.env.WEARABLES_BROWSER_EXECUTABLE;
  try {
    return {
      browser: await chromium.launch({headless: true, executablePath}),
      browserName: executablePath ? 'chromium-custom' : 'chromium',
    };
  } catch (chromiumError) {
    try {
      const browser = await firefox.launch({headless: true});
      warnings.push('Chromium could not launch normally; browser QA used the Playwright Firefox fallback');
      return {browser, browserName: 'firefox-fallback'};
    } catch (firefoxError) {
      if (process.env.WEARABLES_ALLOW_UNSANDBOXED_BROWSER !== '1') {
        throw new Error(
          `No sandboxed browser runtime could start. Chromium: ${chromiumError.message}\n`
          + `Firefox: ${firefoxError.message}\n`
          + 'Provide an approved Chromium DevTools endpoint in WEARABLES_CDP_ENDPOINT, or set '
          + 'WEARABLES_ALLOW_UNSANDBOXED_BROWSER=1 only after reviewing the application code.',
        );
      }
      try {
        const browser = await chromium.launch({
          headless: true,
          executablePath,
          args: ['--no-sandbox', '--single-process', '--no-zygote', '--disable-gpu'],
        });
        warnings.push('Browser QA used the explicitly enabled Chromium single-process no-sandbox fallback');
        return {
          browser,
          browserName: executablePath ? 'chromium-custom-single-process' : 'chromium-single-process',
        };
      } catch (singleProcessError) {
        throw new Error(
          `No browser runtime could start. Chromium: ${chromiumError.message}\n`
          + `Firefox: ${firefoxError.message}\n`
          + `Chromium no-sandbox fallback: ${singleProcessError.message}`,
        );
      }
    }
  }
}

async function loadBrowserDependencies() {
  try {
    const requireFromApp = createRequire(join(appDirectory, 'package.json'));
    const [playwrightModule, sharpModule] = await Promise.all([
      import(pathToFileURL(requireFromApp.resolve('playwright')).href),
      import(pathToFileURL(requireFromApp.resolve('sharp')).href),
    ]);
    const playwright = playwrightModule.default ?? playwrightModule;
    chromium = playwright.chromium;
    firefox = playwright.firefox;
    sharp = sharpModule.default ?? sharpModule;
  } catch (error) {
    fail(
      `Browser validation dependencies are missing from the app: ${error.message}. `
      + 'Use the canonical initializer or add exact dev dependencies playwright@1.55.0 and sharp@0.35.4.',
    );
  }
}

async function exerciseFocus(page, count) {
  const selector = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  if (!count) return {focused: false, directionalMove: false, enterActivated: false, focusRestored: false};
  const visibleIndices = await page.locator(selector).evaluateAll(elements => elements
    .map((element, index) => ({element, index}))
    .filter(({element}) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })
    .map(({index}) => index));
  const button = page.locator(
    'button:not([disabled]):visible, [role="button"][tabindex]:not([aria-disabled="true"]):visible',
  ).first();
  const hasButton = await button.count() > 0;
  if (hasButton) await button.focus();
  else await page.locator(selector).nth(visibleIndices[0]).focus();
  const beforeMarker = await page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName}:${element.id}:${element.getAttribute('aria-label')}:${element.textContent}` : '';
  });
  let moved = count === 1;
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
    await page.keyboard.press(key);
    const marker = await page.evaluate(() => {
      const element = document.activeElement;
      return element ? `${element.tagName}:${element.id}:${element.getAttribute('aria-label')}:${element.textContent}` : '';
    });
    if (marker && marker !== beforeMarker) moved = true;
  }
  let enterActivated = false;
  if (hasButton) {
    await button.focus();
    await page.evaluate(() => {
      globalThis.__wearablesActivationCount = 0;
      document.addEventListener('click', () => { globalThis.__wearablesActivationCount += 1; }, {once: true, capture: true});
    });
    await page.keyboard.press('Enter');
    enterActivated = await page.evaluate(() => globalThis.__wearablesActivationCount === 1);
  }
  await page.keyboard.press('Escape');
  const focused = await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null);
  return {focused, directionalMove: moved, enterActivated, focusRestored: focused};
}

function sensorMocks() {
  const permission = async () => 'granted';
  if (!globalThis.DeviceMotionEvent) globalThis.DeviceMotionEvent = class DeviceMotionEvent extends Event {};
  if (!globalThis.DeviceOrientationEvent) globalThis.DeviceOrientationEvent = class DeviceOrientationEvent extends Event {};
  try { Object.defineProperty(globalThis.DeviceMotionEvent, 'requestPermission', {value: permission, configurable: true}); } catch {}
  try { Object.defineProperty(globalThis.DeviceOrientationEvent, 'requestPermission', {value: permission, configurable: true}); } catch {}
  let watchId = 0;
  const watches = new Map();
  const geolocation = {
    getCurrentPosition(success) {
      success({coords: {latitude: 37.4848, longitude: -122.1484, accuracy: 4, speed: 1.4}, timestamp: Date.now()});
    },
    watchPosition(success) {
      const id = ++watchId;
      watches.set(id, success);
      queueMicrotask(() => success({coords: {latitude: 37.4848, longitude: -122.1484, accuracy: 4, speed: 1.4}, timestamp: Date.now()}));
      return id;
    },
    clearWatch(id) { watches.delete(id); },
  };
  try { Object.defineProperty(navigator, 'geolocation', {value: geolocation, configurable: true}); } catch {}
  globalThis.__WEARABLES_SENSOR_MOCK__ = {
    emitMotion(detail = {}) {
      const event = new Event('devicemotion');
      Object.assign(event, {
        acceleration: detail.acceleration ?? {x: 0, y: 0, z: 1.8},
        accelerationIncludingGravity: detail.accelerationIncludingGravity ?? {x: 0, y: 0, z: 11.6},
        rotationRate: detail.rotationRate ?? {alpha: 0, beta: 0, gamma: 0},
        interval: 33,
      });
      dispatchEvent(event);
    },
    emitOrientation(detail = {}) {
      const event = new Event('deviceorientation');
      Object.assign(event, {alpha: 72, beta: 0, gamma: 0, absolute: true, ...detail});
      dispatchEvent(event);
    },
  };
}

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: packageManagerShell && command === npmCommand,
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  else if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`);
}

function dependenciesAreInstalled() {
  const result = spawnSync(npmCommand, ['list', '--depth=0', '--json'], {
    cwd: appDirectory,
    encoding: 'utf8',
    env: process.env,
    shell: packageManagerShell,
    stdio: 'pipe',
  });
  return !result.error && result.status === 0;
}

function isRegistryDependencySpecifier(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const specifier = value.trim();
  if (/^(?:file|link|workspace|git|git\+|https?|ssh):/i.test(specifier)) return false;
  if (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return false;
  return /^(?:latest|next|beta|alpha|canary|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)$/.test(specifier);
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  if (await waitForProcessExit(child, 2000)) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await waitForProcessExit(child, 1000);
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    child.once('exit', onExit);
    function finish(exited) {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveExit(exited);
    }
  });
}

async function gzipJavaScript(directory) {
  const files = collectFiles(directory, file => extname(file) === '.js');
  let total = 0;
  for (const file of files) {
    let bytes = 0;
    await pipeline(createReadStream(file), createGzip(), new Writable({
      write(chunk, _encoding, callback) { bytes += chunk.length; callback(); },
    }));
    total += bytes;
  }
  return total;
}

function collectFiles(root, predicate) {
  const files = [];
  if (!existsSync(root)) return files;
  visit(root);
  return files;
  function visit(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const location = join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (!predicate || predicate(location)) files.push(location);
    }
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForServer(url, processHandle) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Preview server exited with ${processHandle.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error('Timed out waiting for Vite preview server');
}

function optionValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

function formatBytes(value) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
}

function fail(message) {
  failures.push(message);
}

function finish(browserResult = null, bundleBytes = null) {
  const result = {
    app: basename(appDirectory),
    passed: failures.length === 0,
    bundleGzipBytes: bundleBytes,
    browser: browserResult,
    warnings,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(failures.length ? 1 : 0);
}
