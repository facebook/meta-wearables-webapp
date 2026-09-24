import {spawnSync} from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';

export const UI_TOOLKIT_REPOSITORY =
  'https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/';
export const UI_TOOLKIT_PACKAGES = [
  '@wearables-ui-toolkit/mrbd',
  '@wearables-ui-toolkit/icons',
];

const LEGACY_UI_TOOLKIT_PACKAGES = [
  '@meta/wearables-ui-toolkit-androidx-shapes',
  '@meta/wearables-ui-toolkit-foundation',
  '@meta/wearables-ui-toolkit-icons',
  '@meta/wearables-ui-toolkit-mrbd',
  '@meta/wearables-ui-web',
  '@meta/wearables-ui-web-androidx-shapes',
  '@meta/wearables-ui-web-icons',
];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function readToolkitState(appDirectory) {
  const root = resolve(appDirectory);
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`Missing package.json in ${root}`);
  }

  const packageJson = readJson(packagePath);
  const declared = Object.fromEntries(UI_TOOLKIT_PACKAGES.map(name => [
    name,
    dependencySpecifier(packageJson, name),
  ]));
  const installed = installedToolkitPackages(root);
  const legacy = LEGACY_UI_TOOLKIT_PACKAGES.filter(name =>
    DEPENDENCY_FIELDS.some(field => packageJson[field]?.[name]),
  );

  return {
    packageJson,
    declared,
    installed,
    legacy,
    ready: UI_TOOLKIT_PACKAGES.every(name =>
      isRegistryDependencySpecifier(declared[name]) && installed[name],
    ) && legacy.length === 0,
  };
}

export function ensureGlobalToolkitPackages() {
  const before = globalToolkitPackages();
  const missing = UI_TOOLKIT_PACKAGES.filter(name => !before[name]);
  if (missing.length === 0) {
    console.log(
      `UI Toolkit is already available globally (${formatVersions(before)}); skipping global install.`,
    );
    return before;
  }

  console.log(`Installing missing UI Toolkit package${missing.length === 1 ? '' : 's'} globally: ${missing.join(', ')}`);
  const result = runNpm(
    ['install', '--global', '--no-audit', '--no-fund', ...missing],
    {capture: true},
  );
  if (result.status !== 0) {
    const detail = compactFailure(result);
    console.warn(
      'The one-time global UI Toolkit install was unavailable; continuing with the required '
      + `app-local registry install.${detail ? `\n${detail}` : ''}`,
    );
    return globalToolkitPackages();
  }

  const after = globalToolkitPackages();
  const stillMissing = UI_TOOLKIT_PACKAGES.filter(name => !after[name]);
  if (stillMissing.length > 0) {
    console.warn(
      `npm completed, but the global package directory does not contain ${stillMissing.join(', ')}. `
      + 'The app-local registry install will continue.',
    );
  } else {
    console.log(`Installed the reusable global UI Toolkit packages (${formatVersions(after)}).`);
  }
  return after;
}

