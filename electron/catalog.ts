import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import exifr from 'exifr';
import sizeOf from 'image-size';
import type {
  CatalogSnapshot,
  DirectoryStatNode,
  FileIdentity,
  ImageFile,
  ScanProgress,
  ScanWarning,
  ScanWarningCode,
} from '../shared/contracts';
import { isSupportedImageExtension } from './image-formats';

const WALK_CONCURRENCY = 8;
const IMAGE_INSPECTION_CONCURRENCY = 8;
const DIRECTORY_BATCH_SIZE = 128;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_DIMENSION_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_WARNINGS = 1_000;
const MAX_METADATA_FIELDS = 128;
const MAX_METADATA_VALUE_CHARS = 2_048;
const MAX_METADATA_TOTAL_CHARS = 16 * 1024;
const MAX_STRUCTURED_ITEMS = 32;
const MAX_STRUCTURED_DEPTH = 3;
const PROGRESS_INTERVAL_MS = 50;

export interface CatalogLimits {
  maxDirectories: number;
  maxFiles: number;
  maxImages: number;
  maxMetadataBytesPerFile: number;
  maxMetadataBytesTotal: number;
  maxMetadataCharsTotal: number;
  maxRetainedPathChars: number;
}

export const DEFAULT_CATALOG_LIMITS: Readonly<CatalogLimits> = Object.freeze({
  maxDirectories: 50_000,
  maxFiles: 500_000,
  maxImages: 50_000,
  maxMetadataBytesPerFile: 8 * 1024 * 1024,
  maxMetadataBytesTotal: 256 * 1024 * 1024,
  maxMetadataCharsTotal: 32 * 1024 * 1024,
  maxRetainedPathChars: 32 * 1024 * 1024,
});

interface ImageCandidate {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  identity: FileIdentity;
}

interface DirectoryWorkItem {
  node: DirectoryStatNode;
  parent?: DirectoryWorkItem;
}

export interface CatalogOptions {
  scanId: string;
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  walkConcurrency?: number;
  imageConcurrency?: number;
  limits?: Partial<CatalogLimits>;
  onFileIdentity?: (filePath: string, identity: FileIdentity) => void;
  onReadChunk?: (filePath: string, bytesRead: number) => void;
}

interface WalkResult {
  tree: DirectoryStatNode;
  candidates: ImageCandidate[];
  totalFiles: number;
}

type InspectedDirectoryEntry =
  | { kind: 'directory'; path: string; name: string }
  | { kind: 'file'; candidate?: ImageCandidate; sizeBytes: number }
  | { kind: 'skip' };

const METADATA_TAGS = [
  'ImageWidth',
  'ImageHeight',
  'ExifImageWidth',
  'ExifImageHeight',
  'PixelXDimension',
  'PixelYDimension',
  'SourceImageWidth',
  'SourceImageHeight',
  'Make',
  'Model',
  'LensMake',
  'LensModel',
  'Software',
  'Artist',
  'Copyright',
  'DateTime',
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'Orientation',
  'ExposureTime',
  'FNumber',
  'ISO',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'ExposureProgram',
  'ExposureBiasValue',
  'MeteringMode',
  'Flash',
  'WhiteBalance',
  'ColorSpace',
  'SensingMethod',
  'Title',
  'Description',
  'Subject',
  'Keywords',
  'Creator',
  'Rating',
] as const;

export class CatalogScanCancelledError extends Error {
  constructor() {
    super('The directory scan was cancelled.');
    this.name = 'CatalogScanCancelledError';
  }
}

class CandidateChangedError extends Error {
  constructor(filePath: string, reason: string) {
    super(`The file changed while it was being scanned: ${reason}`);
    this.name = 'CandidateChangedError';
    this.filePath = filePath;
  }

  readonly filePath: string;
}

class WarningCollector {
  private readonly warnings: ScanWarning[] = [];
  private readonly keys = new Set<string>();
  private truncated = false;

