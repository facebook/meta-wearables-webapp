#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(process.argv[2] ?? '.');
const sourceDirectory = join(appDirectory, 'src');
const validator = join(
  scriptDirectory,
  'vendor',
  'ui-toolkit',
  'validate-app-structure.mjs',
);

if (!existsSync(sourceDirectory)) {
  console.error(`Expected an application source directory: ${sourceDirectory}`);
  process.exit(2);
}
if (!existsSync(validator)) {
  console.error(`The plugin is missing its bundled UI Toolkit validator: ${validator}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [validator, sourceDirectory], {
  cwd: appDirectory,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
