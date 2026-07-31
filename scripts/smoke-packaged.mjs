import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import asar from '@electron/asar';
import fuses from '@electron/fuses';

const { listPackage } = asar;
const { getCurrentFuseWire } = fuses;
const fuseDisabled = '0'.charCodeAt(0);
const fuseEnabled = '1'.charCodeAt(0);

const releaseDirectory = path.resolve(process.argv[2] ?? 'release');
const minimumHealthyRuntimeMs = 5_000;
const forceStopAfterMs = 8_000;
const packageJson = JSON.parse(
  await fs.readFile(path.resolve('package.json'), 'utf8'),
);

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function findMacBundle() {
  const entries = await fs.readdir(releaseDirectory, { withFileTypes: true });
  const candidateDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => path.join(releaseDirectory, entry.name));

  for (const candidateDirectory of candidateDirectories) {
    const bundlePath = path.join(candidateDirectory, 'Image Sorter.app');
    if (await pathExists(bundlePath)) return bundlePath;
  }

  throw new Error('The unpacked macOS application bundle was not found.');
}

async function resolvePackagedPaths() {
  if (process.platform === 'win32') {
    const applicationDirectory = path.join(releaseDirectory, 'win-unpacked');
    return {
      executablePath: path.join(applicationDirectory, 'Image Sorter.exe'),
      resourcesPath: path.join(applicationDirectory, 'resources'),
    };
  }

  if (process.platform === 'darwin') {
    const bundlePath = await findMacBundle();
    return {
      executablePath: path.join(
        bundlePath,
        'Contents',
        'MacOS',
        'Image Sorter',
      ),
      resourcesPath: path.join(bundlePath, 'Contents', 'Resources'),
    };
  }

  throw new Error(`Packaged smoke tests are unsupported on ${process.platform}.`);
}

async function assertPackagedContents(resourcesPath) {
  const expectedResourceFiles = [
    'LICENSE.txt',
    'THIRD_PARTY_NOTICES.md',
    'licenses/exifr-MIT.txt',
    'licenses/image-size-MIT.txt',
    'licenses/instrument-serif-OFL-1.1.txt',
    'licenses/inter-OFL-1.1.txt',
    'licenses/lucide-ISC-MIT.txt',
    'licenses/react-MIT.txt',
  ];

  for (const resourceFile of expectedResourceFiles) {
    const resourcePath = path.join(resourcesPath, resourceFile);
    if (!(await pathExists(resourcePath))) {
      throw new Error(`Missing packaged legal resource: ${resourceFile}`);
    }
  }

  const asarPath = path.join(resourcesPath, 'app.asar');
  if (!(await pathExists(asarPath))) {
    throw new Error('Missing packaged app.asar.');
  }

  const asarEntries = listPackage(asarPath, { isPack: false })
    .map((entry) => entry.replaceAll('\\', '/'));
  const requiredEntries = [
    '/dist/index.html',
    '/dist-electron/main.js',
    '/dist-electron/preload.mjs',
    '/package.json',
  ];

  for (const requiredEntry of requiredEntries) {
    if (!asarEntries.includes(requiredEntry)) {
      throw new Error(`Missing ASAR entry: ${requiredEntry}`);
    }
  }

  const forbiddenPatterns = [
    /^\/src\//,
    /^\/electron\//,
    /^\/node_modules\//,
    /^\/dist\/demo\//,
    /(?:^|\/)\.git(?:\/|$)/,
    /(?:^|\/)[^/]+\.test\.[^/]+$/,
    /(?:^|\/)app-preview\.(?:png|jpe?g)$/,
  ];
  const forbiddenEntry = asarEntries.find((entry) => (
    forbiddenPatterns.some((pattern) => pattern.test(entry))
  ));
  if (forbiddenEntry) {
    throw new Error(`Unexpected development file in ASAR: ${forbiddenEntry}`);
  }
}

