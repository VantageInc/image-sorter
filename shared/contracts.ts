export interface ImageFile {
  id: string;
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  resolution?: string;
  metadata: Record<string, string>;
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DirectoryStatNode {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  itemsCount: number;
  filesCount: number;
  subdirsCount: number;
  children: DirectoryStatNode[];
}

export type ScanWarningCode =
  | 'directory-unreadable'
  | 'file-unreadable'
  | 'entry-skipped'
  | 'image-inspection-failed'
  | 'catalog-limit-reached'
  | 'metadata-skipped'
  | 'warnings-truncated';

export interface ScanWarning {
  code: ScanWarningCode;
  path: string;
  message: string;
}

export interface CatalogSnapshot {
  rootPath: string;
  images: ImageFile[];
  tree: DirectoryStatNode;
  warnings: ScanWarning[];
  totalFiles: number;
  durationMs: number;
}

export type ScanPhase = 'walking' | 'metadata' | 'complete';

export interface ScanProgress {
  scanId: string;
  phase: ScanPhase;
  directoriesVisited: number;
  filesVisited: number;
  imagesFound: number;
  processedImages: number;
  totalImages: number;
  currentPath?: string;
}

export interface CopyFileInput {
  path: string;
  relativePath: string;
  sizeBytes: number;
}

export interface CopyRequest {
  rootPath: string;
  targetDir: string;
  files: CopyFileInput[];
}

export interface CopyFailure {
  path: string;
  relativePath: string;
  targetPath?: string;
  code: string;
  message: string;
}

export interface CopyResult {
  success: boolean;
  copiedCount: number;
  renamedCount: number;
  failedCount: number;
  bytesCopied: number;
  targetDir: string;
  failures: CopyFailure[];
}

export type ScanProgressListener = (progress: ScanProgress) => void;

export interface DesktopApi {
  openDirectory(): Promise<string | null>;
  scanDirectory(rootPath: string): Promise<CatalogSnapshot>;
  cancelScan(): Promise<boolean>;
  onScanProgress(listener: ScanProgressListener): () => void;
  copyFiles(request: CopyRequest): Promise<CopyResult>;
  getThumbnail(filePath: string): Promise<string | null>;
  showItemInFolder(filePath: string): Promise<boolean>;
  openPath(filePath: string): Promise<boolean>;
  minimize(): void;
  maximize(): void;
  close(): void;
}

export const IPC_CHANNELS = {
  openDirectory: 'dialog:openDirectory',
  scanDirectory: 'app:scanDirectory',
  cancelScan: 'app:cancelScan',
  scanProgress: 'app:scanProgress',
  copyFiles: 'app:copyFiles',
  getThumbnail: 'app:getThumbnail',
  showItemInFolder: 'app:showItemInFolder',
  openPath: 'app:openPath',
  minimize: 'app:minimize',
  maximize: 'app:maximize',
  close: 'app:close',
} as const;
