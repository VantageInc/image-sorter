import { app, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import sizeOf from 'image-size';
import exifr from 'exifr';
import fsExtra from 'fs-extra';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '..');

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

import type { BrowserWindow as BrowserWindowType } from 'electron';

let win: BrowserWindowType | null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    frame: false,
    backgroundColor: '#f3f3f3',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.mjs'),
    }
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  // Open DevTools immediately to investigate the unclickable issue
  // win.webContents.openDevTools();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(createWindow);

// IPC Handlers

// 1. Select a directory
ipcMain.handle('dialog:openDirectory', async () => {
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  });
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return filePaths[0];
});

// Supported image extensions including psd, svg, etc.
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.psd', '.tiff', '.tif', '.bmp', '.ico'
]);

export interface ImageFile {
  id: string;
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  resolution?: string; // e.g. "1920x1080"
  metadata?: Record<string, string>;
}

// Helper to recursively read directory
async function getFiles(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  }));
  return Array.prototype.concat(...files);
}

// 2. Scan a directory for images
ipcMain.handle('app:scanDirectory', async (_, dirPath: string) => {
  if (!dirPath) return [];

  try {
    const allFiles = await getFiles(dirPath);
    const images: ImageFile[] = [];

    for (const file of allFiles) {
      const ext = path.extname(file).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const stats = await fs.stat(file);
          const name = path.basename(file);
          let width, height, resolution;

          // Try to get dimensions using image-size via chunk reading (solves v2 string path bug and is fast for network drives)
          let fileHandle;
          try {
            fileHandle = await fs.open(file, 'r');
            // 100KB is usually enough for the header metadata of most image formats
            const buffer = Buffer.alloc(100 * 1024);
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
            const dimensions = sizeOf(buffer.subarray(0, bytesRead));

            width = dimensions.width;
            height = dimensions.height;
            if (width && height) {
              resolution = `${width}x${height}`;
            }
          } catch (e) {
            console.error(`Error getting dimensions for ${file}:`, e);
            // Unreadable dimensions, skip setting resolution but still include it
          } finally {
            if (fileHandle) {
              await fileHandle.close().catch(console.error);
            }
          }

          // Extract generic EXIF/XMP/IPTC metadata dynamically
          let metadata: Record<string, string> = {};
          try {
            // Only read standard text blocks, ignore huge binary thumbs
            const rawMeta = await exifr.parse(file, { xmp: true, iptc: true, exif: true, tiff: true, icc: false });
            if (rawMeta) {
              for (const [key, value] of Object.entries(rawMeta)) {
                // Keep only top-level primitives that make sense as filters
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                  metadata[key] = String(value);
                }
              }
            }
          } catch (e) {
            // Silently ignore files with broken or no metadata
          }

          images.push({
            id: Buffer.from(String(file)).toString('base64'), // Simple unique ID
            path: file,
            name,
            extension: ext,
            sizeBytes: stats.size,
            width,
            height,
            resolution,
            metadata
          });
        } catch (fileErr) {
          console.error(`Error reading file ${file}:`, fileErr);
        }
      }
    }
    return images;
  } catch (err) {
    console.error(`Error scanning directory ${dirPath}:`, err);
    throw err;
  }
});

// 3. Copy files to a new directory
ipcMain.handle('app:copyFiles', async (_, filePaths: string[], targetDir: string) => {
  try {
    let copiedCount = 0;
    // ensure target exists
    await fsExtra.ensureDir(targetDir);

    for (const src of filePaths) {
      const dest = path.join(targetDir, path.basename(src));
      await fsExtra.copy(src, dest, { overwrite: true });
      copiedCount++;
    }
    return { success: true, copiedCount };
  } catch (error: any) {
    console.error('Error copying files:', error);
    return { success: false, error: error.message };
  }
});

// 4. Get deep directory stats (TreeSize clone)
export interface DirectoryStatNode {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  itemsCount: number;
  filesCount: number;
  subdirsCount: number;
  children?: DirectoryStatNode[];
}

async function getDirectoryStatsRecursive(dirPath: string, name: string): Promise<DirectoryStatNode> {
  const node: DirectoryStatNode = {
    name,
    path: dirPath,
    isDirectory: true,
    sizeBytes: 0,
    itemsCount: 0,
    filesCount: 0,
    subdirsCount: 0,
    children: []
  };

  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });

    // Process items in parallel chunks to speed up the read but avoid EMFILE errors
    const chunkSize = 20;
    for (let i = 0; i < dirents.length; i += chunkSize) {
      const chunk = dirents.slice(i, i + chunkSize);

      const results = await Promise.all(chunk.map(async (dirent) => {
        const fullPath = path.join(dirPath, dirent.name);
        try {
          if (dirent.isDirectory()) {
            const childNode = await getDirectoryStatsRecursive(fullPath, dirent.name);
            node.sizeBytes += childNode.sizeBytes;
            node.filesCount += childNode.filesCount;
            node.subdirsCount += childNode.subdirsCount + 1; // +1 for the directory itself
            node.itemsCount += childNode.itemsCount + 1;
            return childNode;
          } else {
            const stats = await fs.stat(fullPath);
            node.sizeBytes += stats.size;
            node.filesCount += 1;
            node.itemsCount += 1;

            return {
              name: dirent.name,
              path: fullPath,
              isDirectory: false,
              sizeBytes: stats.size,
              itemsCount: 0,
              filesCount: 0,
              subdirsCount: 0
            };
          }
        } catch (e) {
          console.error(`Error reading stat for ${fullPath}`, e);
          return null;
        }
      }));

      for (const res of results) {
        if (res && res.isDirectory) { // We only store directories in the children array for the tree view to save memory
          node.children!.push(res);
        }
      }
    }

    // Sort children by size descending
    node.children!.sort((a, b) => b.sizeBytes - a.sizeBytes);

  } catch (err) {
    console.error(`Error reading directory ${dirPath}`, err);
  }

  return node;
}

ipcMain.handle('app:getDirectoryStats', async (_, dirPath: string) => {
  if (!dirPath) return null;
  try {
    const rootName = path.basename(dirPath) || dirPath;
    const stats = await getDirectoryStatsRecursive(dirPath, rootName);
    return stats;
  } catch (e) {
    console.error(`Error getting directory stats out for ${dirPath}`, e);
    return null;
  }
});

ipcMain.handle('app:getThumbnail', async (_, filePath: string) => {
  try {
    const size = { width: 400, height: 400 };
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, size);
    return thumbnail.toDataURL();
  } catch (error) {
    console.error(`Error getting thumbnail for ${filePath}:`, error);
    return null;
  }
});

// Window Controls
ipcMain.on('app:minimize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.on('app:maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
});

ipcMain.on('app:close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});
