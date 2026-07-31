import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CopyFailure,
  CopyFileInput,
  CopyRequest,
  CopyResult,
  FileIdentity,
} from '../shared/contracts';

const MAX_RENAME_ATTEMPTS = 10_000;
const MAX_TEMP_ATTEMPTS = 16;
const COPY_BUFFER_BYTES = 1024 * 1024;
const HARD_LINK_FALLBACK_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

interface PublishOperations {
  link: (existingPath: string, newPath: string) => Promise<void>;
  copyFile: (
    sourcePath: string,
    destinationPath: string,
    mode: number,
  ) => Promise<void>;
  syncFile: (filePath: string) => Promise<void>;
}

export interface VerifiedCopyFileInput extends CopyFileInput {
  catalogIdentity: FileIdentity;
}

export interface VerifiedCopyRequest extends Omit<CopyRequest, 'files'> {
  files: VerifiedCopyFileInput[];
}

class SourceChangedError extends Error {
  readonly code = 'SOURCE_CHANGED';

  constructor(message = 'The source changed after the catalog was created.') {
    super(message);
    this.name = 'SourceChangedError';
  }
}

function comparablePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

export function pathsMatch(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function isPathInsideOrEqual(
  rootPath: string,
  candidatePath: string,
): boolean {
  return pathsMatch(rootPath, candidatePath) || isPathInside(rootPath, candidatePath);
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'COPY_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureFor(
  input: CopyFileInput,
  code: string,
  message: string,
  targetPath?: string,
): CopyFailure {
  return {
    path: input.path,
    relativePath: input.relativePath,
    targetPath,
    code,
    message,
  };
}

function resultWithFailures(
  request: CopyRequest,
  code: string,
  message: string,
): CopyResult {
  const failures = request.files.map(
    (input) => failureFor(input, code, message),
  );
  return {
    success: failures.length === 0,
    copiedCount: 0,
    renamedCount: 0,
    failedCount: failures.length,
    bytesCopied: 0,
    targetDir: request.targetDir,
    failures,
  };
}

export function destinationWithCounter(
  desiredPath: string,
  counter: number,
): string {
  if (counter <= 1) return desiredPath;
  const parsed = path.parse(desiredPath);
  return path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  return (
    normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`)
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

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const realPath = await fs.realpath(path.resolve(directoryPath));
  const linkStat = await fs.lstat(realPath);
  const stat = await fs.stat(realPath);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory() || !stat.isDirectory()) {
    throw new Error('The path is not a regular directory.');
  }
  return realPath;
}

async function ensureSafeDestinationParent(
  targetRealPath: string,
  derivedRelativePath: string,
): Promise<string> {
  const relativeParent = path.dirname(derivedRelativePath);
  if (relativeParent === '.') return targetRealPath;

  let currentPath = targetRealPath;
  for (const segment of relativeParent.split(path.sep)) {
    if (!segment || segment === '.') continue;
    const nextPath = path.join(currentPath, segment);
    try {
      await fs.mkdir(nextPath);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const linkStat = await fs.lstat(nextPath);
    if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
      const unsafeError = new Error(
        'A destination path component is not a regular directory.',
      ) as Error & { code: string };
      unsafeError.code = 'TARGET_SYMLINK_ESCAPE';
      throw unsafeError;
    }

    const realPath = await fs.realpath(nextPath);
    if (!isPathInsideOrEqual(targetRealPath, realPath)) {
      const escapeError = new Error(
        'A destination directory resolves outside the selected target.',
      ) as Error & { code: string };
      escapeError.code = 'TARGET_SYMLINK_ESCAPE';
      throw escapeError;
    }
    currentPath = realPath;
  }
  return currentPath;
}

async function revalidateSourcePath(
  sourceRealPath: string,
  expected: FileIdentity,
): Promise<void> {
  const linkStat = await fs.lstat(sourceRealPath);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new SourceChangedError('The source is no longer a regular file.');
  }
  const realPath = await fs.realpath(sourceRealPath);
  if (!pathsMatch(realPath, sourceRealPath)) {
    throw new SourceChangedError('The source canonical path changed.');
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile() || !identitiesMatch(expected, identityFromStat(stat))) {
    throw new SourceChangedError();
  }
}

async function revalidateDestinationParent(
  targetRealPath: string,
  destinationParent: string,
): Promise<void> {
  const linkStat = await fs.lstat(destinationParent);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    const error = new Error(
      'The destination directory changed before publication.',
    ) as Error & { code: string };
    error.code = 'TARGET_CHANGED';
    throw error;
  }

  const realPath = await fs.realpath(destinationParent);
  if (
    !pathsMatch(realPath, destinationParent)
    || !isPathInsideOrEqual(targetRealPath, realPath)
  ) {
    const error = new Error(
      'The destination directory no longer resolves inside the selected target.',
    ) as Error & { code: string };
    error.code = 'TARGET_CHANGED';
    throw error;
  }
}

async function stageSourceFile(
  sourceRealPath: string,
  destinationParent: string,
  expected: FileIdentity,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const temporaryPath = path.join(
      destinationParent,
      `.image-sorter-${randomUUID()}.tmp`,
    );
    let sourceHandle: fs.FileHandle | undefined;
    let temporaryHandle: fs.FileHandle | undefined;
    try {
      sourceHandle = await fs.open(sourceRealPath, 'r');
      const openedSourceStat = await sourceHandle.stat();
      if (
        !openedSourceStat.isFile()
        || !identitiesMatch(expected, identityFromStat(openedSourceStat))
      ) {
        throw new SourceChangedError('The source changed before it was opened.');
      }

      temporaryHandle = await fs.open(temporaryPath, 'wx');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let position = 0;
      while (position < expected.size) {
        const bytesRequested = Math.min(buffer.length, expected.size - position);
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          bytesRequested,
          position,
        );
        if (bytesRead <= 0) {
          throw new SourceChangedError('The source ended while it was copied.');
        }

        let written = 0;
        while (written < bytesRead) {
          const result = await temporaryHandle.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten <= 0) {
            throw new Error('The temporary copy could not be written.');
          }
          written += result.bytesWritten;
        }
        position += bytesRead;
      }

      const finalSourceStat = await sourceHandle.stat();
      if (!identitiesMatch(expected, identityFromStat(finalSourceStat))) {
        throw new SourceChangedError('The source changed while it was copied.');
      }
      await revalidateSourcePath(sourceRealPath, expected);
      await temporaryHandle.sync();
      return temporaryPath;
    } catch (error) {
      await temporaryHandle?.close().catch(() => undefined);
      temporaryHandle = undefined;
      await sourceHandle?.close().catch(() => undefined);
      sourceHandle = undefined;
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
    }
  }
  const error = new Error('A unique temporary file could not be created.') as
    Error & { code: string };
  error.code = 'TEMP_NAME_CONFLICT';
  throw error;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishTemporaryFile(
  temporaryPath: string,
  destinationPath: string,
  operations: Partial<PublishOperations> = {},
): Promise<void> {
  const linkFile = operations.link ?? fs.link;
  const copyFile = operations.copyFile ?? fs.copyFile;
  const syncPublishedFile = operations.syncFile ?? syncFile;
  try {
    await linkFile(temporaryPath, destinationPath);
    return;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') throw error;
    if (!HARD_LINK_FALLBACK_CODES.has(code)) throw error;
  }

  let destinationCreated = false;
  try {
    await copyFile(
      temporaryPath,
      destinationPath,
      constants.COPYFILE_EXCL,
    );
    destinationCreated = true;
    await syncPublishedFile(destinationPath);
  } catch (error) {
    if (destinationCreated) {
      await fs.rm(destinationPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function copyOneFile(
  rootRealPath: string,
  targetRealPath: string,
  input: VerifiedCopyFileInput,
): Promise<
  | { copied: true; renamed: boolean; bytesCopied: number }
  | { copied: false; failure: CopyFailure }
> {
  if (!isSafeRelativePath(input.relativePath)) {
    return {
      copied: false,
      failure: failureFor(input, 'INVALID_RELATIVE_PATH', 'The relative path is not safe.'),
    };
  }

  const advertisedInputPath = path.resolve(input.path);
  try {
    const linkStat = await fs.lstat(advertisedInputPath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new SourceChangedError('The source is no longer a regular file.');
    }
  } catch (error) {
    return {
      copied: false,
      failure: failureFor(input, errorCode(error), errorMessage(error)),
    };
  }

  let sourceRealPath: string;
  try {
    sourceRealPath = await fs.realpath(advertisedInputPath);
  } catch (error) {
    return {
      copied: false,
      failure: failureFor(input, errorCode(error), errorMessage(error)),
    };
  }

  if (!isPathInside(rootRealPath, sourceRealPath)) {
    return {
      copied: false,
      failure: failureFor(
        input,
        'SOURCE_OUTSIDE_ROOT',
        'The source file is outside the scanned root.',
      ),
    };
  }

  const advertisedSourcePath = path.resolve(rootRealPath, input.relativePath);
  if (
    !pathsMatch(advertisedInputPath, sourceRealPath)
    || !pathsMatch(advertisedSourcePath, sourceRealPath)
  ) {
    return {
      copied: false,
      failure: failureFor(
        input,
        'RELATIVE_PATH_MISMATCH',
        'The relative path does not identify the source file.',
      ),
    };
  }

  let sourceStat: Stats;
  try {
    sourceStat = await fs.stat(sourceRealPath);
  } catch (error) {
    return {
      copied: false,
      failure: failureFor(input, errorCode(error), errorMessage(error)),
    };
  }

  if (!sourceStat.isFile()) {
    return {
      copied: false,
      failure: failureFor(input, 'SOURCE_NOT_FILE', 'The source is not a regular file.'),
    };
  }
  if (
    !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes !== input.catalogIdentity.size
    || !identitiesMatch(
      input.catalogIdentity,
      identityFromStat(sourceStat),
    )
  ) {
    return {
      copied: false,
      failure: failureFor(
        input,
        'SOURCE_CHANGED',
        'The source identity changed after the catalog was created.',
      ),
    };
  }

  const sourceIdentity = { ...input.catalogIdentity };
  const derivedRelativePath = path.relative(rootRealPath, sourceRealPath);
  const desiredPath = path.resolve(targetRealPath, derivedRelativePath);
  if (!isPathInside(targetRealPath, desiredPath)) {
    return {
      copied: false,
      failure: failureFor(
        input,
        'TARGET_OUTSIDE_ROOT',
        'The destination path escapes the selected target.',
      ),
    };
  }

  let destinationParent: string;
  try {
    destinationParent = await ensureSafeDestinationParent(
      targetRealPath,
      derivedRelativePath,
    );
  } catch (error) {
    return {
      copied: false,
      failure: failureFor(
        input,
        errorCode(error),
        errorMessage(error),
        desiredPath,
      ),
    };
  }

  const safeDesiredPath = path.join(
    destinationParent,
    path.basename(derivedRelativePath),
  );
  let temporaryPath: string;
  try {
    temporaryPath = await stageSourceFile(
      sourceRealPath,
      destinationParent,
      sourceIdentity,
    );
  } catch (error) {
    return {
      copied: false,
      failure: failureFor(
        input,
        errorCode(error),
        errorMessage(error),
        safeDesiredPath,
      ),
    };
  }

  try {
    for (let counter = 1; counter <= MAX_RENAME_ATTEMPTS; counter += 1) {
      const destinationPath = destinationWithCounter(safeDesiredPath, counter);
      try {
        await revalidateSourcePath(sourceRealPath, sourceIdentity);
        await revalidateDestinationParent(targetRealPath, destinationParent);
        await publishTemporaryFile(temporaryPath, destinationPath);
        await syncDirectoryBestEffort(destinationParent);
        return {
          copied: true,
          renamed: counter > 1,
          bytesCopied: sourceStat.size,
        };
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue;
        return {
          copied: false,
          failure: failureFor(
            input,
            errorCode(error),
            errorMessage(error),
            destinationPath,
          ),
        };
      }
    }

    return {
      copied: false,
      failure: failureFor(
        input,
        'TOO_MANY_CONFLICTS',
        'No unused destination name could be found.',
        safeDesiredPath,
      ),
    };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function copyCatalogFiles(
  request: VerifiedCopyRequest,
): Promise<CopyResult> {
  const resolvedRootPath = path.resolve(request.rootPath);
  const resolvedTargetPath = path.resolve(request.targetDir);
  if (
    isPathInsideOrEqual(resolvedRootPath, resolvedTargetPath)
    || isPathInsideOrEqual(resolvedTargetPath, resolvedRootPath)
  ) {
    return resultWithFailures(
      request,
      'ROOTS_OVERLAP',
      'The source and export directories must not contain one another.',
    );
  }

  let rootRealPath: string;
  let targetRealPath: string;
  try {
    rootRealPath = await canonicalDirectory(resolvedRootPath);
    await fs.mkdir(resolvedTargetPath, { recursive: true });
    targetRealPath = await canonicalDirectory(resolvedTargetPath);
  } catch (error) {
    return resultWithFailures(request, errorCode(error), errorMessage(error));
  }

  if (
    isPathInsideOrEqual(rootRealPath, targetRealPath)
    || isPathInsideOrEqual(targetRealPath, rootRealPath)
  ) {
    return resultWithFailures(
      request,
      'ROOTS_OVERLAP',
      'The canonical source and export directories must not contain one another.',
    );
  }

  const failures: CopyFailure[] = [];
  let copiedCount = 0;
  let renamedCount = 0;
  let bytesCopied = 0;

  for (const input of request.files) {
    const result = await copyOneFile(rootRealPath, targetRealPath, input);
    if (!result.copied) {
      failures.push(result.failure);
      continue;
    }

    copiedCount += 1;
    if (result.renamed) renamedCount += 1;
    bytesCopied += result.bytesCopied;
  }

  return {
    success: failures.length === 0,
    copiedCount,
    renamedCount,
    failedCount: failures.length,
    bytesCopied,
    targetDir: targetRealPath,
    failures,
  };
}

export const copyTesting = {
  publishTemporaryFile,
};
