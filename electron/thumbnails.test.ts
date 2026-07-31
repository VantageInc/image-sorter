import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  nativeImage: {},
}));

import {
  BoundedAsyncLimiter,
  ThumbnailQueueFullError,
  ThumbnailQueueInvalidatedError,
  extractEpsTiffPreview,
  extractXmpThumbnail,
  isSafePreviewBuffer,
  readExact,
} from './thumbnails';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlSgB8AAAAASUVORK5CYII=',
  'base64',
);

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-sorter-preview-'));
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

describe('bounded embedded preview extraction', () => {
  it('continues after short reads until the requested range is complete', async () => {
    const source = Buffer.from('abcdef');
    const handle = {
      read: vi.fn(async (
        target: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const bytesRead = Math.min(2, length, source.length - position);
        if (bytesRead > 0) {
          source.copy(target, offset, position, position + bytesRead);
        }
        return { bytesRead, buffer: target };
      }),
    } as unknown as fs.FileHandle;

    await expect(readExact(handle, 1, 5)).resolves.toEqual(
      Buffer.from('bcdef'),
    );
    expect(handle.read).toHaveBeenCalledTimes(3);
  });

  it('extracts a valid TIFF range from a DOS EPS header', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'preview.eps');
    const payload = Buffer.from([1, 2, 3, 4]);
    const file = Buffer.alloc(30 + payload.length);
    file.set([0xc5, 0xd0, 0xd3, 0xc6], 0);
    file.writeUInt32LE(30, 20);
    file.writeUInt32LE(payload.length, 24);
    payload.copy(file, 30);
    await fs.writeFile(filePath, file);

    await expect(extractEpsTiffPreview(filePath)).resolves.toEqual(payload);
  });

  it('rejects an EPS length that exceeds the file before allocating it', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'malformed.eps');
    const file = Buffer.alloc(30);
    file.set([0xc5, 0xd0, 0xd3, 0xc6], 0);
    file.writeUInt32LE(30, 20);
    file.writeUInt32LE(0xffff_ffff, 24);
    await fs.writeFile(filePath, file);

    await expect(extractEpsTiffPreview(filePath)).resolves.toBeNull();
  });

  it('decodes a bounded XMP base64 preview', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'preview.ai');
    const expected = Buffer.from('embedded-preview');
    const source = `<xmpGImg:image>${expected.toString('base64')}</xmpGImg:image>`;
    await fs.writeFile(filePath, source);

    await expect(extractXmpThumbnail(filePath)).resolves.toEqual(expected);
  });
});

describe('preview decode guards', () => {
  it('accepts a small image and rejects excessive decoded dimensions', () => {
    const oversizedPngHeader = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPngHeader);
    oversizedPngHeader.writeUInt32BE(13, 8);
    oversizedPngHeader.write('IHDR', 12, 'ascii');
    oversizedPngHeader.writeUInt32BE(20_000, 16);
    oversizedPngHeader.writeUInt32BE(20_000, 20);

    expect(isSafePreviewBuffer(PNG_1X1)).toBe(true);
    expect(isSafePreviewBuffer(oversizedPngHeader)).toBe(false);
    expect(
      isSafePreviewBuffer(Buffer.from('<svg width="1" height="1"></svg>')),
    ).toBe(false);
  });

  it('rejects compressed preview input above the byte ceiling', () => {
    const oversizedCompressedInput = Buffer.concat([
      PNG_1X1,
      Buffer.alloc(16 * 1024 * 1024),
    ]);
    expect(isSafePreviewBuffer(oversizedCompressedInput)).toBe(false);
  });
});

describe('bounded thumbnail queue', () => {
  it('rejects excess queued work and drains accepted work', async () => {
    const limiter = new BoundedAsyncLimiter(1, 1);
    let releaseFirst: (() => void) | undefined;
    const first = limiter.run(
      () => new Promise<string>((resolve) => {
        releaseFirst = () => resolve('first');
      }),
    );
    const second = limiter.run(async () => 'second');

    await expect(
      limiter.run(async () => 'overflow'),
    ).rejects.toBeInstanceOf(ThumbnailQueueFullError);

    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('invalidates queued work without caching stale generation results', async () => {
    const limiter = new BoundedAsyncLimiter(1, 2);
    let releaseActive: (() => void) | undefined;
    let markActiveStarted: (() => void) | undefined;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const active = limiter.run(
      () => new Promise<string>((resolve) => {
        markActiveStarted?.();
        releaseActive = () => resolve('active');
      }),
    );
    await activeStarted;
    const queued = limiter.run(async () => 'stale');

    limiter.invalidate();
    await expect(queued).rejects.toBeInstanceOf(ThumbnailQueueInvalidatedError);
    releaseActive?.();
    await expect(active).resolves.toBe('active');
    await expect(limiter.run(async () => 'fresh')).resolves.toBe('fresh');
  });
});
