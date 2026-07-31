import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScanProgress } from '../shared/contracts';
import {
  CatalogScanCancelledError,
  catalogTesting,
  scanCatalog,
} from './catalog';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlSgB8AAAAASUVORK5CYII=',
  'base64',
);

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const createdDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'image-sorter-catalog-'),
  );
  const directory = await fs.realpath(createdDirectory);
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

describe('scanCatalog', () => {
  it('builds images and directory totals in one catalog snapshot', async () => {
    const rootPath = await createTemporaryDirectory();
    const nestedPath = path.join(rootPath, 'nested');
    await fs.mkdir(nestedPath);
    await Promise.all([
      fs.writeFile(path.join(rootPath, 'first.png'), PNG_1X1),
      fs.writeFile(path.join(rootPath, 'notes.txt'), 'not an image'),
      fs.writeFile(path.join(nestedPath, 'second.png'), PNG_1X1),
    ]);

    const progress: ScanProgress[] = [];
    const identities = new Map<string, number>();
    const snapshot = await scanCatalog(rootPath, {
      scanId: 'scan-test',
      onProgress: (next) => progress.push(next),
      onFileIdentity: (filePath, identity) => {
        identities.set(filePath, identity.size);
      },
    });

    expect(snapshot.totalFiles).toBe(3);
    expect(snapshot.images).toHaveLength(2);
    expect(snapshot.images.map((image) => image.relativePath)).toEqual([
      'first.png',
      path.join('nested', 'second.png'),
    ]);
    expect(snapshot.images.every((image) => image.resolution === '1x1')).toBe(true);
    expect(snapshot.tree.filesCount).toBe(3);
    expect(snapshot.tree.subdirsCount).toBe(1);
    expect(snapshot.tree.itemsCount).toBe(4);
    expect(snapshot.tree.children[0]?.name).toBe('nested');
    expect(progress.at(-1)?.phase).toBe('complete');
    expect(progress.at(-1)?.processedImages).toBe(2);
    expect(identities.size).toBe(2);
    expect(identities.get(path.join(rootPath, 'first.png'))).toBe(PNG_1X1.length);
  });

  it('includes PDF documents without treating missing image metadata as a failure', async () => {
    const rootPath = await createTemporaryDirectory();
    const pdfPath = path.join(rootPath, 'document.pdf');
    await fs.writeFile(
      pdfPath,
      Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    );

    const snapshot = await scanCatalog(rootPath, {
      scanId: 'pdf-scan',
    });

    expect(snapshot.totalFiles).toBe(1);
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0]).toMatchObject({
      path: pdfPath,
      relativePath: 'document.pdf',
      extension: '.pdf',
      metadata: {},
    });
    expect(snapshot.images[0]?.resolution).toBeUndefined();
    expect(snapshot.warnings).toEqual([]);
  });

  it('keeps malformed supported files while reporting bounded inspection failures', async () => {
    const rootPath = await createTemporaryDirectory();
    const malformedPath = path.join(rootPath, 'malformed.jpg');
    await fs.writeFile(malformedPath, Buffer.from('not a valid JPEG'));

    const snapshot = await scanCatalog(rootPath, {
      scanId: 'malformed-scan',
    });

    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0]).toMatchObject({
      path: malformedPath,
      metadata: {},
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: 'image-inspection-failed',
        path: malformedPath,
      }),
    );
  });

  it('bounds metadata input for large files without excluding the image', async () => {
    const rootPath = await createTemporaryDirectory();
    const largeImagePath = path.join(rootPath, 'large.png');
    await fs.writeFile(
      largeImagePath,
      Buffer.concat([PNG_1X1, Buffer.alloc(1024 * 1024)]),
    );

    const snapshot = await scanCatalog(rootPath, {
      scanId: 'large-metadata-scan',
      limits: {
        maxMetadataBytesPerFile: 64,
        maxMetadataBytesTotal: 64,
      },
    });

    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0]?.resolution).toBe('1x1');
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: 'metadata-skipped',
        path: snapshot.rootPath,
      }),
    );
  });

  it('enforces configurable image and file ceilings', async () => {
    const rootPath = await createTemporaryDirectory();
    await Promise.all(
      ['one.png', 'two.png', 'three.png', 'four.png'].map(
        (name) => fs.writeFile(path.join(rootPath, name), PNG_1X1),
      ),
    );

    const imageLimited = await scanCatalog(rootPath, {
      scanId: 'image-limited-scan',
      limits: { maxImages: 1 },
    });
    expect(imageLimited.totalFiles).toBe(4);
    expect(imageLimited.images).toHaveLength(1);
    expect(imageLimited.warnings).toContainEqual(
      expect.objectContaining({ code: 'catalog-limit-reached' }),
    );

    const fileLimited = await scanCatalog(rootPath, {
      scanId: 'file-limited-scan',
      limits: { maxFiles: 2 },
    });
    expect(fileLimited.totalFiles).toBe(2);
    expect(fileLimited.images).toHaveLength(2);
    expect(fileLimited.tree.filesCount).toBe(2);
    expect(fileLimited.warnings).toContainEqual(
      expect.objectContaining({ code: 'catalog-limit-reached' }),
    );
  });

  it('honors cancellation before filesystem work starts', async () => {
    const rootPath = await createTemporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanCatalog(rootPath, {
        scanId: 'cancelled-scan',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CatalogScanCancelledError);
  });

  it('honors cancellation after a metadata worker has started reading', async () => {
    const rootPath = await createTemporaryDirectory();
    await fs.writeFile(
      path.join(rootPath, 'image.png'),
      Buffer.concat([PNG_1X1, Buffer.alloc(1024 * 1024)]),
    );
    const controller = new AbortController();
    let metadataPhaseObserved = false;
    let chunksRead = 0;

    await expect(
      scanCatalog(rootPath, {
        scanId: 'metadata-cancelled-scan',
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'metadata') metadataPhaseObserved = true;
        },
        onReadChunk: () => {
          chunksRead += 1;
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(CatalogScanCancelledError);

    expect(metadataPhaseObserved).toBe(true);
    expect(chunksRead).toBe(1);
  });
});

describe('catalog metadata serialization', () => {
  it('retains dates, arrays, and small structured values', () => {
    const metadata = catalogTesting.serializeMetadata({
      capturedAt: new Date('2026-07-31T12:00:00.000Z'),
      keywords: ['catalog', 'release'],
      location: { city: 'Buenos Aires', rating: 5 },
    });

    expect(metadata.capturedAt).toBe('2026-07-31T12:00:00.000Z');
    expect(metadata.keywords).toBe('["catalog","release"]');
    expect(metadata.location).toBe('{"city":"Buenos Aires","rating":5}');
  });

  it('shares one retained-metadata ceiling across serialized records', () => {
    const budget = new catalogTesting.CharacterBudget(10);
    const first = catalogTesting.retainMetadataWithinBudget(
      { a: '1234' },
      budget,
    );
    const second = catalogTesting.retainMetadataWithinBudget(
      { b: '123456' },
      budget,
    );

    expect(first).toEqual({ metadata: { a: '1234' }, truncated: false });
    expect(second).toEqual({ metadata: {}, truncated: true });
  });
});

describe('catalog concurrency', () => {
  it('drains already-started workers before surfacing the first failure', async () => {
    let releaseSlowWorker: () => void = () => undefined;
    const slowWorkerGate = new Promise<void>((resolve) => {
      releaseSlowWorker = resolve;
    });
    let slowWorkerFinished = false;
    let operationSettled = false;

    const operation = catalogTesting.mapWithConcurrency(
      ['slow', 'failure'],
      2,
      async (item) => {
        if (item === 'failure') {
          throw new Error('mapper failed');
        }
        await slowWorkerGate;
        slowWorkerFinished = true;
        return item;
      },
    );
    const observedOperation = operation.then(
      (value) => {
        operationSettled = true;
        return { value };
      },
      (error: unknown) => {
        operationSettled = true;
        return { error };
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(operationSettled).toBe(false);
    expect(slowWorkerFinished).toBe(false);

    releaseSlowWorker();
    const outcome = await observedOperation;
    expect(outcome).toEqual({ error: expect.any(Error) });
    expect((outcome as { error: Error }).error.message).toBe('mapper failed');
    expect(slowWorkerFinished).toBe(true);
  });
});
