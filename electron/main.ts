import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} from 'electron';
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';
import type {
  CopyFileInput,
  CopyRequest,
  FileIdentity,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';
import {
  CatalogScanCancelledError,
  scanCatalog,
} from './catalog';
import { copyCatalogFiles } from './copy-files';
import type { VerifiedCopyFileInput } from './copy-files';
import {
  PACKAGED_BLOCKED_URL_PATTERNS,
  trustedDevServerUrl,
} from './security-policy';
import { thumbnailManager } from './thumbnails';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(CURRENT_DIRECTORY, '..');
const MAIN_DIST = path.join(APP_ROOT, 'dist-electron');
const RENDERER_DIST = path.join(APP_ROOT, 'dist');

export const VITE_DEV_SERVER_URL = trustedDevServerUrl(
  process.env.VITE_DEV_SERVER_URL,
  app.isPackaged,
);
const APP_ICON_PATH = VITE_DEV_SERVER_URL
  ? path.join(APP_ROOT, 'public', 'icon.png')
  : path.join(RENDERER_DIST, 'icon.png');
const RENDERER_ENTRY_PATH = path.join(RENDERER_DIST, 'index.html');
const MAX_PATH_CHARS = 32_768;
const MAX_COPY_FILES = 100_000;

export { APP_ROOT, MAIN_DIST, RENDERER_DIST, APP_ICON_PATH };

process.env.APP_ROOT = APP_ROOT;
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(APP_ROOT, 'public')
  : RENDERER_DIST;

let mainWindow: BrowserWindow | null = null;
let scannedRootPath: string | null = null;
let allowedFilePaths = new Set<string>();
let allowedFileIdentities = new Map<string, FileIdentity>();
const selectedDirectoryPaths = new Set<string>();

interface ActiveScan {
  scanId: string;
  controller: AbortController;
}

let activeScan: ActiveScan | null = null;

function comparablePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function parseAbsolutePath(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PATH_CHARS
    || value.includes('\0')
    || !path.isAbsolute(value)
  ) {
    throw new Error(`${fieldName} must be a valid absolute path.`);
  }
  return path.resolve(value);
}

