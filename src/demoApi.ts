import type {
  CatalogSnapshot,
  CopyRequest,
  CopyResult,
  DesktopApi,
  DirectoryStatNode,
  ImageFile,
  ScanProgress,
  ScanProgressListener,
} from '../shared/contracts';

export const DEMO_ROOT_PATH = 'C:\\Archive\\Campaign selects';
const DEMO_ASSET_BASE = `${import.meta.env.BASE_URL}demo/`;

type DemoScenario =
  | 'populated'
  | 'idle'
  | 'scanning'
  | 'scan-error'
  | 'empty'
  | 'copy-error'
  | 'thumbnail-error';

const MB = 1024 * 1024;

const demoImages: ImageFile[] = [
  {
    id: 'demo-001',
    path: `${DEMO_ROOT_PATH}\\Editorial\\harbor_contact_sheet_01.jpg`,
    relativePath: 'Editorial\\harbor_contact_sheet_01.jpg',
    name: 'harbor_contact_sheet_01.jpg',
    extension: '.jpg',
    sizeBytes: 8.4 * MB,
    width: 4096,
    height: 2731,
    resolution: '4096x2731',
    metadata: {
      'EXIF.Camera': 'Leica Q3',
      'EXIF.Captured': '2026-06-18 07:42',
      'EXIF.Exposure': '1/500 sec at f/5.6',
      'IPTC.Keywords': 'harbor, editorial, dawn',
      'XMP.Rating': '5',
      Copyright: 'Archive Studio',
    },
  },
  {
    id: 'demo-002',
    path: `${DEMO_ROOT_PATH}\\Editorial\\harbor_contact_sheet_02.jpg`,
    relativePath: 'Editorial\\harbor_contact_sheet_02.jpg',
    name: 'harbor_contact_sheet_02.jpg',
    extension: '.jpg',
    sizeBytes: 7.9 * MB,
    width: 4096,
    height: 2731,
    resolution: '4096x2731',
    metadata: {
      'EXIF.Camera': 'Leica Q3',
      'EXIF.Captured': '2026-06-18 07:44',
      'IPTC.Keywords': 'harbor, editorial, dawn',
      'XMP.Label': 'Select',
    },
  },
  {
    id: 'demo-003',
    path: `${DEMO_ROOT_PATH}\\Editorial\\portrait_window_keylight.tif`,
    relativePath: 'Editorial\\portrait_window_keylight.tif',
    name: 'portrait_window_keylight.tif',
    extension: '.tif',
    sizeBytes: 38.2 * MB,
    width: 4000,
    height: 5000,
    resolution: '4000x5000',
    metadata: {
      'EXIF.Camera': 'Nikon Z8',
      'EXIF.Captured': '2026-06-19 13:08',
      'IPTC.Keywords': 'portrait, window, keylight',
      'XMP.Rating': '4',
    },
  },
  {
    id: 'demo-004',
    path: `${DEMO_ROOT_PATH}\\Product\\graphite_pack_front.png`,
    relativePath: 'Product\\graphite_pack_front.png',
    name: 'graphite_pack_front.png',
    extension: '.png',
    sizeBytes: 4.7 * MB,
    width: 2400,
    height: 2400,
    resolution: '2400x2400',
    metadata: {
      'IPTC.Keywords': 'product, graphite, packshot',
      'XMP.ColorSpace': 'sRGB',
      Copyright: 'Archive Studio',
    },
  },
  {
    id: 'demo-005',
    path: `${DEMO_ROOT_PATH}\\Product\\graphite_pack_detail.png`,
    relativePath: 'Product\\graphite_pack_detail.png',
    name: 'graphite_pack_detail.png',
    extension: '.png',
    sizeBytes: 5.1 * MB,
    width: 2400,
    height: 2400,
    resolution: '2400x2400',
    metadata: {
      'IPTC.Keywords': 'product, graphite, detail',
      'XMP.ColorSpace': 'sRGB',
    },
  },
  {
    id: 'demo-006',
    path: `${DEMO_ROOT_PATH}\\Product\\archive_case_open.psd`,
    relativePath: 'Product\\archive_case_open.psd',
    name: 'archive_case_open.psd',
    extension: '.psd',
    sizeBytes: 126.8 * MB,
    width: 3200,
    height: 2400,
    resolution: '3200x2400',
    metadata: {
      'XMP.CreatorTool': 'Adobe Photoshop 27.1',
      'XMP.LayerCount': '18',
      'IPTC.Keywords': 'product, archive, working-file',
    },
  },
  {
    id: 'demo-007',
    path: `${DEMO_ROOT_PATH}\\Social\\launch_square_green.webp`,
    relativePath: 'Social\\launch_square_green.webp',
    name: 'launch_square_green.webp',
    extension: '.webp',
    sizeBytes: 1.2 * MB,
    width: 1080,
    height: 1080,
    resolution: '1080x1080',
    metadata: {
      'XMP.Campaign': 'Launch 26',
      'IPTC.Keywords': 'social, launch, green',
    },
  },
  {
    id: 'demo-008',
    path: `${DEMO_ROOT_PATH}\\Social\\launch_story_amber.webp`,
    relativePath: 'Social\\launch_story_amber.webp',
    name: 'launch_story_amber.webp',
    extension: '.webp',
    sizeBytes: 1.7 * MB,
    width: 1080,
    height: 1920,
    resolution: '1080x1920',
    metadata: {
      'XMP.Campaign': 'Launch 26',
      'IPTC.Keywords': 'social, launch, amber, story',
    },
  },
  {
    id: 'demo-009',
    path: `${DEMO_ROOT_PATH}\\Social\\launch_story_graphite.webp`,
    relativePath: 'Social\\launch_story_graphite.webp',
    name: 'launch_story_graphite.webp',
    extension: '.webp',
    sizeBytes: 1.6 * MB,
    width: 1080,
    height: 1920,
    resolution: '1080x1920',
    metadata: {
      'XMP.Campaign': 'Launch 26',
      'IPTC.Keywords': 'social, launch, graphite, story',
    },
  },
  {
    id: 'demo-010',
    path: `${DEMO_ROOT_PATH}\\References\\material_reference_missing.heic`,
    relativePath: 'References\\material_reference_missing.heic',
    name: 'material_reference_missing.heic',
    extension: '.heic',
    sizeBytes: 3.3 * MB,
    width: 3024,
    height: 4032,
    resolution: '3024x4032',
    metadata: {
      'EXIF.Camera': 'iPhone 17 Pro',
      'IPTC.Keywords': 'reference, material',
    },
  },
  {
    id: 'demo-011',
    path: `${DEMO_ROOT_PATH}\\References\\scan_ledger_front.tif`,
    relativePath: 'References\\scan_ledger_front.tif',
    name: 'scan_ledger_front.tif',
    extension: '.tif',
    sizeBytes: 22.4 * MB,
    width: 2550,
    height: 3300,
    resolution: '2550x3300',
    metadata: {
      'XMP.Source': 'Flatbed scan',
      'IPTC.Keywords': 'reference, ledger, scan',
    },
  },
  {
    id: 'demo-012',
    path: `${DEMO_ROOT_PATH}\\References\\legacy_mark.ai`,
    relativePath: 'References\\legacy_mark.ai',
    name: 'legacy_mark.ai',
    extension: '.ai',
    sizeBytes: 12.1 * MB,
    metadata: {
      'XMP.CreatorTool': 'Adobe Illustrator 29.4',
      'IPTC.Keywords': 'reference, identity, vector',
    },
  },
];

