#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(process.argv[2] ?? '.');
if (!existsSync(join(appDirectory, 'package.json'))) throw new Error(`Missing package.json in ${appDirectory}`);

run(process.execPath, [join(scriptDirectory, 'check-webapp.mjs'), appDirectory], appDirectory, true);
run('vercel', ['whoami'], appDirectory, true);
const deployment = run('vercel', ['--prod', '--yes'], appDirectory, false);
const cleanOutput = stripAnsi(`${deployment.stdout}\n${deployment.stderr}`);
const urls = [...cleanOutput.matchAll(/https:\/\/[^\s]+/g)].map(match => match[0].replace(/[),.;]+$/, ''));
const productionUrl = urls.at(-1);
if (!productionUrl) throw new Error(`Vercel did not return an HTTPS URL:\n${cleanOutput}`);

const response = await fetch(productionUrl, {redirect: 'follow'});
const body = await response.text();
if (!response.ok) throw new Error(`Production URL returned HTTP ${response.status}: ${productionUrl}`);
if (/authentication required|log in to vercel|deployment protection/i.test(body)) {
  throw new Error(`Production URL is not anonymously accessible: ${productionUrl}`);
}

const packageJson = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8'));
const appName = packageJson.name || basename(appDirectory);
const deepLink = `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent(appName)}&appUrl=${encodeURIComponent(productionUrl)}`;
const qrPath = join(appDirectory, 'qr-publish.png');
run('python3', [join(scriptDirectory, 'qr_generator.py'), '--png', qrPath, deepLink], appDirectory, true);

console.log(JSON.stringify({appName, productionUrl, qrPath, deepLink}, null, 2));

function run(command, args, cwd, inherit) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