function parseNonNegativeNumber(value: unknown, fieldName: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`${fieldName} must be a non-negative safe integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCopyFileInput(value: unknown, index: number): CopyFileInput {
  if (!isRecord(value)) {
    throw new Error(`files[${index}] must be an object.`);
  }

  const filePath = parseAbsolutePath(value.path, `files[${index}].path`);
  if (
    typeof value.relativePath !== 'string'
    || value.relativePath.length === 0
    || value.relativePath.length > MAX_PATH_CHARS
    || value.relativePath.includes('\0')
  ) {
    throw new Error(`files[${index}].relativePath is invalid.`);
  }

  return {
    path: filePath,
    relativePath: value.relativePath,
    sizeBytes: parseNonNegativeNumber(
      value.sizeBytes,
      `files[${index}].sizeBytes`,
    ),
  };
}

function parseCopyRequest(value: unknown): CopyRequest {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error('The copy request is invalid.');
  }
  if (value.files.length > MAX_COPY_FILES) {
    throw new Error(`A copy request may contain at most ${MAX_COPY_FILES} files.`);
  }

  return {
    rootPath: parseAbsolutePath(value.rootPath, 'rootPath'),
    targetDir: parseAbsolutePath(value.targetDir, 'targetDir'),
    files: value.files.map(parseCopyFileInput),
  };
}

function trustedRendererUrl(rendererUrl: string): boolean {
  try {
    const parsed = new URL(rendererUrl);
    if (VITE_DEV_SERVER_URL) {
      return parsed.origin === new URL(VITE_DEV_SERVER_URL).origin;
    }

    if (parsed.protocol !== 'file:') return false;
    parsed.hash = '';
    parsed.search = '';
    return comparablePath(fileURLToPath(parsed)) === comparablePath(RENDERER_ENTRY_PATH);
  } catch {
    return false;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const window = mainWindow;
  return !(
    !window
    || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame
    || !trustedRendererUrl(event.senderFrame.url)
  );
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) {
    throw new Error('The IPC sender is not trusted.');
  }
}

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const realPath = await fs.realpath(directoryPath);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) throw new Error('The selected path is not a directory.');
  return realPath;
}

async function assertSelectedDirectory(
  value: unknown,
  fieldName: string,
): Promise<string> {
  const realPath = await canonicalDirectory(parseAbsolutePath(value, fieldName));
  if (!selectedDirectoryPaths.has(comparablePath(realPath))) {
    throw new Error(`${fieldName} was not selected by the user.`);
  }
  return realPath;
}

async function assertAllowedFile(value: unknown): Promise<string> {
  const requestedPath = parseAbsolutePath(value, 'filePath');
  if (!allowedFilePaths.has(comparablePath(requestedPath))) {
    throw new Error('The file is not part of the active catalog.');
  }

  const realPath = await fs.realpath(requestedPath);
  if (!allowedFilePaths.has(comparablePath(realPath))) {
    throw new Error('The file no longer resolves inside the active catalog.');
  }
  return realPath;
}

async function assertAllowedFileOrSelectedDirectory(
  value: unknown,
): Promise<string> {
  const requestedPath = parseAbsolutePath(value, 'path');
  if (allowedFilePaths.has(comparablePath(requestedPath))) {
    return assertAllowedFile(requestedPath);
  }

  const realPath = await canonicalDirectory(requestedPath);
  if (!selectedDirectoryPaths.has(comparablePath(realPath))) {
    throw new Error('The path is neither a catalog file nor a selected directory.');
  }
  return realPath;
}

function abortActiveScan(): boolean {
  if (!activeScan) return false;
  activeScan.controller.abort();
  activeScan = null;
  return true;
}

function configureWindowSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    frame: false,
    icon: APP_ICON_PATH,
    backgroundColor: '#f3f3f3',
    webPreferences: {
      preload: path.join(CURRENT_DIRECTORY, 'preload.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow = window;
  configureWindowSecurity(window);

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    abortActiveScan();
    thumbnailManager.invalidate();
    allowedFilePaths = new Set<string>();
    allowedFileIdentities = new Map<string, FileIdentity>();
    scannedRootPath = null;
  });

  const loadPromise = !app.isPackaged && VITE_DEV_SERVER_URL
    ? window.loadURL(VITE_DEV_SERVER_URL)
    : window.loadFile(RENDERER_ENTRY_PATH);
  void loadPromise.catch(() => {
    if (!window.isDestroyed()) window.destroy();
  });

  return window;
}

ipcMain.handle(
  IPC_CHANNELS.openDirectory,
  async (event: IpcMainInvokeEvent): Promise<string | null> => {
    assertTrustedSender(event);
    const window = mainWindow;
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const selectedPath = await canonicalDirectory(result.filePaths[0]);
    selectedDirectoryPaths.add(comparablePath(selectedPath));
    return selectedPath;
  },
);

ipcMain.handle(
  IPC_CHANNELS.scanDirectory,
  async (event: IpcMainInvokeEvent, rootValue: unknown) => {
    assertTrustedSender(event);
    const rootPath = await assertSelectedDirectory(rootValue, 'rootPath');

    abortActiveScan();
    thumbnailManager.invalidate();
    allowedFilePaths = new Set<string>();
    allowedFileIdentities = new Map<string, FileIdentity>();
    scannedRootPath = null;

    const operation: ActiveScan = {
      scanId: randomUUID(),
      controller: new AbortController(),
    };
    activeScan = operation;
    const sender = event.sender;
    const scannedFileIdentities = new Map<string, FileIdentity>();

    try {
      const snapshot = await scanCatalog(rootPath, {
        scanId: operation.scanId,
        signal: operation.controller.signal,
        onProgress: (progress) => {
          if (
            activeScan?.scanId === operation.scanId
            && !sender.isDestroyed()
          ) {
            sender.send(IPC_CHANNELS.scanProgress, progress);
          }
        },
        onFileIdentity: (filePath, identity) => {
          scannedFileIdentities.set(comparablePath(filePath), identity);
        },
      });

      if (activeScan?.scanId !== operation.scanId) {
        throw new CatalogScanCancelledError();
      }

      scannedRootPath = snapshot.rootPath;
      allowedFilePaths = new Set(
        snapshot.images.map((image) => comparablePath(image.path)),
      );
      allowedFileIdentities = new Map(
        snapshot.images.flatMap((image) => {
          const key = comparablePath(image.path);
          const identity = scannedFileIdentities.get(key);
          return identity ? [[key, identity] as const] : [];
        }),
      );
      return snapshot;
    } finally {
      if (activeScan?.scanId === operation.scanId) {
        activeScan = null;
      }
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.cancelScan,
  async (event: IpcMainInvokeEvent): Promise<boolean> => {
    assertTrustedSender(event);
    return abortActiveScan();
  },
);

ipcMain.handle(
  IPC_CHANNELS.copyFiles,
  async (event: IpcMainInvokeEvent, requestValue: unknown) => {
    assertTrustedSender(event);
    const request = parseCopyRequest(requestValue);
    const rootPath = await assertSelectedDirectory(request.rootPath, 'rootPath');
    const targetDir = await assertSelectedDirectory(request.targetDir, 'targetDir');

    if (!scannedRootPath || comparablePath(rootPath) !== comparablePath(scannedRootPath)) {
      throw new Error('The copy root is not the active catalog root.');
    }

    const files: VerifiedCopyFileInput[] = request.files.map((file) => {
      const key = comparablePath(file.path);
      if (!allowedFilePaths.has(key)) {
        throw new Error('A requested source is not part of the active catalog.');
      }
      const catalogIdentity = allowedFileIdentities.get(key);
      if (!catalogIdentity) {
        throw new Error('The requested source has no catalog identity.');
      }
      return {
        ...file,
        catalogIdentity: { ...catalogIdentity },
      };
    });

    return copyCatalogFiles({ rootPath, targetDir, files });
  },
);

ipcMain.handle(
  IPC_CHANNELS.getThumbnail,
  async (event: IpcMainInvokeEvent, fileValue: unknown): Promise<string | null> => {
    assertTrustedSender(event);
    const filePath = await assertAllowedFile(fileValue);
    return thumbnailManager.getThumbnail(filePath);
  },
);

ipcMain.handle(
  IPC_CHANNELS.showItemInFolder,
  async (event: IpcMainInvokeEvent, fileValue: unknown): Promise<boolean> => {
    assertTrustedSender(event);
    const filePath = await assertAllowedFile(fileValue);
    shell.showItemInFolder(filePath);
    return true;
  },
);

ipcMain.handle(
  IPC_CHANNELS.openPath,
  async (event: IpcMainInvokeEvent, fileValue: unknown): Promise<boolean> => {
    assertTrustedSender(event);
    const allowedPath = await assertAllowedFileOrSelectedDirectory(fileValue);
    return (await shell.openPath(allowedPath)) === '';
  },
);

ipcMain.on(IPC_CHANNELS.minimize, (event: IpcMainEvent) => {
  if (!isTrustedSender(event)) return;
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on(IPC_CHANNELS.maximize, (event: IpcMainEvent) => {
  if (!isTrustedSender(event)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
});

ipcMain.on(IPC_CHANNELS.close, (event: IpcMainEvent) => {
  if (!isTrustedSender(event)) return;
  BrowserWindow.fromWebContents(event.sender)?.close();
});

app.on('before-quit', () => {
  abortActiveScan();
  thumbnailManager.invalidate();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

void app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.on('will-download', (event) => {
    event.preventDefault();
  });
  if (app.isPackaged) {
    session.defaultSession.webRequest.onBeforeRequest(
      {
        urls: [...PACKAGED_BLOCKED_URL_PATTERNS],
      },
      (_details, callback) => callback({ cancel: true }),
    );
  }
  createWindow();
});
