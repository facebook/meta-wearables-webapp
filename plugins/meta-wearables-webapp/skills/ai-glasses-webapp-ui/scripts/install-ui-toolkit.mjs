#!/usr/bin/env node

import {existsSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  ensureToolkitForApp,
  UI_TOOLKIT_PACKAGES,
  UI_TOOLKIT_REPOSITORY,
} from './lib/wui-packages.mjs';

const appDirectory = resolve(process.argv[2] ?? '.');
const packagePath = join(appDirectory, 'package.json');
if (!existsSync(packagePath)) throw new Error(`Missing package.json in ${appDirectory}`);

const result = ensureToolkitForApp(appDirectory);
const configPath = join(appDirectory, 'wearables.config.json');
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : {};
config.platform = 'meta-ray-ban-display';
config.ui = 'meta-ray-ban-display-ui-toolkit';
config.toolkitRepository = UI_TOOLKIT_REPOSITORY;
config.toolkitPackages = Object.fromEntries(
  UI_TOOLKIT_PACKAGES.map(name => [name, result.versions[name]?.version ?? null]),
);
delete config.toolkitRef;
writeJsonAtomic(configPath, config);

console.log(
  `${result.changed ? 'Installed' : 'Reused'} UI Toolkit for Meta Ray-Ban Display in ${appDirectory}.`,
);
console.log(
  'Next: use the public toolkit imports and run ai-glasses-webapp-test. '
  + 'Before release, run ai-glasses-webapp-optimize-performance and rerun the test gate.',
);

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {force: true});
  }
}