  add(code: ScanWarningCode, warningPath: string, message: string): void {
    if (this.truncated) return;
    const key = `${code}\0${warningPath}\0${message}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);

    if (this.warnings.length < MAX_WARNINGS) {
      this.warnings.push({ code, path: warningPath, message });
      return;
    }

    if (!this.truncated) {
      this.truncated = true;
      this.warnings.push({
        code: 'warnings-truncated',
        path: warningPath,
        message: `Only the first ${MAX_WARNINGS} scan warnings are retained.`,
      });
    }
  }

  toArray(): ScanWarning[] {
    return [...this.warnings];
  }
}

class MetadataByteBudget {
  private remainingBytes: number;

  constructor(totalBytes: number) {
    this.remainingBytes = totalBytes;
  }

  take(requestedBytes: number): number {
    const granted = Math.max(
      0,
      Math.min(Math.trunc(requestedBytes), this.remainingBytes),
    );
    this.remainingBytes -= granted;
    return granted;
  }
}

class CharacterBudget {
  private remainingChars: number;

  constructor(totalChars: number) {
    this.remainingChars = totalChars;
  }

  take(chars: number): boolean {
    const requested = Math.max(0, Math.trunc(chars));
    if (requested > this.remainingChars) return false;
    this.remainingChars -= requested;
    return true;
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CatalogScanCancelledError();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

function isAccessFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'EACCES'
    || code === 'EPERM'
    || code === 'ENOENT'
    || code === 'EIO'
  );
}

function comparablePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function pathsMatch(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  if (pathsMatch(rootPath, candidatePath)) return true;
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function identityFromStat(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return (
    (left.dev === 0 || right.dev === 0 || left.dev === right.dev)
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return ceiling;
  return Math.max(0, Math.min(Math.trunc(value), ceiling));
}

function resolveLimits(limits?: Partial<CatalogLimits>): CatalogLimits {
  return {
    maxDirectories: Math.max(
      1,
      boundedLimit(limits?.maxDirectories, DEFAULT_CATALOG_LIMITS.maxDirectories),
    ),
    maxFiles: boundedLimit(
      limits?.maxFiles,
      DEFAULT_CATALOG_LIMITS.maxFiles,
    ),
    maxImages: boundedLimit(
      limits?.maxImages,
      DEFAULT_CATALOG_LIMITS.maxImages,
    ),
    maxMetadataBytesPerFile: boundedLimit(
      limits?.maxMetadataBytesPerFile,
      DEFAULT_CATALOG_LIMITS.maxMetadataBytesPerFile,
    ),
    maxMetadataBytesTotal: boundedLimit(
      limits?.maxMetadataBytesTotal,
      DEFAULT_CATALOG_LIMITS.maxMetadataBytesTotal,
    ),
    maxMetadataCharsTotal: boundedLimit(
      limits?.maxMetadataCharsTotal,
      DEFAULT_CATALOG_LIMITS.maxMetadataCharsTotal,
    ),
    maxRetainedPathChars: boundedLimit(
      limits?.maxRetainedPathChars,
      DEFAULT_CATALOG_LIMITS.maxRetainedPathChars,
    ),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.max(
    1,
    Math.min(Math.trunc(concurrency) || 1, items.length),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure: unknown;

  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      let index: number;
      try {
        throwIfCancelled(signal);
        index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
        return;
      }
    }
  });

  await Promise.allSettled(workers);
  if (failed) throw firstFailure;
  return results;
}

function createProgressReporter(
  progress: ScanProgress,
  onProgress?: (next: ScanProgress) => void,
): (force?: boolean) => void {
  let lastReportedAt = 0;

  return (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportedAt < PROGRESS_INTERVAL_MS) return;
    lastReportedAt = now;
    try {
      onProgress({ ...progress });
    } catch {
      // A renderer disappearing must not fail filesystem work.
    }
  };
}

function createDirectoryNode(directoryPath: string, name: string): DirectoryStatNode {
  return {
    name,
    path: directoryPath,
    isDirectory: true,
    sizeBytes: 0,
    itemsCount: 0,
    filesCount: 0,
    subdirsCount: 0,
    children: [],
  };
}

async function canonicalRootDirectory(rootPath: string): Promise<string> {
  const resolvedPath = path.resolve(rootPath);
  const realPath = await fs.realpath(resolvedPath);
  const linkStat = await fs.lstat(realPath);
  const stat = await fs.stat(realPath);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory() || !stat.isDirectory()) {
    throw new Error('The catalog root is not a regular directory.');
  }
  return realPath;
}

async function revalidateDirectory(
  rootPath: string,
  directoryPath: string,
): Promise<string> {
  const linkStat = await fs.lstat(directoryPath);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new Error('The directory changed type or became a symbolic link.');
  }

  const realPath = await fs.realpath(directoryPath);
  if (!isPathInsideOrEqual(rootPath, realPath)) {
    throw new Error('The directory resolves outside the selected root.');
  }

  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) {
    throw new Error('The directory changed type during the scan.');
  }
  return realPath;
}

async function inspectDirectoryEntry(
  rootPath: string,
  directoryPath: string,
  entry: Dirent,
  warnings: WarningCollector,
  progress: ScanProgress,
  reportProgress: (force?: boolean) => void,
  signal?: AbortSignal,
): Promise<InspectedDirectoryEntry> {
  throwIfCancelled(signal);
  const entryPath = path.join(directoryPath, entry.name);

  try {
    const linkStat = await fs.lstat(entryPath);
    if (entry.isSymbolicLink() || linkStat.isSymbolicLink()) {
      warnings.add(
        'entry-skipped',
        entryPath,
        'Symbolic links are skipped to keep the scan inside the selected root.',
      );
      return { kind: 'skip' };
    }

    const realPath = await fs.realpath(entryPath);
    if (!isPathInsideOrEqual(rootPath, realPath)) {
      warnings.add(
        'entry-skipped',
        entryPath,
        'The entry resolves outside the selected root.',
      );
      return { kind: 'skip' };
    }

    const stat = await fs.stat(realPath);
    if (linkStat.isDirectory() && stat.isDirectory()) {
      return { kind: 'directory', path: realPath, name: entry.name };
    }

    if (!linkStat.isFile() || !stat.isFile()) {
      warnings.add('entry-skipped', entryPath, 'Unsupported filesystem entry type.');
      return { kind: 'skip' };
    }

    progress.filesVisited += 1;
    progress.currentPath = realPath;
    reportProgress();

    const extension = path.extname(entry.name).toLowerCase();
    if (!isSupportedImageExtension(extension)) {
      return { kind: 'file', sizeBytes: stat.size };
    }

    return {
      kind: 'file',
      sizeBytes: stat.size,
      candidate: {
        path: realPath,
        relativePath: path.relative(rootPath, realPath),
        name: entry.name,
        extension,
        sizeBytes: stat.size,
        identity: identityFromStat(stat),
      },
    };
  } catch (error) {
    warnings.add('file-unreadable', entryPath, errorMessage(error));
    return { kind: 'skip' };
  }
}

async function walkCatalog(
  rootPath: string,
  warnings: WarningCollector,
  progress: ScanProgress,
  reportProgress: (force?: boolean) => void,
  concurrency: number,
  limits: CatalogLimits,
  retainedPathBudget: CharacterBudget,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const rootName = path.basename(rootPath) || rootPath;
  const rootWorkItem: DirectoryWorkItem = {
    node: createDirectoryNode(rootPath, rootName),
  };
  const stack: DirectoryWorkItem[] = [rootWorkItem];
  const directories: DirectoryWorkItem[] = [rootWorkItem];
  const candidates: ImageCandidate[] = [];
  const discoveredDirectories = new Set([comparablePath(rootPath)]);
  const visitedDirectories = new Set<string>();
  let totalFiles = 0;
  let stopForFileLimit = limits.maxFiles === 0;

  if (!retainedPathBudget.take(rootPath.length + rootName.length)) {
    warnings.add(
      'catalog-limit-reached',
      rootPath,
      'The catalog root itself exceeds the retained path-text budget.',
    );
  }

  if (stopForFileLimit) {
    warnings.add(
      'catalog-limit-reached',
      rootPath,
      'The configured file ceiling is zero; directory contents were not scanned.',
    );
  }

  while (stack.length > 0 && !stopForFileLimit) {
    throwIfCancelled(signal);
    const current = stack.pop();
    if (!current) break;

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await revalidateDirectory(rootPath, current.node.path);
    } catch (error) {
      warnings.add('directory-unreadable', current.node.path, errorMessage(error));
      continue;
    }

    const canonicalKey = comparablePath(canonicalDirectory);
    if (visitedDirectories.has(canonicalKey)) {
      warnings.add(
        'entry-skipped',
        current.node.path,
        'An already visited canonical directory was skipped.',
      );
      continue;
    }
    visitedDirectories.add(canonicalKey);

    progress.directoriesVisited += 1;
    progress.currentPath = canonicalDirectory;
    reportProgress();

    const childDirectories: DirectoryWorkItem[] = [];
    const processBatch = async (batch: Dirent[]): Promise<void> => {
      const inspected = await mapWithConcurrency(
        batch,
        concurrency,
        (entry) => inspectDirectoryEntry(
          rootPath,
          canonicalDirectory,
          entry,
          warnings,
          progress,
          reportProgress,
          signal,
        ),
        signal,
      );

      for (const result of inspected) {
        if (result.kind === 'directory') {
          const canonicalKey = comparablePath(result.path);
          if (discoveredDirectories.has(canonicalKey)) {
            warnings.add(
              'entry-skipped',
              result.path,
              'A directory resolving to an already discovered location was skipped.',
            );
            continue;
          }
          if (directories.length >= limits.maxDirectories) {
            warnings.add(
              'catalog-limit-reached',
              rootPath,
              `The catalog contains more than ${limits.maxDirectories} directories; additional directories were skipped.`,
            );
            continue;
          }
          if (!retainedPathBudget.take(result.path.length + result.name.length)) {
            warnings.add(
              'catalog-limit-reached',
              rootPath,
              'Additional directories were skipped after the retained path-text budget was reached.',
            );
            continue;
          }

          discoveredDirectories.add(canonicalKey);
          const child: DirectoryWorkItem = {
            node: createDirectoryNode(result.path, result.name),
            parent: current,
          };
          current.node.children.push(child.node);
          directories.push(child);
          childDirectories.push(child);
          continue;
        }

        if (result.kind !== 'file') continue;
        if (totalFiles >= limits.maxFiles) {
          stopForFileLimit = true;
          warnings.add(
            'catalog-limit-reached',
            rootPath,
            `The catalog scan stopped after ${limits.maxFiles} files.`,
          );
          break;
        }

        totalFiles += 1;
        current.node.sizeBytes += result.sizeBytes;
        current.node.filesCount += 1;
        current.node.itemsCount += 1;
        if (!result.candidate) continue;

        if (candidates.length >= limits.maxImages) {
          warnings.add(
            'catalog-limit-reached',
            rootPath,
            `Only the first ${limits.maxImages} supported files are included in the catalog.`,
          );
          continue;
        }
        const candidateChars = (
          result.candidate.path.length
          + result.candidate.relativePath.length
          + result.candidate.name.length
        );
        if (!retainedPathBudget.take(candidateChars)) {
          warnings.add(
            'catalog-limit-reached',
            rootPath,
            'Additional supported files were skipped after the retained path-text budget was reached.',
          );
          continue;
        }

        candidates.push(result.candidate);
        progress.imagesFound = candidates.length;
      }
    };

    let directoryHandle: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      directoryHandle = await fs.opendir(canonicalDirectory);
      let batch: Dirent[] = [];
      for await (const entry of directoryHandle) {
        throwIfCancelled(signal);
        batch.push(entry);
        if (batch.length < DIRECTORY_BATCH_SIZE) continue;
        await processBatch(batch);
        batch = [];
        if (stopForFileLimit) break;
      }
      if (batch.length > 0 && !stopForFileLimit) {
        await processBatch(batch);
      }
    } catch (error) {
      if (error instanceof CatalogScanCancelledError) throw error;
      warnings.add('directory-unreadable', canonicalDirectory, errorMessage(error));
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      stack.push(childDirectories[index]);
    }
  }

  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const current = directories[index];
    const parent = current.parent;
    if (!parent) continue;
    parent.node.sizeBytes += current.node.sizeBytes;
    parent.node.filesCount += current.node.filesCount;
    parent.node.subdirsCount += current.node.subdirsCount + 1;
    parent.node.itemsCount += current.node.itemsCount + 1;
  }

  for (const directory of directories) {
    directory.node.children.sort((left, right) => {
      const bySize = right.sizeBytes - left.sizeBytes;
      return bySize !== 0 ? bySize : left.name.localeCompare(right.name);
    });
  }

  return { tree: rootWorkItem.node, candidates, totalFiles };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown): number | undefined {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : undefined;

  if (
    candidate === undefined
    || !Number.isFinite(candidate)
    || candidate <= 0
  ) {
    return undefined;
  }

  return Math.trunc(candidate);
}

function findNumericMetadataField(
  value: unknown,
  fieldNames: ReadonlySet<string>,
  depth = 0,
  seen = new WeakSet<object>(),
): number | undefined {
  if (depth > 2 || typeof value !== 'object' || value === null) return undefined;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (fieldNames.has(key.toLowerCase())) {
      const parsed = numericValue(child);
      if (parsed !== undefined) return parsed;
    }
  }

  for (const child of Object.values(value)) {
    const parsed = findNumericMetadataField(child, fieldNames, depth + 1, seen);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function toSmallSerializable(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_STRUCTURED_DEPTH) return undefined;
  if (typeof value !== 'object') return undefined;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_STRUCTURED_ITEMS)
      .map((item) => toSmallSerializable(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }

  const serialized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_STRUCTURED_ITEMS)) {
    const next = toSmallSerializable(child, depth + 1, seen);
    if (next !== undefined) serialized[key] = next;
  }
  return serialized;
}

function serializeMetadataValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.slice(0, MAX_METADATA_VALUE_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  const serializable = toSmallSerializable(value, 0, new WeakSet<object>());
  if (serializable === undefined) return undefined;

  try {
    return JSON.stringify(serializable).slice(0, MAX_METADATA_VALUE_CHARS);
  } catch {
    return undefined;
  }
}

function serializeMetadata(rawMetadata: unknown): Record<string, string> {
  if (!isRecord(rawMetadata)) return {};

  const metadata: Record<string, string> = {};
  let totalChars = 0;

  for (const [key, value] of Object.entries(rawMetadata).slice(0, MAX_METADATA_FIELDS)) {
    const serialized = serializeMetadataValue(value);
    if (serialized === undefined || serialized.length === 0) continue;
    const nextSize = key.length + serialized.length;
    if (totalChars + nextSize > MAX_METADATA_TOTAL_CHARS) break;
    metadata[key] = serialized;
    totalChars += nextSize;
  }

  return metadata;
}

function retainMetadataWithinBudget(
  metadata: Record<string, string>,
  budget: CharacterBudget,
): { metadata: Record<string, string>; truncated: boolean } {
  const retained: Record<string, string> = {};
  let truncated = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (!budget.take(key.length + value.length)) {
      truncated = true;
      continue;
    }
    retained[key] = value;
  }
  return { metadata: retained, truncated };
}

async function validateCandidate(
  rootPath: string,
  candidate: ImageCandidate,
): Promise<void> {
  const linkStat = await fs.lstat(candidate.path);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new CandidateChangedError(candidate.path, 'it is no longer a regular file');
  }

  const realPath = await fs.realpath(candidate.path);
  if (
    !pathsMatch(realPath, candidate.path)
    || !isPathInsideOrEqual(rootPath, realPath)
  ) {
    throw new CandidateChangedError(
      candidate.path,
      'its canonical path no longer matches the catalog',
    );
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile() || !identitiesMatch(candidate.identity, identityFromStat(stat))) {
    throw new CandidateChangedError(candidate.path, 'its identity or timestamps changed');
  }
}

async function readCandidatePrefix(
  rootPath: string,
  candidate: ImageCandidate,
  bytesToRead: number,
  signal?: AbortSignal,
  onReadChunk?: (filePath: string, bytesRead: number) => void,
): Promise<Buffer> {
  throwIfCancelled(signal);
  await validateCandidate(rootPath, candidate);
  throwIfCancelled(signal);

  const handle = await fs.open(candidate.path, 'r');
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || !identitiesMatch(candidate.identity, identityFromStat(openedStat))
    ) {
      throw new CandidateChangedError(candidate.path, 'it changed before opening');
    }

    const requestedBytes = Math.max(
      0,
      Math.min(Math.trunc(bytesToRead), candidate.sizeBytes),
    );
    const buffer = Buffer.allocUnsafe(requestedBytes);
    let offset = 0;
    while (offset < requestedBytes) {
      throwIfCancelled(signal);
      const chunkLength = Math.min(READ_CHUNK_BYTES, requestedBytes - offset);
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        chunkLength,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      try {
        onReadChunk?.(candidate.path, bytesRead);
      } catch {
        // Observability callbacks must not fail filesystem work.
      }
    }

    throwIfCancelled(signal);
    const finalStat = await handle.stat();
    if (
      offset !== requestedBytes
      || !identitiesMatch(candidate.identity, identityFromStat(finalStat))
    ) {
      throw new CandidateChangedError(candidate.path, 'it changed while being read');
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

const WIDTH_METADATA_FIELDS = new Set([
  'exifimagewidth',
  'imagewidth',
  'pixelxdimension',
  'sourceimagewidth',
  'tiffwidth',
  'width',
]);

const HEIGHT_METADATA_FIELDS = new Set([
  'exifimageheight',
  'imageheight',
  'pixelydimension',
  'sourceimageheight',
  'tiffheight',
  'height',
]);

async function inspectImage(
  rootPath: string,
  candidate: ImageCandidate,
  warnings: WarningCollector,
  metadataBudget: MetadataByteBudget,
  metadataCharBudget: CharacterBudget,
  limits: CatalogLimits,
  signal?: AbortSignal,
  onReadChunk?: (filePath: string, bytesRead: number) => void,
): Promise<ImageFile> {
  let width: number | undefined;
  let height: number | undefined;

  if (candidate.extension !== '.pdf' && candidate.sizeBytes > 0) {
    try {
      const header = await readCandidatePrefix(
        rootPath,
        candidate,
        Math.min(candidate.sizeBytes, MAX_DIMENSION_HEADER_BYTES),
        signal,
        onReadChunk,
      );
      const dimensions = sizeOf(header);
      width = numericValue(dimensions.width);
      height = numericValue(dimensions.height);
    } catch (error) {
      if (
        error instanceof CandidateChangedError
        || error instanceof CatalogScanCancelledError
        || isAccessFailure(error)
      ) {
        throw error;
      }
      warnings.add('image-inspection-failed', candidate.path, errorMessage(error));
    }
  }

  throwIfCancelled(signal);
  let rawMetadata: unknown;
  if (candidate.extension !== '.pdf' && candidate.sizeBytes > 0) {
    const desiredBytes = Math.min(
      candidate.sizeBytes,
      limits.maxMetadataBytesPerFile,
    );
    const grantedBytes = metadataBudget.take(desiredBytes);
    if (grantedBytes < candidate.sizeBytes) {
      warnings.add(
        'metadata-skipped',
        rootPath,
        'Some metadata was skipped because per-file and total metadata input are bounded.',
      );
    }

    if (grantedBytes > 0) {
      try {
        const metadataBuffer = await readCandidatePrefix(
          rootPath,
          candidate,
          grantedBytes,
          signal,
          onReadChunk,
        );
        rawMetadata = await exifr.parse(metadataBuffer, {
          pick: [...METADATA_TAGS],
          makerNote: false,
          userComment: false,
          icc: false,
          sanitize: true,
          mergeOutput: true,
        });
      } catch (error) {
        if (
          error instanceof CandidateChangedError
          || error instanceof CatalogScanCancelledError
          || isAccessFailure(error)
        ) {
          throw error;
        }
        warnings.add('image-inspection-failed', candidate.path, errorMessage(error));
      }
    }
  }

  throwIfCancelled(signal);
  await validateCandidate(rootPath, candidate);
  width ??= findNumericMetadataField(rawMetadata, WIDTH_METADATA_FIELDS);
  height ??= findNumericMetadataField(rawMetadata, HEIGHT_METADATA_FIELDS);
  const retainedMetadata = retainMetadataWithinBudget(
    serializeMetadata(rawMetadata),
    metadataCharBudget,
  );
  if (retainedMetadata.truncated) {
    warnings.add(
      'metadata-skipped',
      rootPath,
      'Some metadata was skipped because retained catalog metadata is bounded.',
    );
  }

  return {
    id: createHash('sha256').update(candidate.path).digest('hex'),
    path: candidate.path,
    relativePath: candidate.relativePath,
    name: candidate.name,
    extension: candidate.extension,
    sizeBytes: candidate.sizeBytes,
    width,
    height,
    resolution: width !== undefined && height !== undefined
      ? `${width}x${height}`
      : undefined,
    metadata: retainedMetadata.metadata,
  };
}

export async function scanCatalog(
  rootPath: string,
  options: CatalogOptions,
): Promise<CatalogSnapshot> {
  const startedAt = Date.now();
  throwIfCancelled(options.signal);
  const canonicalRoot = await canonicalRootDirectory(rootPath);
  throwIfCancelled(options.signal);
  const limits = resolveLimits(options.limits);
  const warnings = new WarningCollector();
  const metadataBudget = new MetadataByteBudget(limits.maxMetadataBytesTotal);
  const metadataCharBudget = new CharacterBudget(limits.maxMetadataCharsTotal);
  const retainedPathBudget = new CharacterBudget(limits.maxRetainedPathChars);
  const progress: ScanProgress = {
    scanId: options.scanId,
    phase: 'walking',
    directoriesVisited: 0,
    filesVisited: 0,
    imagesFound: 0,
    processedImages: 0,
    totalImages: 0,
  };
  const reportProgress = createProgressReporter(progress, options.onProgress);
  reportProgress(true);

  const walkResult = await walkCatalog(
    canonicalRoot,
    warnings,
    progress,
    reportProgress,
    Math.max(1, Math.min(options.walkConcurrency ?? WALK_CONCURRENCY, 32)),
    limits,
    retainedPathBudget,
    options.signal,
  );

  throwIfCancelled(options.signal);
  progress.phase = 'metadata';
  progress.totalImages = walkResult.candidates.length;
  progress.currentPath = undefined;
  reportProgress(true);

  const inspectedImages = await mapWithConcurrency(
    walkResult.candidates,
    Math.max(
      1,
      Math.min(options.imageConcurrency ?? IMAGE_INSPECTION_CONCURRENCY, 32),
    ),
    async (candidate): Promise<ImageFile | null> => {
      try {
        const image = await inspectImage(
          canonicalRoot,
          candidate,
          warnings,
          metadataBudget,
          metadataCharBudget,
          limits,
          options.signal,
          options.onReadChunk,
        );
        try {
          options.onFileIdentity?.(candidate.path, { ...candidate.identity });
        } catch {
          // Identity bookkeeping must not turn a readable image into a scan failure.
        }
        return image;
      } catch (error) {
        if (error instanceof CatalogScanCancelledError) throw error;
        warnings.add(
          error instanceof CandidateChangedError || isAccessFailure(error)
            ? 'file-unreadable'
            : 'image-inspection-failed',
          candidate.path,
          errorMessage(error),
        );
        return null;
      } finally {
        progress.processedImages += 1;
        progress.currentPath = candidate.path;
        reportProgress();
      }
    },
    options.signal,
  );
  const images = inspectedImages.filter(
    (image): image is ImageFile => image !== null,
  );

  throwIfCancelled(options.signal);
  progress.phase = 'complete';
  progress.processedImages = walkResult.candidates.length;
  progress.totalImages = walkResult.candidates.length;
  progress.currentPath = undefined;
  reportProgress(true);

  return {
    rootPath: canonicalRoot,
    images,
    tree: walkResult.tree,
    warnings: warnings.toArray(),
    totalFiles: walkResult.totalFiles,
    durationMs: Date.now() - startedAt,
  };
}

export const catalogTesting = {
  CharacterBudget,
  serializeMetadata,
  retainMetadataWithinBudget,
  findNumericMetadataField,
  mapWithConcurrency,
  resolveLimits,
};
