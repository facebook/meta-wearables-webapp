#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {UI_TOOLKIT_REPOSITORY} from './lib/wui-packages.mjs';

const clientRoots = {
  'claude-code': ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  'muse-code': ['.agents', 'skills'],
};
const aliases = new Map([
  ['claude', 'claude-code'],
  ['muse', 'muse-code'],
]);
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(
    'Usage: install-ui-toolkit-skills.mjs --client <claude-code|codex|muse-code> '
    + '[--account | --project <directory>] [--force] [--ref <git-ref>]',
  );
  process.exit(0);
}

const requestedClient = optionValue('--client');
const client = aliases.get(requestedClient) ?? requestedClient;
if (!clientRoots[client]) {
  throw new Error('--client must be claude-code, codex, or muse-code');
}
const projectArgument = optionValue('--project');
const account = args.includes('--account') || !projectArgument;
if (account && projectArgument) throw new Error('Pass either --account or --project, not both');
const project = projectArgument ? resolve(projectArgument) : null;
if (project && !existsSync(project)) throw new Error(`Project directory does not exist: ${project}`);
const force = args.includes('--force');
const ref = optionValue('--ref') ?? 'main';
const targetRoot = account
  ? join(homedir(), ...clientRoots[client])
  : join(project, ...clientRoots[client].slice(0, -1), 'skills');
const entrypoint = join(targetRoot, 'wearables-ui-toolkit-web', 'SKILL.md');

if (existsSync(entrypoint) && !force) {
  console.log(`UI Toolkit LLM skills are already installed at ${entrypoint}; skipping install.`);
  process.exit(0);
}

const temporary = mkdtempSync(join(tmpdir(), 'wearables-ui-toolkit-skills.'));
const checkout = join(temporary, 'repository');
try {
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    ref,
    UI_TOOLKIT_REPOSITORY,
    checkout,
  ]);
  const installer = join(checkout, 'tools', 'install-skills.mjs');
  if (!existsSync(installer)) {
    throw new Error(
      `The UI Toolkit repository does not contain tools/install-skills.mjs at ref ${ref}.`,
    );
  }
  const installerArgs = [installer, '--client', client];
  if (account) installerArgs.push('--account');
  else installerArgs.push('--project', project);
  if (force) installerArgs.push('--force');
  run(process.execPath, installerArgs);
} finally {
  rmSync(temporary, {recursive: true, force: true});
}

if (!existsSync(entrypoint)) {
  throw new Error(
    `The official installer completed, but ${entrypoint} is missing. `
    + 'Check the repository installation documentation for the current client target.',
  );
}
console.log(`UI Toolkit LLM skills are ready at ${entrypoint}.`);

function optionValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with exit code ${result.status}. `
      + `Verify access to ${UI_TOOLKIT_REPOSITORY}.`,
    );
  }
}