function directory(
  name: string,
  path: string,
  images: ImageFile[],
): DirectoryStatNode {
  const sizeBytes = images.reduce((sum, image) => sum + image.sizeBytes, 0);
  return {
    name,
    path,
    isDirectory: true,
    sizeBytes,
    itemsCount: images.length,
    filesCount: images.length,
    subdirsCount: 0,
    children: [],
  };
}

function createDemoTree(images: ImageFile[]): DirectoryStatNode {
  const childNames = ['Editorial', 'Product', 'Social', 'References'];
  const children = childNames.map((name) => {
    const path = `${DEMO_ROOT_PATH}\\${name}`;
    return directory(
      name,
      path,
      images.filter((image) => image.path.startsWith(`${path}\\`)),
    );
  });
  return {
    name: 'Campaign selects',
    path: DEMO_ROOT_PATH,
    isDirectory: true,
    sizeBytes: children.reduce((sum, child) => sum + child.sizeBytes, 0),
    itemsCount: images.length + children.length,
    filesCount: images.length,
    subdirsCount: children.length,
    children,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function getDemoScenario(): DemoScenario {
  const value = new URLSearchParams(window.location.search).get('scenario');
  if (
    value === 'idle'
    || value === 'scanning'
    || value === 'scan-error'
    || value === 'empty'
    || value === 'copy-error'
    || value === 'thumbnail-error'
  ) {
    return value;
  }
  return 'populated';
}

export function isDemoMode(): boolean {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

export function createDemoDesktopApi(scenario = getDemoScenario()): DesktopApi {
  const listeners = new Set<ScanProgressListener>();
  let scanCancelled = false;
  let directoryPickCount = 0;

  const emit = (progress: ScanProgress) => {
    listeners.forEach((listener) => listener(progress));
  };

  const api: DesktopApi = {
    async openDirectory() {
      directoryPickCount += 1;
      return directoryPickCount % 2 === 1
        ? DEMO_ROOT_PATH
        : 'C:\\Archive\\Safe exports';
    },

    async scanDirectory(rootPath) {
      scanCancelled = false;
      const slow = scenario === 'scanning';
      const delay = slow ? 700 : 90;
      const scanId = `demo-scan-${Date.now()}`;
      const frames: ScanProgress[] = [
        {
          scanId,
          phase: 'walking',
          directoriesVisited: 1,
          filesVisited: 2,
          imagesFound: 2,
          processedImages: 0,
          totalImages: 0,
          currentPath: `${rootPath}\\Editorial`,
        },
        {
          scanId,
          phase: 'walking',
          directoriesVisited: 3,
          filesVisited: 8,
          imagesFound: 7,
          processedImages: 0,
          totalImages: 0,
          currentPath: `${rootPath}\\Product`,
        },
        {
          scanId,
          phase: 'metadata',
          directoriesVisited: 5,
          filesVisited: 12,
          imagesFound: 12,
          processedImages: 3,
          totalImages: 12,
          currentPath: `${rootPath}\\Social\\launch_square_green.webp`,
        },
        {
          scanId,
          phase: 'metadata',
          directoriesVisited: 5,
          filesVisited: 12,
          imagesFound: 12,
          processedImages: 9,
          totalImages: 12,
          currentPath: `${rootPath}\\References\\scan_ledger_front.tif`,
        },
      ];

      for (const frame of frames) {
        await wait(delay);
        if (scanCancelled) {
          throw new DOMException('The scan was cancelled.', 'AbortError');
        }
        emit(frame);
      }

      if (scenario === 'scan-error') {
        throw new Error('The demo archive became unavailable while reading References.');
      }

      const images = scenario === 'empty' ? [] : demoImages;
      emit({
        scanId,
        phase: 'complete',
        directoriesVisited: 5,
        filesVisited: images.length,
        imagesFound: images.length,
        processedImages: images.length,
        totalImages: images.length,
      });

      return {
        rootPath,
        images,
        tree: createDemoTree(images),
        warnings: images.length > 0
          ? [{
              code: 'image-inspection-failed',
              path: `${rootPath}\\References\\material_reference_missing.heic`,
              message: 'A preview could not be generated; the original file remains available.',
            }]
          : [],
        totalFiles: images.length,
        durationMs: slow ? 3200 : 640,
      } satisfies CatalogSnapshot;
    },

    async cancelScan() {
      scanCancelled = true;
      return true;
    },

    onScanProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async copyFiles(request: CopyRequest) {
      await wait(650);
      const bytesCopied = request.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (scenario === 'copy-error') {
        return {
          success: false,
          copiedCount: Math.max(0, request.files.length - 1),
          renamedCount: 1,
          failedCount: 1,
          bytesCopied: Math.max(0, bytesCopied - (request.files.at(-1)?.sizeBytes ?? 0)),
          targetDir: request.targetDir,
          failures: [{
            path: request.files.at(-1)?.path ?? '',
            relativePath: request.files.at(-1)?.relativePath ?? '',
            code: 'EACCES',
            message: 'The destination denied access to this file.',
          }],
        } satisfies CopyResult;
      }
      return {
        success: true,
        copiedCount: request.files.length,
        renamedCount: request.files.length > 2 ? 1 : 0,
        failedCount: 0,
        bytesCopied,
        targetDir: request.targetDir,
        failures: [],
      } satisfies CopyResult;
    },

    async getThumbnail(filePath) {
      await wait(80);
      if (scenario === 'thumbnail-error' || filePath.includes('missing')) return null;
      if (filePath.endsWith('harbor_contact_sheet_01.jpg')) {
        return `${DEMO_ASSET_BASE}harbor-dawn.png`;
      }
      if (
        filePath.endsWith('harbor_contact_sheet_02.jpg')
        || filePath.endsWith('scan_ledger_front.tif')
      ) {
        return `${DEMO_ASSET_BASE}concrete-passage.png`;
      }
      if (
        filePath.endsWith('portrait_window_keylight.tif')
        || filePath.endsWith('launch_story_amber.webp')
      ) {
        return `${DEMO_ASSET_BASE}studio-tailoring.png`;
      }
      if (
        filePath.includes('\\Product\\')
        || filePath.endsWith('launch_square_green.webp')
        || filePath.endsWith('legacy_mark.ai')
      ) {
        return `${DEMO_ASSET_BASE}archive-camera.png`;
      }
      if (filePath.endsWith('launch_story_graphite.webp')) {
        return `${DEMO_ASSET_BASE}concrete-passage.png`;
      }
      return null;
    },

    async showItemInFolder() {
      return true;
    },

    async openPath() {
      return true;
    },

    minimize() {},
    maximize() {},
    close() {},
  };

  return api;
}
