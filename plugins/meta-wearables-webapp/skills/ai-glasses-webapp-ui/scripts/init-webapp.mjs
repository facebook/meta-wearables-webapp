#!/usr/bin/env node

import {cpSync, existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ensureGlobalToolkitPackages,
  ensureToolkitForApp,
  UI_TOOLKIT_REPOSITORY,
} from './lib/wui-packages.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(scriptDirectory, '..');
const assetDirectory = join(skillDirectory, 'assets', 'app-shell');
const args = process.argv.slice(2);

if (!args[0] || args.includes('--help')) {
  console.log('Usage: init-webapp.mjs <app-dir> [--no-ui-toolkit]');
  process.exit(args.includes('--help') ? 0 : 2);
}

const appDirectory = resolve(args[0]);
const noToolkit = args.includes('--no-ui-toolkit');
const appName = sanitizePackageName(basename(appDirectory));

const portableSupportEntries = new Set(['.agents', '.claude', '.codex', '.cursor', '.git']);
const existingEntries = existsSync(appDirectory) ? readdirSync(appDirectory) : [];
const applicationEntries = existingEntries.filter(
  entry => !portableSupportEntries.has(entry),
);
if (applicationEntries.length > 0) {
  throw new Error(
    `Refusing to scaffold over application files in ${appDirectory}: ${applicationEntries.join(', ')}`,
  );
}

// Check the shared installation before creating files. If global installation
// is unavailable, the required app-local registry install still gets a chance.
const globalPackages = noToolkit ? {} : ensureGlobalToolkitPackages();

mkdirSync(join(appDirectory, 'src'), {recursive: true});
for (const file of ['index.html', 'vite.config.ts', 'tsconfig.json', 'vercel.json']) {
  cpSync(join(assetDirectory, file), join(appDirectory, file));
}
cpSync(join(assetDirectory, 'src', 'main.tsx'), join(appDirectory, 'src', 'main.tsx'));
cpSync(
  join(assetDirectory, 'src', noToolkit ? 'App.no-wui.tsx' : 'App.wui.tsx'),
  join(appDirectory, 'src', 'App.tsx'),
);
cpSync(
  join(assetDirectory, 'src', noToolkit ? 'styles.no-wui.css' : 'styles.wui.css'),
  join(appDirectory, 'src', 'styles.css'),
);

const packageJson = {
  name: appName,
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: {
    dev: 'vite',
    typecheck: 'tsc --noEmit',
    build: 'tsc --noEmit && vite build',
    preview: 'vite preview',
  },
  dependencies: {
    react: '19.2.7',
    'react-dom': '19.2.7',
  },
  devDependencies: {
    '@types/react': '19.2.14',
    '@types/react-dom': '19.2.3',
    '@vitejs/plugin-react': '6.1.1',
    playwright: '1.55.0',
    sharp: '0.35.4',
    typescript: '5.9.3',
    vite: '8.0.0',
  },
};

writeFileSync(join(appDirectory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(
  join(appDirectory, 'wearables.config.json'),
  `${JSON.stringify({
    platform: 'meta-ray-ban-display',
    ui: noToolkit ? 'custom-explicit-opt-out' : 'meta-ray-ban-display-ui-toolkit',
    toolkitRepository: noToolkit ? null : UI_TOOLKIT_REPOSITORY,
    toolkitPackages: noToolkit ? null : {},
  }, null, 2)}\n`,
);

if (!noToolkit) {
  const toolkit = ensureToolkitForApp(appDirectory, {globalPackages});
  writeFileSync(
    join(appDirectory, 'wearables.config.json'),
    `${JSON.stringify({
      platform: 'meta-ray-ban-display',
      ui: 'meta-ray-ban-display-ui-toolkit',
      toolkitRepository: UI_TOOLKIT_REPOSITORY,
      toolkitPackages: Object.fromEntries(
        Object.entries(toolkit.versions).map(([name, metadata]) => [name, metadata.version]),
      ),
    }, null, 2)}\n`,
  );
}

console.log(
  `Created ${noToolkit ? 'custom UI' : 'UI Toolkit for Meta Ray-Ban Display'} React/Vite app: ${appDirectory}`,
);
console.log(
  noToolkit
    ? 'Next: run npm install, update the title/description and application source, then use ai-glasses-webapp-test.'
    : 'The Toolkit dependencies are installed. Next: update the title/description and application source, then use ai-glasses-webapp-test. Before release, run ai-glasses-webapp-optimize-performance and rerun the test gate.',
);

function sanitizePackageName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wearables-app';
}
