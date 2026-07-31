import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), 'utf8');
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('release configuration', () => {
  it('keeps every GitHub Action pinned to a full commit SHA', async () => {
    const workflowDirectory = path.join(projectRoot, '.github', 'workflows');
    const workflowNames = await fs.readdir(workflowDirectory);
    const actionReferences: string[] = [];

    for (const workflowName of workflowNames) {
      const workflow = await read(path.join('.github', 'workflows', workflowName));
      actionReferences.push(
        ...Array.from(
          workflow.matchAll(/uses:\s+[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?@([^\s#]+)/g),
          (match) => match[1],
        ),
      );
    }

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference)))
      .toBe(true);
  });

  it('keeps manual packaging dry-run only and tagged releases in draft', async () => {
    const releaseWorkflow = await read('.github/workflows/release.yml');
    expect(releaseWorkflow).toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain('version:');
    expect(releaseWorkflow).toContain('Manual release validation must run from master.');
    expect(releaseWorkflow).toContain("if: github.event_name == 'push'");
    expect(releaseWorkflow).toContain('draft: true');
  });

  it('maps Electron x64 artifacts to the x86_64 Mach-O architecture', async () => {
    const smokeScript = await read('scripts/smoke-packaged.mjs');
    expect(smokeScript).toContain(
      "const artifactArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';",
    );
    expect(smokeScript).toContain(
      "const machArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';",
    );
  });

  it('ships project and third-party license material outside the ASAR', async () => {
    const builderConfig = await read('electron-builder.yml');
    expect(builderConfig).toContain('from: LICENSE');
    expect(builderConfig).toContain('from: THIRD_PARTY_NOTICES.md');
    expect(builderConfig).toContain('from: licenses');
    expect(builderConfig).toContain('!dist/demo/**/*');
    expect(builderConfig).toContain('!node_modules/**/*');
    expect(builderConfig).not.toMatch(/^\s+arch:/m);

    const licenseMappings = [
      ['node_modules/exifr/LICENSE', 'licenses/exifr-MIT.txt'],
      ['node_modules/image-size/LICENSE', 'licenses/image-size-MIT.txt'],
      ['node_modules/react/LICENSE', 'licenses/react-MIT.txt'],
      ['node_modules/react-dom/LICENSE', 'licenses/react-MIT.txt'],
      ['node_modules/scheduler/LICENSE', 'licenses/react-MIT.txt'],
      ['node_modules/lucide-react/LICENSE', 'licenses/lucide-ISC-MIT.txt'],
      [
        'node_modules/@fontsource/instrument-serif/LICENSE',
        'licenses/instrument-serif-OFL-1.1.txt',
      ],
      [
        'node_modules/@fontsource-variable/inter/LICENSE',
        'licenses/inter-OFL-1.1.txt',
      ],
    ] as const;

    for (const [upstreamPath, bundledPath] of licenseMappings) {
      expect(normalized(await read(bundledPath)))
        .toBe(normalized(await read(upstreamPath)));
    }
  });

  it('classifies bundled renderer packages as production dependencies', async () => {
    const packageJson = JSON.parse(await read('package.json')) as {
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const bundledPackages = [
      '@fontsource-variable/inter',
      '@fontsource/instrument-serif',
      'lucide-react',
      'react',
      'react-dom',
    ];

    expect(packageJson.private).toBe(true);
    for (const packageName of bundledPackages) {
      expect(packageJson.dependencies?.[packageName]).toBeTypeOf('string');
      expect(packageJson.devDependencies?.[packageName]).toBeUndefined();
    }
  });

  it('keeps the reviewed brace-expansion security backports installed', async () => {
    const packageLock = JSON.parse(await read('package-lock.json')) as {
      packages?: Record<string, { version?: string }>;
    };
    const allowedBackports = new Set(['1.1.18', '2.1.4', '3.0.6', '5.0.9']);
    const packageEntries = Object.entries(packageLock.packages ?? {})
      .filter(([packagePath]) => packagePath.endsWith('node_modules/brace-expansion'));

    expect(packageEntries.length).toBeGreaterThan(0);
    for (const [packagePath, metadata] of packageEntries) {
      expect(allowedBackports.has(metadata.version ?? '')).toBe(true);

      const candidateSources = [
        path.join(packagePath, 'index.js'),
        path.join(packagePath, 'dist', 'commonjs', 'index.js'),
      ];
      let source = '';
      for (const candidateSource of candidateSources) {
        try {
          source = await read(candidateSource);
          break;
        } catch {
          // Package major versions use different entrypoint layouts.
        }
      }
      expect(source).toContain('maxLength');
    }
  });
});