async function assertHardenedFuses(executablePath) {
  const fuseWire = await getCurrentFuseWire(executablePath);
  const expectedFuses = [
    { index: 0, name: 'RunAsNode', state: fuseDisabled },
    { index: 1, name: 'EnableCookieEncryption', state: fuseEnabled },
    { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', state: fuseDisabled },
    { index: 3, name: 'EnableNodeCliInspectArguments', state: fuseDisabled },
    { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', state: fuseEnabled },
    { index: 5, name: 'OnlyLoadAppFromAsar', state: fuseEnabled },
    { index: 6, name: 'LoadBrowserProcessSpecificV8Snapshot', state: fuseDisabled },
  ];

  for (const expected of expectedFuses) {
    if (fuseWire[expected.index] !== expected.state) {
      throw new Error(
        `Unexpected Electron fuse ${expected.name}: `
        + `${String(fuseWire[expected.index])}`,
      );
    }
  }
}

async function runCommand(command, args) {
  const output = [];
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${JSON.stringify(result)}\n`
      + output.join('').slice(-4_000),
    );
  }
  return output.join('');
}

async function assertNonEmptyArtifact(artifactPath) {
  const stat = await fs.stat(artifactPath);
  if (!stat.isFile() || stat.size < 1024 * 1024) {
    throw new Error(`Release artifact is unexpectedly small: ${artifactPath}`);
  }
}

async function assertWindowsArchitecture(executablePath) {
  const handle = await fs.open(executablePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('The packaged Windows executable has no MZ header.');
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    await handle.read(peHeader, 0, peHeader.length, peOffset);
    const signature = peHeader.toString('ascii', 0, 4);
    const machine = peHeader.readUInt16LE(4);
    if (signature !== 'PE\0\0' || machine !== 0x8664) {
      throw new Error(
        `The packaged Windows executable is not x64 PE: ${signature}/${machine}.`,
      );
    }
  } finally {
    await handle.close();
  }
}

async function assertContainerArtifacts(executablePath) {
  const version = packageJson.version;
  if (process.platform === 'win32') {
    const expectedArtifacts = [
      `Image-Sorter-${version}-Windows-x64-Setup.exe`,
      `Image-Sorter-${version}-Windows-x64-Portable.exe`,
    ];
    for (const artifactName of expectedArtifacts) {
      await assertNonEmptyArtifact(path.join(releaseDirectory, artifactName));
    }
    await assertWindowsArchitecture(executablePath);
    return;
  }

  const artifactArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const machArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const dmgPath = path.join(
    releaseDirectory,
    `Image-Sorter-${version}-macOS-${artifactArchitecture}.dmg`,
  );
  const zipPath = path.join(
    releaseDirectory,
    `Image-Sorter-${version}-macOS-${artifactArchitecture}.zip`,
  );
  await assertNonEmptyArtifact(dmgPath);
  await assertNonEmptyArtifact(zipPath);
  await runCommand('hdiutil', ['verify', dmgPath]);
  await runCommand('unzip', ['-t', zipPath]);

  const architectures = await runCommand('lipo', ['-archs', executablePath]);
  if (!architectures.split(/\s+/).includes(machArchitecture)) {
    throw new Error(
      `Expected ${machArchitecture} application, got ${architectures.trim()}.`,
    );
  }
}

async function launchSmoke(executablePath) {
  if (!(await pathExists(executablePath))) {
    throw new Error(`Packaged executable was not found: ${executablePath}`);
  }

  const startedAt = Date.now();
  const output = [];
  const child = spawn(executablePath, ['--disable-gpu'], {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      VITE_DEV_SERVER_URL: 'https://example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const exitResult = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const healthyResult = new Promise((resolve) => {
    setTimeout(() => resolve({ healthy: true }), minimumHealthyRuntimeMs);
  });

  const firstResult = await Promise.race([exitResult, healthyResult]);
  if (!('healthy' in firstResult)) {
    const details = output.join('').slice(-4_000);
    throw new Error(
      `Packaged app exited after ${Date.now() - startedAt} ms: `
      + `${JSON.stringify(firstResult)}\n${details}`,
    );
  }

  child.kill();
  const stopResult = await Promise.race([
    exitResult,
    new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), forceStopAfterMs);
    }),
  ]);
  if ('timedOut' in stopResult) {
    child.kill('SIGKILL');
  }
}

const packagedPaths = await resolvePackagedPaths();
await assertPackagedContents(packagedPaths.resourcesPath);
await assertHardenedFuses(packagedPaths.executablePath);
await assertContainerArtifacts(packagedPaths.executablePath);
await launchSmoke(packagedPaths.executablePath);
console.log(`Packaged smoke test passed: ${packagedPaths.executablePath}`);
