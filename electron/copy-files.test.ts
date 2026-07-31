import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyCatalogFiles, copyTesting } from './copy-files';
import type { VerifiedCopyFileInput } from './copy-files';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-sorter-copy-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function inputFor(
  rootPath: string,
  relativePath: string,
): Promise<VerifiedCopyFileInput> {
  const filePath = path.join(rootPath, relativePath);
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    relativePath,
    sizeBytes: stat.size,
    catalogIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
  };
}

describe('copyCatalogFiles', () => {
  it('preserves relative folders and never overwrites an existing file', async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const rootPath = path.join(temporaryRoot, 'source');
    const targetDir = path.join(temporaryRoot, 'target');
    await fs.mkdir(path.join(rootPath, 'Editorial'), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'Editorial'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'Editorial', 'photo.jpg'), 'new');
    await fs.writeFile(path.join(targetDir, 'Editorial', 'photo.jpg'), 'existing');

    const file = await inputFor(rootPath, path.join('Editorial', 'photo.jpg'));
    const result = await copyCatalogFiles({ rootPath, targetDir, files: [file] });

    expect(result).toMatchObject({
      success: true,
      copiedCount: 1,
      renamedCount: 1,
      failedCount: 0,
    });
    await expect(
      fs.readFile(path.join(targetDir, 'Editorial', 'photo.jpg'), 'utf8'),
    ).resolves.toBe('existing');
    await expect(
      fs.readFile(path.join(targetDir, 'Editorial', 'photo (2).jpg'), 'utf8'),
    ).resolves.toBe('new');
    const exportedNames = await fs.readdir(path.join(targetDir, 'Editorial'));
    expect(exportedNames.some((name) => name.includes('.image-sorter-'))).toBe(false);
  });

  it('returns a partial failure for a source outside the scanned root', async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const rootPath = path.join(temporaryRoot, 'source');
    const targetDir = path.join(temporaryRoot, 'target');
    const outsidePath = path.join(temporaryRoot, 'outside.jpg');
    await Promise.all([
      fs.mkdir(rootPath),
      fs.mkdir(targetDir),
      fs.writeFile(outsidePath, 'outside'),
    ]);

    const outsideInput = await inputFor(temporaryRoot, 'outside.jpg');
    const result = await copyCatalogFiles({
      rootPath,
      targetDir,
      files: [outsideInput],
    });

    expect(result.success).toBe(false);
    expect(result.copiedCount).toBe(0);
    expect(result.failures[0]?.code).toBe('SOURCE_OUTSIDE_ROOT');
  });

  it('refuses overlapping source and export roots before creating output', async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const rootPath = path.join(temporaryRoot, 'source');
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, 'photo.jpg'), 'same');
    const file = await inputFor(rootPath, 'photo.jpg');

    const result = await copyCatalogFiles({
      rootPath,
      targetDir: rootPath,
      files: [file],
    });

    expect(result.success).toBe(false);
    expect(result.failures[0]?.code).toBe('ROOTS_OVERLAP');

    const nestedTarget = path.join(rootPath, 'export');
    const nestedResult = await copyCatalogFiles({
      rootPath,
      targetDir: nestedTarget,
      files: [file],
    });
    expect(nestedResult.failures[0]?.code).toBe('ROOTS_OVERLAP');
    await expect(fs.stat(nestedTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const parentTargetResult = await copyCatalogFiles({
      rootPath,
      targetDir: temporaryRoot,
      files: [file],
    });
    expect(parentTargetResult.failures[0]?.code).toBe('ROOTS_OVERLAP');
  });

  it('rejects a same-size source change after cataloging', async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const rootPath = path.join(temporaryRoot, 'source');
    const targetDir = path.join(temporaryRoot, 'target');
    await Promise.all([
      fs.mkdir(rootPath),
      fs.mkdir(targetDir),
    ]);
    await fs.writeFile(path.join(rootPath, 'photo.jpg'), 'old');
    const file = await inputFor(rootPath, 'photo.jpg');
    const sourcePath = path.join(rootPath, 'photo.jpg');
    await fs.writeFile(sourcePath, 'new');
    const changedTime = new Date(Date.now() + 10_000);
    await fs.utimes(sourcePath, changedTime, changedTime);

    const result = await copyCatalogFiles({
      rootPath,
      targetDir,
      files: [file],
    });

    expect(result.success).toBe(false);
    expect(result.failures[0]?.code).toBe('SOURCE_CHANGED');
    await expect(
      fs.stat(path.join(targetDir, 'photo.jpg')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes concurrent exports exclusively without partial temp names', async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const rootPath = path.join(temporaryRoot, 'source');
    const targetDir = path.join(temporaryRoot, 'target');
    await Promise.all([
      fs.mkdir(rootPath),
      fs.mkdir(targetDir),
    ]);
    await fs.writeFile(path.join(rootPath, 'photo.jpg'), 'stable-content');
    const file = await inputFor(rootPath, 'photo.jpg');
    const request = { rootPath, targetDir, files: [file] };

    const results = await Promise.all([
      copyCatalogFiles(request),
      copyCatalogFiles(request),
    ]);

    expect(results.every((result) => result.success)).toBe(true);
    const names = (await fs.readdir(targetDir)).sort();
    expect(names).toEqual(['photo (2).jpg', 'photo.jpg']);
    await expect(
      Promise.all(names.map((name) => fs.readFile(path.join(targetDir, name), 'utf8'))),
    ).resolves.toEqual(['stable-content', 'stable-content']);
  });
});

describe('exclusive publish fallback', () => {
  const unsupportedLink = async (): Promise<void> => {
    const error = new Error('Hard links are unavailable.') as Error & {
      code: string;
    };
    error.code = 'EPERM';
    throw error;
  };

  it('copies and fsyncs through a writable handle when hard links are unavailable', async () => {
    const directory = await createTemporaryDirectory();
    const temporaryPath = path.join(directory, 'staged.tmp');
    const destinationPath = path.join(directory, 'published.jpg');
    await fs.writeFile(temporaryPath, 'stable');

    await expect(
      copyTesting.publishTemporaryFile(
        temporaryPath,
        destinationPath,
        { link: unsupportedLink },
      ),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(destinationPath, 'utf8')).resolves.toBe('stable');
  });

  it('never removes an existing destination when fallback reports EEXIST', async () => {
    const directory = await createTemporaryDirectory();
    const temporaryPath = path.join(directory, 'staged.tmp');
    const destinationPath = path.join(directory, 'existing.jpg');
    await Promise.all([
      fs.writeFile(temporaryPath, 'new'),
      fs.writeFile(destinationPath, 'existing'),
    ]);

    await expect(
      copyTesting.publishTemporaryFile(
        temporaryPath,
        destinationPath,
        { link: unsupportedLink },
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(fs.readFile(destinationPath, 'utf8')).resolves.toBe('existing');
  });
});
