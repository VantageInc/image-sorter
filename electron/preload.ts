import electronPackage from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  CatalogSnapshot,
  CopyRequest,
  CopyResult,
  DesktopApi,
  ScanProgress,
  ScanProgressListener,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';

const { contextBridge, ipcRenderer } = electronPackage;

const desktopApi = {
  openDirectory: () => (
    ipcRenderer.invoke(IPC_CHANNELS.openDirectory) as Promise<string | null>
  ),

  scanDirectory: (rootPath: string) => (
    ipcRenderer.invoke(
      IPC_CHANNELS.scanDirectory,
      rootPath,
    ) as Promise<CatalogSnapshot>
  ),

  cancelScan: () => (
    ipcRenderer.invoke(IPC_CHANNELS.cancelScan) as Promise<boolean>
  ),

  onScanProgress: (listener: ScanProgressListener) => {
    const handler = (_event: IpcRendererEvent, progress: ScanProgress) => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNELS.scanProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.scanProgress, handler);
    };
  },

  copyFiles: (request: CopyRequest) => (
    ipcRenderer.invoke(IPC_CHANNELS.copyFiles, request) as Promise<CopyResult>
  ),

  getThumbnail: (filePath: string) => (
    ipcRenderer.invoke(
      IPC_CHANNELS.getThumbnail,
      filePath,
    ) as Promise<string | null>
  ),

  showItemInFolder: (filePath: string) => (
    ipcRenderer.invoke(
      IPC_CHANNELS.showItemInFolder,
      filePath,
    ) as Promise<boolean>
  ),

  openPath: (filePath: string) => (
    ipcRenderer.invoke(
      IPC_CHANNELS.openPath,
      filePath,
    ) as Promise<boolean>
  ),

  minimize: () => {
    ipcRenderer.send(IPC_CHANNELS.minimize);
  },

  maximize: () => {
    ipcRenderer.send(IPC_CHANNELS.maximize);
  },

  close: () => {
    ipcRenderer.send(IPC_CHANNELS.close);
  },
} satisfies DesktopApi;

const frozenDesktopApi = Object.freeze(desktopApi);

contextBridge.exposeInMainWorld('desktopApi', frozenDesktopApi);
