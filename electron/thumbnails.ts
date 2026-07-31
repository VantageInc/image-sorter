import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import sizeOf from 'image-size';

const THUMBNAIL_CONCURRENCY = 3;
const MAX_QUEUED_THUMBNAILS = 64;
const THUMBNAIL_MAX_DIMENSION = 400;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_CHARS = 32 * 1024 * 1024;
const MAX_CACHE_ENTRY_CHARS = 4 * 1024 * 1024;
const MAX_XMP_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_XMP_BASE64_CHARS = 6 * 1024 * 1024;
const MAX_XMP_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_EPS_TIFF_BYTES = 16 * 1024 * 1024;
const MAX_PSD_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PSD_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_COMPRESSED_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_DIMENSION = 16_384;
const MAX_DECODED_PREVIEW_PIXELS = 40_000_000;
const SAFE_EMBEDDED_PREVIEW_TYPES = new Set([
  'bmp',
  'gif',
  'jpg',
  'png',
  'tiff',
  'webp',
]);

export class ThumbnailQueueInvalidatedError extends Error {
  constructor() {
    super('The thumbnail queue was invalidated.');
    this.name = 'ThumbnailQueueInvalidatedError';
  }
}

export class ThumbnailQueueFullError extends Error {
  constructor() {
    super('The thumbnail queue is full.');
    this.name = 'ThumbnailQueueFullError';
  }
}

interface QueueGate {
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class BoundedAsyncLimiter {
  private active = 0;
  private generation = 0;
  private readonly waiting: QueueGate[] = [];
  private readonly limit: number;
  private readonly maxQueued: number;

  constructor(limit: number, maxQueued: number) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.maxQueued = Math.max(0, Math.trunc(maxQueued));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const taskGeneration = this.generation;
    await new Promise<void>((resolve, reject) => {
      if (this.active < this.limit) {
        this.active += 1;
        resolve();
        return;
      }

      if (this.waiting.length >= this.maxQueued) {
        reject(new ThumbnailQueueFullError());
        return;
      }

      this.waiting.push({
        generation: taskGeneration,
        resolve,
        reject,
      });
    });

    try {
      if (taskGeneration !== this.generation) {
        throw new ThumbnailQueueInvalidatedError();
      }
      return await task();
    } finally {
      this.active -= 1;
      this.startNext();
    }
  }

  invalidate(): void {
    this.generation += 1;
    const queued = this.waiting.splice(0);
    for (const gate of queued) {
      gate.reject(new ThumbnailQueueInvalidatedError());
    }
  }

  private startNext(): void {
    const next = this.waiting.shift();
    if (!next) return;
    if (next.generation !== this.generation) {
      next.reject(new ThumbnailQueueInvalidatedError());
      this.startNext();
      return;
    }
    this.active += 1;
    next.resolve();
  }
}

interface CacheEntry {
  value: string | null;
  chars: number;
}

class ThumbnailLruCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalChars = 0;

  get(key: string): string | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string | null): void {
    const chars = value?.length ?? 1;
    if (chars > MAX_CACHE_ENTRY_CHARS) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.totalChars -= existing.chars;
      this.entries.delete(key);
    }

    this.entries.set(key, { value, chars });
    this.totalChars += chars;

    while (
      this.entries.size > MAX_CACHE_ENTRIES
      || this.totalChars > MAX_CACHE_CHARS
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalChars -= oldest.chars;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalChars = 0;
  }
}

export async function readExact(
  handle: fs.FileHandle,
  position: number,
  length: number,
): Promise<Buffer | null> {
  if (
    !Number.isSafeInteger(position)
    || !Number.isSafeInteger(length)
    || position < 0
    || length <= 0
  ) {
    return null;
  }

  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  return buffer;
}

function validRange(
  offset: number,
  length: number,
  fileSize: number,
  maximumLength: number,
): boolean {
  return (
    Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length > 0
    && length <= maximumLength
    && offset <= fileSize
    && length <= fileSize - offset
  );
}

function resizeForThumbnail(image: NativeImage): NativeImage {
  if (image.isEmpty()) return image;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return image;
  if (width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION) {
    return image;
  }
  return width >= height
    ? image.resize({ width: THUMBNAIL_MAX_DIMENSION })
    : image.resize({ height: THUMBNAIL_MAX_DIMENSION });
}