export function ensureToolkitForApp(appDirectory, {globalPackages} = {}) {
  const root = resolve(appDirectory);
  const initial = readToolkitState(root);
  if (initial.ready) {
    console.log(
      `UI Toolkit is already installed in ${root} (${formatVersions(initial.installed)}); skipping npm install.`,
    );
    return {changed: false, versions: initial.installed};
  }

  const reusable = globalPackages ?? ensureGlobalToolkitPackages();
  const packagePath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  const originalPackage = readFileSync(packagePath, 'utf8');
  const originalLock = existsSync(lockPath) ? readFileSync(lockPath) : null;
  const packageJson = initial.packageJson;

  for (const field of DEPENDENCY_FIELDS) {
    if (!packageJson[field]) continue;
    for (const legacy of LEGACY_UI_TOOLKIT_PACKAGES) delete packageJson[field][legacy];
    if (field !== 'dependencies') {
      for (const name of UI_TOOLKIT_PACKAGES) delete packageJson[field][name];
    }
  }
  packageJson.dependencies ??= {};

  const installSpecs = [];
  for (const name of UI_TOOLKIT_PACKAGES) {
    const current = initial.declared[name];
    const version = reusable[name]?.version;
    const specifier = isRegistryDependencySpecifier(current)
      ? current
      : version || 'latest';
    packageJson.dependencies[name] = specifier;
    installSpecs.push(`${name}@${specifier}`);
  }
  writeJsonAtomic(packagePath, packageJson);

  const install = runNpm(
    ['install', '--save-exact', '--no-audit', '--no-fund', ...installSpecs],
    {cwd: root},
  );
  if (install.status !== 0) {
    restoreFile(packagePath, originalPackage);
    if (originalLock === null) rmSync(lockPath, {force: true});
    else restoreFile(lockPath, originalLock);
    throw new Error(
      'Unable to install @wearables-ui-toolkit/mrbd and @wearables-ui-toolkit/icons '
      + `from npm in ${root}. Verify registry access and package publication. `
      + 'This production flow does not fall back to a local checkout or file dependency.',
    );
  }

  const finalState = readToolkitState(root);
  if (!finalState.ready) {
    throw new Error(
      `npm finished, but the UI Toolkit is not resolvable in ${root}. `
      + `Expected ${UI_TOOLKIT_PACKAGES.join(' and ')} as app-local dependencies.`,
    );
  }
  return {changed: true, versions: finalState.installed};
}

export function isRegistryDependencySpecifier(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const specifier = value.trim();
  if (/^(?:file|link|workspace|git|git\+|https?|ssh):/i.test(specifier)) return false;
  if (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return false;
  return /^(?:latest|next|beta|alpha|canary|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)$/.test(specifier);
}

function dependencySpecifier(packageJson, name) {
  for (const field of DEPENDENCY_FIELDS) {
    if (typeof packageJson[field]?.[name] === 'string') return packageJson[field][name];
  }
  return null;
}

function installedToolkitPackages(appDirectory) {
  const result = runNpm(
    ['list', '--depth=0', '--json', ...UI_TOOLKIT_PACKAGES],
    {cwd: appDirectory, capture: true},
  );
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    return {};
  }
  return Object.fromEntries(
    UI_TOOLKIT_PACKAGES.flatMap(name => {
      const dependency = report.dependencies?.[name];
      return dependency?.version && !dependency.invalid && !dependency.missing
        ? [[name, {version: dependency.version}]]
        : [];
    }),
  );
}

function globalToolkitPackages() {
  const rootResult = runNpm(['root', '--global'], {capture: true});
  if (rootResult.status !== 0) return {};
  const root = rootResult.stdout.trim().split(/\r?\n/).at(-1);
  if (!root) return {};

  return Object.fromEntries(
    UI_TOOLKIT_PACKAGES.flatMap(name => {
      const packagePath = join(root, ...name.split('/'), 'package.json');
      if (!existsSync(packagePath)) return [];
      try {
        const metadata = readJson(packagePath);
        return metadata.name === name && typeof metadata.version === 'string'
          ? [[name, {version: metadata.version}]]
          : [];
      } catch {
        return [];
      }
    }),
  );
}

function runNpm(args, {cwd, capture = false} = {}) {
  return spawnSync(npmCommand, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: false,
    stdio: capture ? 'pipe' : 'inherit',
  });
}

function compactFailure(result) {
  if (result.error) return result.error.message;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return output.split(/\r?\n/).slice(-6).join('\n');
}

function formatVersions(packages) {
  return UI_TOOLKIT_PACKAGES
    .filter(name => packages[name]?.version)
    .map(name => `${name}@${packages[name].version}`)
    .join(', ');
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {force: true});
  }
}

function restoreFile(path, contents) {
  const temporary = `${path}.${process.pid}.restore`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {force: true});
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