export function isSafePreviewBuffer(buffer: Buffer): boolean {
  if (
    buffer.length <= 0
    || buffer.length > MAX_COMPRESSED_PREVIEW_BYTES
  ) {
    return false;
  }

  try {
    const dimensions = sizeOf(buffer);
    const width = dimensions.width;
    const height = dimensions.height;
    return (
      typeof dimensions.type === 'string'
      && SAFE_EMBEDDED_PREVIEW_TYPES.has(dimensions.type)
      && Number.isSafeInteger(width)
      && Number.isSafeInteger(height)
      && width > 0
      && height > 0
      && width <= MAX_PREVIEW_DIMENSION
      && height <= MAX_PREVIEW_DIMENSION
      && width <= Math.floor(MAX_DECODED_PREVIEW_PIXELS / height)
    );
  } catch {
    return false;
  }
}

function previewBufferToDataUrl(buffer: Buffer): string | null {
  if (!isSafePreviewBuffer(buffer)) return null;
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  return resizeForThumbnail(image).toDataURL();
}

export async function extractEpsTiffPreview(
  filePath: string,
  knownFileSize?: number,
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const fileSize = knownFileSize ?? (await fs.stat(filePath)).size;
    if (fileSize < 30) return null;

    handle = await fs.open(filePath, 'r');
    const header = await readExact(handle, 0, 30);
    if (
      !header
      || header[0] !== 0xc5
      || header[1] !== 0xd0
      || header[2] !== 0xd3
      || header[3] !== 0xc6
    ) {
      return null;
    }

    const tiffOffset = header.readUInt32LE(20);
    const tiffLength = header.readUInt32LE(24);
    if (!validRange(tiffOffset, tiffLength, fileSize, MAX_EPS_TIFF_BYTES)) {
      return null;
    }

    return await readExact(handle, tiffOffset, tiffLength);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function extractXmpThumbnail(
  filePath: string,
  knownFileSize?: number,
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const fileSize = knownFileSize ?? (await fs.stat(filePath)).size;
    if (fileSize <= 0) return null;

    const bytesToRead = Math.min(fileSize, MAX_XMP_SCAN_BYTES);
    handle = await fs.open(filePath, 'r');
    const prefix = await readExact(handle, 0, bytesToRead);
    if (!prefix) return null;

    const source = prefix.toString('utf8');
    const tagMatch = source.match(/<xmpGImg:image>([\s\S]*?)<\/xmpGImg:image>/);
    const attributeMatch = tagMatch
      ? null
      : source.match(/xmpGImg:image="([^"]+)"/);
    const encoded = tagMatch?.[1] ?? attributeMatch?.[1];
    if (!encoded) return null;

    const cleaned = encoded
      .replace(/&#xA;|&#xD;|&#10;|&#13;/gi, '')
      .replace(/[^A-Za-z0-9+/=]/g, '');
    if (cleaned.length === 0 || cleaned.length > MAX_XMP_BASE64_CHARS) {
      return null;
    }

    const preview = Buffer.from(cleaned, 'base64');
    return preview.length <= MAX_XMP_PREVIEW_BYTES ? preview : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function extractPsdThumbnail(
  filePath: string,
  knownFileSize?: number,
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const fileSize = knownFileSize ?? (await fs.stat(filePath)).size;
    if (fileSize < 34) return null;

    handle = await fs.open(filePath, 'r');
    const header = await readExact(handle, 0, 30);
    if (!header || header.toString('latin1', 0, 4) !== '8BPS') return null;

    const colorModeLength = header.readUInt32BE(26);
    const resourceLengthOffset = 30 + colorModeLength;
    if (!validRange(resourceLengthOffset, 4, fileSize, 4)) return null;

    const lengthBuffer = await readExact(handle, resourceLengthOffset, 4);
    if (!lengthBuffer) return null;
    const resourceLength = lengthBuffer.readUInt32BE(0);
    const resourceOffset = resourceLengthOffset + 4;
    if (
      !validRange(
        resourceOffset,
        resourceLength,
        fileSize,
        MAX_PSD_RESOURCE_BYTES,
      )
    ) {
      return null;
    }

    const resources = await readExact(handle, resourceOffset, resourceLength);
    if (!resources) return null;

    let cursor = 0;
    while (cursor + 12 <= resources.length) {
      if (resources.toString('latin1', cursor, cursor + 4) !== '8BIM') {
        return null;
      }

      const resourceId = resources.readUInt16BE(cursor + 4);
      cursor += 6;

      const nameLength = resources.readUInt8(cursor);
      const paddedNameLength = (nameLength + 1 + 1) & ~1;
      cursor += paddedNameLength;
      if (cursor + 4 > resources.length) return null;

      const dataLength = resources.readUInt32BE(cursor);
      cursor += 4;
      if (dataLength > resources.length - cursor) return null;

      if (
        (resourceId === 1033 || resourceId === 1036)
        && dataLength >= 28
      ) {
        const format = resources.readUInt32BE(cursor);
        const jpegLength = dataLength - 28;
        if (
          format === 1
          && jpegLength > 0
          && jpegLength <= MAX_PSD_PREVIEW_BYTES
        ) {
          return Buffer.from(resources.subarray(cursor + 28, cursor + dataLength));
        }
      }

      cursor += dataLength + (dataLength % 2);
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function renderShellThumbnail(filePath: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, {
      width: THUMBNAIL_MAX_DIMENSION,
      height: THUMBNAIL_MAX_DIMENSION,
    });
    return image.isEmpty() ? null : resizeForThumbnail(image).toDataURL();
  } catch {
    return null;
  }
}

async function generateThumbnail(
  filePath: string,
  extension: string,
  fileSize: number,
): Promise<string | null> {
  const shellThumbnail = await renderShellThumbnail(filePath);
  if (shellThumbnail) return shellThumbnail;

  if (extension === '.psd' || extension === '.psb') {
    const embedded = await extractPsdThumbnail(filePath, fileSize);
    const rendered = embedded ? previewBufferToDataUrl(embedded) : null;
    if (rendered) return rendered;
  }

  if (extension === '.eps' || extension === '.ai') {
    const tiff = await extractEpsTiffPreview(filePath, fileSize);
    const renderedTiff = tiff ? previewBufferToDataUrl(tiff) : null;
    if (renderedTiff) return renderedTiff;

    const xmp = await extractXmpThumbnail(filePath, fileSize);
    const renderedXmp = xmp ? previewBufferToDataUrl(xmp) : null;
    if (renderedXmp) return renderedXmp;
  }

  return null;
}

export class ThumbnailManager {
  private readonly limiter = new BoundedAsyncLimiter(
    THUMBNAIL_CONCURRENCY,
    MAX_QUEUED_THUMBNAILS,
  );
  private readonly cache = new ThumbnailLruCache();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
    this.limiter.invalidate();
    this.cache.clear();
    this.inFlight.clear();
  }

  async getThumbnail(filePath: string): Promise<string | null> {
    let stat: Stats;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      return null;
    }
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size <= 0
      || !Number.isSafeInteger(stat.size)
    ) {
      return null;
    }

    const normalizedPath = path.resolve(filePath);
    const identity = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    const cacheKey = [
      normalizedPath,
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeMs,
      identity.ctimeMs,
    ].join('\0');
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const extension = path.extname(normalizedPath).toLowerCase();
    const taskGeneration = this.generation;
    const task = this.limiter.run(async () => {
      const before = await fs.lstat(normalizedPath);
      if (
        before.isSymbolicLink()
        || !before.isFile()
        || before.dev !== identity.dev
        || before.ino !== identity.ino
        || before.size !== identity.size
        || before.mtimeMs !== identity.mtimeMs
        || before.ctimeMs !== identity.ctimeMs
      ) {
        return null;
      }

      const thumbnail = await generateThumbnail(
        normalizedPath,
        extension,
        identity.size,
      );
      const after = await fs.lstat(normalizedPath);
      if (
        after.isSymbolicLink()
        || !after.isFile()
        || after.dev !== identity.dev
        || after.ino !== identity.ino
        || after.size !== identity.size
        || after.mtimeMs !== identity.mtimeMs
        || after.ctimeMs !== identity.ctimeMs
      ) {
        return null;
      }
      return thumbnail;
    }).catch(() => null);
    this.inFlight.set(cacheKey, task);

    try {
      const thumbnail = await task;
      if (taskGeneration !== this.generation) return null;
      this.cache.set(cacheKey, thumbnail);
      return thumbnail;
    } finally {
      if (this.inFlight.get(cacheKey) === task) {
        this.inFlight.delete(cacheKey);
      }
    }
  }
}

export const thumbnailManager = new ThumbnailManager();
