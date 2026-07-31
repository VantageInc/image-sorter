import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  ExternalLink,
  FileImage,
  Folder,
  FolderOpen,
  ImageOff,
  Info,
  LoaderCircle,
  Minus,
  PanelLeftOpen,
  PanelRightOpen,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import type {
  CatalogSnapshot,
  CopyResult,
  DesktopApi,
  DirectoryStatNode,
  ImageFile,
  ScanProgress,
} from '../shared/contracts';
import {
  createDemoDesktopApi,
  getDemoScenario,
  isDemoMode,
} from './demoApi';
import { normalizePathForComparison as normalizePath } from './path-utils';

const APP_ICON_URL = `${import.meta.env.BASE_URL}icon.png`;
const INITIAL_RENDERED_IMAGES = 240;
const RENDERED_IMAGE_INCREMENT = 240;
const INITIAL_RESOLUTION_ROWS = 160;
const RESOLUTION_ROW_INCREMENT = 160;
const DIRECTORY_CHILD_BATCH = 200;

const SIZE_BUCKETS = [
  { label: 'Under 1 MB', min: 0, max: 1024 * 1024 },
  { label: '1–5 MB', min: 1024 * 1024, max: 5 * 1024 * 1024 },
  { label: '5–20 MB', min: 5 * 1024 * 1024, max: 20 * 1024 * 1024 },
  { label: '20–100 MB', min: 20 * 1024 * 1024, max: 100 * 1024 * 1024 },
  { label: '100 MB+', min: 100 * 1024 * 1024, max: Number.POSITIVE_INFINITY },
] as const;

type FilterCategory = 'extensions' | 'sizes' | 'tags';

interface ActiveFilters {
  extensions: Set<string>;
  sizes: Set<string>;
  tags: Set<string>;
}

type WorkspacePhase = 'idle' | 'scanning' | 'ready' | 'cancelled' | 'error';

type CopyState =
  | { kind: 'idle' }
  | { kind: 'copying'; count: number; targetDir: string }
  | { kind: 'success'; result: CopyResult }
  | { kind: 'error'; message: string; result?: CopyResult };

interface Notice {
  tone: 'neutral' | 'error';
  message: string;
}

interface FilterOptions {
  extensions: string[];
  sizes: string[];
  tags: string[];
}

function createEmptyFilters(): ActiveFilters {
  return {
    extensions: new Set(),
    sizes: new Set(),
    tags: new Set(),
  };
}

function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const precision = index === 0 ? 0 : decimals;
  return `${(bytes / (1024 ** index)).toFixed(precision)} ${units[index]}`;
}

function getSizeBucket(bytes: number): string {
  return SIZE_BUCKETS.find((bucket) => bytes >= bucket.min && bytes < bucket.max)?.label
    ?? SIZE_BUCKETS.at(-1)?.label
    ?? '100 MB+';
}

function extractTags(name: string): string[] {
  return name
    .replace(/\.[^/.]+$/, '')
    .split(/[_\-\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => (
      part.length > 1
      && Number.isNaN(Number(part))
      && !/^\d+x\d+$/i.test(part)
    ));
}

function formatTag(tag: string): string {
  return tag.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getResolution(image: ImageFile): string {
  if (image.width && image.height) return `${image.width}x${image.height}`;
  return image.resolution || 'Unknown size';
}

function resolutionArea(resolution: string): number {
  const match = resolution.match(/^(\d+)x(\d+)$/i);
  if (!match) return -1;
  return Number(match[1]) * Number(match[2]);
}

function resolutionId(resolution: string): string {
  return `resolution-${resolution.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function getScanPercent(progress: ScanProgress | null): number {
  if (!progress) return 4;
  if (progress.phase === 'complete') return 100;
  if (progress.phase === 'walking') {
    return Math.min(34, 6 + progress.directoriesVisited * 4);
  }
  if (progress.totalImages <= 0) return 38;
  return Math.min(
    96,
    36 + Math.round((progress.processedImages / progress.totalImages) * 60),
  );
}

function getScanLabel(progress: ScanProgress | null): string {
  if (!progress) return 'Preparing the catalog';
  if (progress.phase === 'walking') return 'Indexing folders and files';
  if (progress.phase === 'metadata') return 'Reading dimensions and metadata';
  return 'Catalog ready';
}

function getPathLeaf(value?: string): string {
  if (!value) return '';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function useCompactLayout(): boolean {
  const query = '(max-width: 1279px)';
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return matches;
}

function groupMetadata(metadata: Record<string, string>): Array<{
  title: string;
  entries: Array<[string, string]>;
}> {
  const groups = new Map<string, Array<[string, string]>>([
    ['EXIF', []],
    ['IPTC', []],
    ['XMP', []],
    ['Other', []],
  ]);

  Object.entries(metadata).forEach(([key, value]) => {
    const prefix = key.match(/^(EXIF|IPTC|XMP)[.:]/i)?.[1]?.toUpperCase();
    const groupName = prefix && groups.has(prefix) ? prefix : 'Other';
    const cleanKey = prefix ? key.replace(/^(EXIF|IPTC|XMP)[.:]/i, '') : key;
    groups.get(groupName)?.push([cleanKey, value]);
  });

  return Array.from(groups.entries())
    .map(([title, entries]) => ({
      title,
      entries: entries.sort(([left], [right]) => left.localeCompare(right)),
    }))
    .filter((group) => group.entries.length > 0);
}

export default function App() {
  const demoMode = isDemoMode();
  const demoScenario = getDemoScenario();
  const [api] = useState<DesktopApi | null>(() => (
    demoMode ? createDemoDesktopApi(demoScenario) : window.desktopApi ?? null
  ));

  const [phase, setPhase] = useState<WorkspacePhase>('idle');
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedNodePaths, setSelectedNodePaths] = useState<Set<string>>(new Set());
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>(createEmptyFilters);
  const [nameSearch, setNameSearch] = useState('');
  const [resolutionSearch, setResolutionSearch] = useState('');
  const [copyState, setCopyState] = useState<CopyState>({ kind: 'idle' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [renderWindow, setRenderWindow] = useState({
    key: '',
    limit: INITIAL_RENDERED_IMAGES,
  });

  const compactLayout = useCompactLayout();
  const scanRunRef = useRef(0);
  const autoDemoStartedRef = useRef(false);

  useEffect(() => {
    if (!api) return undefined;
    return api.onScanProgress((progress) => {
      setScanProgress(progress);
    });
  }, [api]);

  useEffect(() => {
    const closePanels = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLeftPanelOpen(false);
      setRightPanelOpen(false);
      setNotice(null);
    };
    window.addEventListener('keydown', closePanels);
    return () => window.removeEventListener('keydown', closePanels);
  }, []);

  const resetWorkspaceControls = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedNodePaths(new Set());
    setActiveFilters(createEmptyFilters());
    setNameSearch('');
    setResolutionSearch('');
    setCopyState({ kind: 'idle' });
    setNotice(null);
  }, []);

  const runScan = useCallback(async (rootPath: string) => {
    if (!api) {
      setTargetDir(rootPath);
      setPhase('error');
      setScanError('The desktop bridge is unavailable. Open the packaged app or add ?demo=1 for browser QA.');
      return;
    }

    const runId = scanRunRef.current + 1;
    scanRunRef.current = runId;
    setTargetDir(rootPath);
    setCatalog(null);
    setPhase('scanning');
    setScanError(null);
    setScanProgress(null);
    setLeftPanelOpen(false);
    setRightPanelOpen(false);
    resetWorkspaceControls();

    try {
      const snapshot = await api.scanDirectory(rootPath);
      if (scanRunRef.current !== runId) return;
      setCatalog(snapshot);
      setTargetDir(snapshot.rootPath);
      setPhase('ready');
    } catch (error) {
      if (scanRunRef.current !== runId) return;
      const isCancelled = error instanceof DOMException && error.name === 'AbortError';
      setPhase(isCancelled ? 'cancelled' : 'error');
      setScanError(
        isCancelled
          ? null
          : error instanceof Error
            ? error.message
            : 'The folder could not be scanned.',
      );
    }
  }, [api, resetWorkspaceControls]);

  const chooseSourceFolder = useCallback(async () => {
    if (!api) {
      setPhase('error');
      setScanError('The desktop bridge is unavailable. Open the packaged app or add ?demo=1 for browser QA.');
      return;
    }
    try {
      const rootPath = await api.openDirectory();
      if (rootPath) await runScan(rootPath);
    } catch (error) {
      setPhase('error');
      setScanError(
        error instanceof Error ? error.message : 'The folder picker could not be opened.',
      );
    }
  }, [api, runScan]);

  useEffect(() => {
    if (
      !demoMode
      || demoScenario === 'idle'
      || autoDemoStartedRef.current
    ) {
      return;
    }
    autoDemoStartedRef.current = true;
    void chooseSourceFolder();
  }, [chooseSourceFolder, demoMode, demoScenario]);

  const cancelScan = async () => {
    scanRunRef.current += 1;
    setPhase('cancelled');
    setScanProgress(null);
    if (api) {
      try {
        await api.cancelScan();
      } catch {
        // The renderer has already stopped accepting the stale scan result.
      }
    }
  };

  const images = useMemo(() => catalog?.images ?? [], [catalog]);

  const filterOptions = useMemo<FilterOptions>(() => {
    const extensions = new Set<string>();
    const sizes = new Set<string>();
    const tagCounts = new Map<string, number>();

    images.forEach((image) => {
      extensions.add(image.extension.replace(/^\./, '').toUpperCase());
      sizes.add(getSizeBucket(image.sizeBytes));
      extractTags(image.name).forEach((tag) => {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      });
    });

    return {
      extensions: Array.from(extensions).sort(),
      sizes: SIZE_BUCKETS
        .map((bucket) => bucket.label)
        .filter((label) => sizes.has(label)),
      tags: Array.from(tagCounts.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 24)
        .map(([tag]) => tag),
    };
  }, [images]);

  const visibleImages = useMemo(() => {
    const normalizedDirectories = Array.from(selectedNodePaths, normalizePath);
    const nameQuery = nameSearch.trim().toLowerCase();
    const resolutionQuery = resolutionSearch.trim().toLowerCase().replace(/\s+/g, '');
    const exactResolutionQuery = /^\d+[x×]\d+$/.test(resolutionQuery)
      ? resolutionQuery.replace('×', 'x')
      : null;

    return images.filter((image) => {
      const imagePath = normalizePath(image.path);
      const directoryMatches = normalizedDirectories.length === 0
        || normalizedDirectories.some((directory) => (
          imagePath === directory || imagePath.startsWith(`${directory}/`)
        ));
      if (!directoryMatches) return false;

      if (nameQuery && !image.name.toLowerCase().includes(nameQuery)) return false;

      const extension = image.extension.replace(/^\./, '').toUpperCase();
      if (
        activeFilters.extensions.size > 0
        && !activeFilters.extensions.has(extension)
      ) {
        return false;
      }

      if (
        activeFilters.sizes.size > 0
        && !activeFilters.sizes.has(getSizeBucket(image.sizeBytes))
      ) {
        return false;
      }

      const imageTags = new Set(extractTags(image.name));
      if (
        activeFilters.tags.size > 0
        && !Array.from(activeFilters.tags).every((tag) => imageTags.has(tag))
      ) {
        return false;
      }

      if (resolutionQuery) {
        const resolution = getResolution(image).toLowerCase();
        if (exactResolutionQuery) return resolution === exactResolutionQuery;
        if (!resolution.includes(resolutionQuery)) return false;
      }

      return true;
    });
  }, [
    activeFilters,
    images,
    nameSearch,
    resolutionSearch,
    selectedNodePaths,
  ]);

  const viewKey = useMemo(() => JSON.stringify({
    root: catalog?.rootPath ?? '',
    count: images.length,
    nameSearch,
    resolutionSearch,
    directories: Array.from(selectedNodePaths).sort(),
    extensions: Array.from(activeFilters.extensions).sort(),
    sizes: Array.from(activeFilters.sizes).sort(),
    tags: Array.from(activeFilters.tags).sort(),
  }), [
    activeFilters,
    catalog?.rootPath,
    images.length,
    nameSearch,
    resolutionSearch,
    selectedNodePaths,
  ]);

  const groupedImages = useMemo<Array<[string, ImageFile[]]>>(() => {
    const groups = new Map<string, ImageFile[]>();
    visibleImages.forEach((image) => {
      const resolution = getResolution(image);
      const group = groups.get(resolution);
      if (group) group.push(image);
      else groups.set(resolution, [image]);
    });
    return Array.from(groups.entries()).sort(([left], [right]) => (
      resolutionArea(right) - resolutionArea(left)
      || left.localeCompare(right)
    ));
  }, [visibleImages]);

  const renderedImageLimit = renderWindow.key === viewKey
    ? renderWindow.limit
    : INITIAL_RENDERED_IMAGES;
  const renderedImageCount = Math.min(
    renderedImageLimit,
    visibleImages.length,
  );
  const displayedGroups = useMemo(() => {
    let remaining = renderedImageCount;
    const displayed: Array<{
      resolution: string;
      images: ImageFile[];
      totalCount: number;
      index: number;
    }> = [];

    for (const [index, [resolution, groupImages]] of groupedImages.entries()) {
      if (remaining <= 0) break;
      const imagesToRender = groupImages.slice(0, remaining);
      remaining -= imagesToRender.length;
      displayed.push({
        resolution,
        images: imagesToRender,
        totalCount: groupImages.length,
        index,
      });
    }

    return displayed;
  }, [groupedImages, renderedImageCount]);

  const selectedImages = useMemo(
    () => images.filter((image) => selectedIds.has(image.id)),
    [images, selectedIds],
  );
  const selectedBytes = useMemo(
    () => selectedImages.reduce((sum, image) => sum + image.sizeBytes, 0),
    [selectedImages],
  );
  const visibleIdSet = useMemo(
    () => new Set(visibleImages.map((image) => image.id)),
    [visibleImages],
  );
  const visibleSelectedCount = useMemo(
    () => selectedImages.filter((image) => visibleIdSet.has(image.id)).length,
    [selectedImages, visibleIdSet],
  );
  const hiddenSelectedCount = selectedImages.length - visibleSelectedCount;
  const allVisibleSelected = visibleImages.length > 0
    && visibleSelectedCount === visibleImages.length;

  const activeFilterCount = (
    activeFilters.extensions.size
    + activeFilters.sizes.size
    + activeFilters.tags.size
    + selectedNodePaths.size
    + (nameSearch.trim() ? 1 : 0)
    + (resolutionSearch.trim() ? 1 : 0)
  );

  const toggleFilter = (category: FilterCategory, value: string) => {
    setActiveFilters((current) => {
      const next = {
        extensions: new Set(current.extensions),
        sizes: new Set(current.sizes),
        tags: new Set(current.tags),
      };
      const values = next[category];
      if (values.has(value)) values.delete(value);
      else values.add(value);
      return next;
    });
  };

  const clearFilters = () => {
    setActiveFilters(createEmptyFilters());
    setSelectedNodePaths(new Set());
    setNameSearch('');
    setResolutionSearch('');
  };

  const toggleImage = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCopyState({ kind: 'idle' });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleImages.forEach((image) => {
        if (allVisibleSelected) next.delete(image.id);
        else next.add(image.id);
      });
      return next;
    });
    setCopyState({ kind: 'idle' });
  };

  const setGroupSelection = (groupImages: ImageFile[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      groupImages.forEach((image) => {
        if (selected) next.add(image.id);
        else next.delete(image.id);
      });
      return next;
    });
    setCopyState({ kind: 'idle' });
  };

  const openFile = async (image: ImageFile) => {
    if (!api) return;
    try {
      const opened = await api.openPath(image.path);
      if (!opened) {
        setNotice({ tone: 'error', message: `Could not open ${image.name}.` });
      }
    } catch {
      setNotice({ tone: 'error', message: `Could not open ${image.name}.` });
    }
  };

  const revealFile = async (image: ImageFile) => {
    if (!api) return;
    try {
      const revealed = await api.showItemInFolder(image.path);
      if (!revealed) {
        setNotice({ tone: 'error', message: `Could not reveal ${image.name}.` });
      }
    } catch {
      setNotice({ tone: 'error', message: `Could not reveal ${image.name}.` });
    }
  };

  const copySelected = async () => {
    if (!api || !catalog || selectedImages.length === 0) return;
    try {
      const targetDirectory = await api.openDirectory();
      if (!targetDirectory) return;
      setCopyState({
        kind: 'copying',
        count: selectedImages.length,
        targetDir: targetDirectory,
      });
      const result = await api.copyFiles({
        rootPath: catalog.rootPath,
        targetDir: targetDirectory,
        files: selectedImages.map((image) => ({
          path: image.path,
          relativePath: image.relativePath,
          sizeBytes: image.sizeBytes,
        })),
      });
      if (result.failedCount > 0 || !result.success) {
        setCopyState({
          kind: 'error',
          message: result.failures[0]?.message ?? 'Some files could not be copied.',
          result,
        });
        const failedPaths = new Set(result.failures.map((failure) => failure.path));
        setSelectedIds(new Set(
          selectedImages
            .filter((image) => failedPaths.has(image.path))
            .map((image) => image.id),
        ));
      } else {
        setCopyState({ kind: 'success', result });
        setSelectedIds(new Set());
      }
    } catch (error) {
      setCopyState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The copy could not be completed.',
      });
    }
  };

  const scrollToResolution = (resolution: string) => {
    let imagesBeforeGroup = 0;
    const targetGroup = groupedImages.find(([groupResolution, groupImages]) => {
      if (groupResolution === resolution) return true;
      imagesBeforeGroup += groupImages.length;
      return false;
    });
    if (!targetGroup) return;

    const revealAndScroll = () => {
      const target = document.getElementById(resolutionId(resolution));
      if (!target) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    };

    if (imagesBeforeGroup >= renderedImageCount) {
      setRenderWindow({
        key: viewKey,
        limit: Math.min(visibleImages.length, imagesBeforeGroup + 1),
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(revealAndScroll);
      });
      return;
    }

    revealAndScroll();
  };

  const showCatalogPanels = phase === 'ready' && catalog && images.length > 0;
  const leftPanelVisible = Boolean(showCatalogPanels && (!compactLayout || leftPanelOpen));
  const rightPanelVisible = Boolean(showCatalogPanels && (!compactLayout || rightPanelOpen));
  const anyCompactPanelOpen = compactLayout && (leftPanelOpen || rightPanelOpen);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#catalog-content">Skip to image catalog</a>

      <header className="titlebar">
        <div className="brand-lockup">
          <img className="brand-lockup__icon" src={APP_ICON_URL} alt="" />
          <div>
            <span className="brand-lockup__eyebrow">Local archive utility</span>
            <h1>Image Sorter</h1>
          </div>
          {demoMode && <span className="demo-badge">Demo</span>}
        </div>

        <div className="titlebar__actions">
          <button
            className="button button--paper titlebar__folder-button"
            type="button"
            aria-label={targetDir ? 'Change folder' : 'Open folder'}
            title={targetDir ? 'Change folder' : 'Open folder'}
            onClick={() => void chooseSourceFolder()}
            disabled={phase === 'scanning'}
          >
            <FolderOpen aria-hidden="true" size={17} />
            <span>{targetDir ? 'Change folder' : 'Open folder'}</span>
          </button>
          <div className="window-controls" aria-label="Window controls">
            <button
              type="button"
              aria-label="Minimize window"
              title="Minimize"
              onClick={() => api?.minimize()}
              disabled={!api}
            >
              <Minus aria-hidden="true" size={18} />
            </button>
            <button
              type="button"
              aria-label="Maximize or restore window"
              title="Maximize or restore"
              onClick={() => api?.maximize()}
              disabled={!api}
            >
              <Square aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              aria-label="Close window"
              title="Close"
              onClick={() => api?.close()}
              disabled={!api}
            >
              <X aria-hidden="true" size={19} />
            </button>
          </div>
        </div>
      </header>

      {targetDir && (
        <section className="workspace-bar" aria-label="Current catalog">
          <div className="source-path" title={targetDir}>
            <Archive aria-hidden="true" size={17} />
            <span>{targetDir}</span>
          </div>

          <div className="workspace-bar__summary" aria-live="polite">
            {phase === 'scanning' && (
              <>
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
                {scanProgress?.imagesFound ?? 0} images found
              </>
            )}
            {phase === 'ready' && catalog && (
              <>
                <strong>{images.length}</strong> images
                <span aria-hidden="true">·</span>
                {formatBytes(catalog.tree.sizeBytes)}
              </>
            )}
            {phase === 'cancelled' && 'Scan stopped'}
            {phase === 'error' && 'Catalog unavailable'}
          </div>

          {showCatalogPanels && (
            <div className="panel-toggles">
              <button
                className="icon-text-button"
                type="button"
                aria-expanded={leftPanelOpen}
                aria-controls="directory-panel"
                onClick={() => {
                  setLeftPanelOpen((open) => !open);
                  setRightPanelOpen(false);
                }}
              >
                <PanelLeftOpen aria-hidden="true" size={17} />
                Folders
              </button>
              <button
                className="icon-text-button"
                type="button"
                aria-expanded={rightPanelOpen}
                aria-controls="details-panel"
                onClick={() => {
                  setRightPanelOpen((open) => !open);
                  setLeftPanelOpen(false);
                }}
              >
                <PanelRightOpen aria-hidden="true" size={17} />
                Details
              </button>
            </div>
          )}
        </section>
      )}

      <div
        className={`workspace${showCatalogPanels ? ' workspace--catalog' : ' workspace--single'}`}
      >
        {anyCompactPanelOpen && (
          <button
            type="button"
            className="drawer-scrim"
            aria-label="Close side panel"
            onClick={() => {
              setLeftPanelOpen(false);
              setRightPanelOpen(false);
            }}
          />
        )}

        {showCatalogPanels && (
          <DirectoryPanel
            id="directory-panel"
            hidden={!leftPanelVisible}
            tree={catalog.tree}
            selectedPaths={selectedNodePaths}
            onTogglePath={(path) => {
              setSelectedNodePaths((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onClose={() => setLeftPanelOpen(false)}
            compact={compactLayout}
          />
        )}

        <main
          id="catalog-content"
          className="catalog-main"
          aria-busy={phase === 'scanning'}
        >
          {phase === 'idle' && (
            <EmptyState onChooseFolder={() => void chooseSourceFolder()} />
          )}

          {phase === 'scanning' && (
            <ScanningState
              progress={scanProgress}
              targetDir={targetDir}
              onCancel={() => void cancelScan()}
            />
          )}

          {phase === 'cancelled' && targetDir && (
            <MessageState
              icon={<Info aria-hidden="true" size={30} />}
              eyebrow="Catalog paused"
              title="The scan was stopped."
              body="Nothing was copied or changed. Restart when you are ready to continue indexing this folder."
              primaryLabel="Restart scan"
              onPrimary={() => void runScan(targetDir)}
              secondaryLabel="Choose another folder"
              onSecondary={() => void chooseSourceFolder()}
            />
          )}

          {phase === 'error' && (
            <MessageState
              tone="error"
              icon={<AlertTriangle aria-hidden="true" size={30} />}
              eyebrow="Catalog error"
              title="This folder could not be indexed."
              body={scanError ?? 'The source is unavailable or contains an unreadable entry.'}
              primaryLabel={targetDir ? 'Try again' : 'Open folder'}
              onPrimary={() => {
                if (targetDir) void runScan(targetDir);
                else void chooseSourceFolder();
              }}
              secondaryLabel={targetDir ? 'Choose another folder' : undefined}
              onSecondary={targetDir ? () => void chooseSourceFolder() : undefined}
            />
          )}

          {phase === 'ready' && catalog && images.length === 0 && (
            <MessageState
              icon={<FileImage aria-hidden="true" size={30} />}
              eyebrow="Catalog 00"
              title="No supported images were found."
              body="The folder was scanned successfully, but it contains no image formats this catalog can index."
              primaryLabel="Choose another folder"
              onPrimary={() => void chooseSourceFolder()}
            />
          )}

          {phase === 'ready' && catalog && images.length > 0 && (
            <>
              <FilterPanel
                activeFilters={activeFilters}
                activeFilterCount={activeFilterCount}
                nameSearch={nameSearch}
                resolutionSearch={resolutionSearch}
                options={filterOptions}
                onNameSearch={setNameSearch}
                onResolutionSearch={setResolutionSearch}
                onToggleFilter={toggleFilter}
                onClear={clearFilters}
              />

              <div className="catalog-scroll">
                {catalog.warnings.length > 0 && (
                  <details className="warning-strip">
                    <summary>
                      <AlertTriangle aria-hidden="true" size={17} />
                      {catalog.warnings.length} catalog warning{catalog.warnings.length === 1 ? '' : 's'}
                    </summary>
                    <ul>
                      {catalog.warnings.map((warning) => (
                        <li key={`${warning.code}-${warning.path}`}>
                          <strong>{getPathLeaf(warning.path)}</strong>
                          <span>{warning.message}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="catalog-heading">
                  <div>
                    <span className="section-label">Contact sheet</span>
                    <h2>
                      {visibleImages.length} of {images.length} images
                    </h2>
                  </div>
                  <div className="catalog-heading__actions">
                    {hiddenSelectedCount > 0 && (
                      <span className="hidden-selection-note">
                        {hiddenSelectedCount} selected outside the current filters
                      </span>
                    )}
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={toggleAllVisible}
                      disabled={visibleImages.length === 0}
                    >
                      <Check aria-hidden="true" size={16} />
                      {allVisibleSelected
                        ? `Deselect all ${visibleImages.length} matches`
                        : `Select all ${visibleImages.length} matches`}
                    </button>
                  </div>
                </div>

                {visibleImages.length === 0 ? (
                  <div className="no-results" role="status">
                    <Search aria-hidden="true" size={28} />
                    <h3>No images match this view.</h3>
                    <p>Clear the active filters or try a broader file name or dimension.</p>
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={clearFilters}
                    >
                      <RotateCcw aria-hidden="true" size={16} />
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <div className="resolution-groups">
                    {displayedGroups.map((group) => (
                      <section
                        className="resolution-group"
                        id={resolutionId(group.resolution)}
                        key={group.resolution}
                        aria-labelledby={`${resolutionId(group.resolution)}-title`}
                      >
                        <header className="resolution-group__header">
                          <span className="resolution-group__index" aria-hidden="true">
                            {String(group.index + 1).padStart(2, '0')}
                          </span>
                          <h3 id={`${resolutionId(group.resolution)}-title`}>
                            {group.resolution}
                          </h3>
                          <span className="resolution-group__count">
                            {group.images.length < group.totalCount
                              ? `${group.images.length} of ${group.totalCount}`
                              : group.totalCount}
                            {' '}
                            file{group.totalCount === 1 ? '' : 's'}
                          </span>
                          <span className="resolution-group__rule" aria-hidden="true" />
                        </header>
                        <div className="image-grid">
                          {group.images.map((image) => (
                            <ImageCard
                              key={image.id}
                              api={api}
                              image={image}
                              selected={selectedIds.has(image.id)}
                              onToggle={() => toggleImage(image.id)}
                              onOpen={() => void openFile(image)}
                              onReveal={() => void revealFile(image)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                    {renderedImageCount < visibleImages.length && (
                      <div className="catalog-load-more">
                        <span role="status">
                          Showing {renderedImageCount} of {visibleImages.length} matching images
                        </span>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => {
                            setRenderWindow({
                              key: viewKey,
                              limit: Math.min(
                                visibleImages.length,
                                renderedImageCount + RENDERED_IMAGE_INCREMENT,
                              ),
                            });
                          }}
                        >
                          Show next{' '}
                          {Math.min(
                            RENDERED_IMAGE_INCREMENT,
                            visibleImages.length - renderedImageCount,
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>

        {showCatalogPanels && (
          <DetailsPanel
            id="details-panel"
            hidden={!rightPanelVisible}
            groups={groupedImages}
            viewKey={viewKey}
            selectedIds={selectedIds}
            selectedImages={selectedImages}
            onSetGroupSelection={setGroupSelection}
            onScrollToResolution={(resolution) => {
              scrollToResolution(resolution);
              if (compactLayout) setRightPanelOpen(false);
            }}
            onClose={() => setRightPanelOpen(false)}
            compact={compactLayout}
          />
        )}
      </div>

      {notice && (
        <div
          className={`notice-toast notice-toast--${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}

      <ExportTray
        api={api}
        copyState={copyState}
        selectedCount={selectedImages.length}
        selectedBytes={selectedBytes}
        hiddenSelectedCount={hiddenSelectedCount}
        onClear={() => {
          setSelectedIds(new Set());
          setCopyState({ kind: 'idle' });
        }}
        onCopy={() => void copySelected()}
      />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {phase === 'scanning'
          ? `${getScanLabel(scanProgress)}. ${scanProgress?.imagesFound ?? 0} images found.`
          : `${selectedImages.length} image${selectedImages.length === 1 ? '' : 's'} selected.`}
      </div>
    </div>
  );
}

function EmptyState({ onChooseFolder }: { onChooseFolder: () => void }) {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <div className="empty-state__stamp" aria-hidden="true">
        <span>Local index</span>
        <strong>00</strong>
      </div>
      <img className="empty-state__icon" src={APP_ICON_URL} alt="" />
      <span className="section-label">Archive intake</span>
      <h2 id="empty-title">Build a searchable contact sheet.</h2>
      <p className="empty-state__lede">
        Choose an image folder to index its subfolders, dimensions, file sizes,
        and embedded metadata—entirely on this computer.
      </p>
      <button className="button button--primary button--large" type="button" onClick={onChooseFolder}>
        <FolderOpen aria-hidden="true" size={18} />
        Choose image folder
      </button>
      <ul className="empty-state__facts" aria-label="What happens next">
        <li>
          <strong>Recursive</strong>
          <span>Includes nested folders</span>
        </li>
        <li>
          <strong>Local</strong>
          <span>No uploads or cloud processing</span>
        </li>
        <li>
          <strong>Read-only</strong>
          <span>Originals stay untouched</span>
        </li>
      </ul>
    </section>
  );
}

function ScanningState({
  progress,
  targetDir,
  onCancel,
}: {
  progress: ScanProgress | null;
  targetDir: string | null;
  onCancel: () => void;
}) {
  const percent = getScanPercent(progress);
  return (
    <section className="status-state" aria-labelledby="scan-title">
      <span className="status-state__index" aria-hidden="true">01</span>
      <LoaderCircle className="status-state__icon spin" aria-hidden="true" size={32} />
      <span className="section-label">Building catalog</span>
      <h2 id="scan-title">{getScanLabel(progress)}</h2>
      <p>
        {progress?.phase === 'metadata'
          ? `${progress.processedImages} of ${progress.totalImages} images inspected`
          : `${progress?.directoriesVisited ?? 0} folders visited · ${progress?.imagesFound ?? 0} images found`}
      </p>
      <progress
        className="scan-progress"
        max={100}
        value={percent}
        aria-label="Catalog scan progress"
      >
        {percent}%
      </progress>
      <div className="scan-progress__meta">
        <span>{percent}%</span>
        <span title={progress?.currentPath ?? targetDir ?? undefined}>
          {getPathLeaf(progress?.currentPath) || getPathLeaf(targetDir ?? '')}
        </span>
      </div>
      <button className="button button--secondary" type="button" onClick={onCancel}>
        <X aria-hidden="true" size={16} />
        Stop scan
      </button>
    </section>
  );
}

function MessageState({
  icon,
  eyebrow,
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  tone = 'neutral',
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tone?: 'neutral' | 'error';
}) {
  return (
    <section
      className={`message-state message-state--${tone}`}
      aria-labelledby="message-state-title"
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <div className="message-state__icon">{icon}</div>
      <span className="section-label">{eyebrow}</span>
      <h2 id="message-state-title">{title}</h2>
      <p>{body}</p>
      <div className="message-state__actions">
        <button className="button button--primary" type="button" onClick={onPrimary}>
          <RotateCcw aria-hidden="true" size={16} />
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button className="button button--secondary" type="button" onClick={onSecondary}>
            <FolderOpen aria-hidden="true" size={16} />
            {secondaryLabel}
          </button>
        )}
      </div>
    </section>
  );
}

function FilterPanel({
  activeFilters,
  activeFilterCount,
  nameSearch,
  resolutionSearch,
  options,
  onNameSearch,
  onResolutionSearch,
  onToggleFilter,
  onClear,
}: {
  activeFilters: ActiveFilters;
  activeFilterCount: number;
  nameSearch: string;
  resolutionSearch: string;
  options: FilterOptions;
  onNameSearch: (value: string) => void;
  onResolutionSearch: (value: string) => void;
  onToggleFilter: (category: FilterCategory, value: string) => void;
  onClear: () => void;
}) {
  return (
    <details className="filter-panel">
      <summary>
        <span>
          <SlidersHorizontal aria-hidden="true" size={17} />
          Filter catalog
        </span>
        {activeFilterCount > 0 && (
          <span className="filter-count">{activeFilterCount} active</span>
        )}
      </summary>
      <div className="filter-panel__content">
        <div className="search-fields">
          <SearchField
            id="file-name-search"
            label="File name"
            placeholder="Search file names"
            value={nameSearch}
            onChange={onNameSearch}
          />
          <SearchField
            id="resolution-search"
            label="Exact dimensions"
            placeholder="e.g. 1920x1080"
            value={resolutionSearch}
            onChange={onResolutionSearch}
          />
          <button
            className="button button--quiet clear-filters"
            type="button"
            onClick={onClear}
            disabled={activeFilterCount === 0}
          >
            <RotateCcw aria-hidden="true" size={15} />
            Clear all
          </button>
        </div>

        <div className="filter-groups">
          <FilterChipGroup
            label="Format"
            values={options.extensions}
            selected={activeFilters.extensions}
            onToggle={(value) => onToggleFilter('extensions', value)}
          />
          <FilterChipGroup
            label="File size"
            values={options.sizes}
            selected={activeFilters.sizes}
            onToggle={(value) => onToggleFilter('sizes', value)}
          />
          <FilterChipGroup
            label="Name tags"
            values={options.tags}
            selected={activeFilters.tags}
            onToggle={(value) => onToggleFilter('tags', value)}
            formatValue={formatTag}
          />
        </div>
      </div>
    </details>
  );
}

function SearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="search-field">
      <label htmlFor={id}>{label}</label>
      <div className="search-field__control">
        <Search aria-hidden="true" size={16} />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {value && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => onChange('')}
          >
            <X aria-hidden="true" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function FilterChipGroup({
  label,
  values,
  selected,
  onToggle,
  formatValue = (value) => value,
}: {
  label: string;
  values: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  formatValue?: (value: string) => string;
}) {
  if (values.length === 0) return null;
  return (
    <fieldset className="filter-group">
      <legend>{label}</legend>
      <div className="filter-chips">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={selected.has(value)}
            onClick={() => onToggle(value)}
          >
            {selected.has(value) && <Check aria-hidden="true" size={13} />}
            {formatValue(value)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function DirectoryPanel({
  id,
  hidden,
  tree,
  selectedPaths,
  onTogglePath,
  onClose,
  compact,
}: {
  id: string;
  hidden: boolean;
  tree: DirectoryStatNode;
  selectedPaths: Set<string>;
  onTogglePath: (path: string) => void;
  onClose: () => void;
  compact: boolean;
}) {
  return (
    <aside
      id={id}
      className="sidebar sidebar--left"
      aria-labelledby="directory-title"
      hidden={hidden}
    >
      <header className="sidebar__header">
        <div>
          <span className="section-label">Source</span>
          <h2 id="directory-title">Folders</h2>
        </div>
        {compact && (
          <button className="icon-button" type="button" aria-label="Close folders panel" onClick={onClose}>
            <X aria-hidden="true" size={17} />
          </button>
        )}
      </header>
      <div className="tree-columns" aria-hidden="true">
        <span>Folder</span>
        <span>Size</span>
        <span>Items</span>
      </div>
      <div className="sidebar__scroll">
        <ul className="directory-tree" aria-label="Folder filters">
          <DirectoryTreeNode
            node={tree}
            level={0}
            selectedPaths={selectedPaths}
            onTogglePath={onTogglePath}
          />
        </ul>
      </div>
    </aside>
  );
}

function DirectoryTreeNode({
  node,
  level,
  selectedPaths,
  onTogglePath,
}: {
  node: DirectoryStatNode;
  level: number;
  selectedPaths: Set<string>;
  onTogglePath: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(level === 0);
  const [visibleChildCount, setVisibleChildCount] = useState(
    DIRECTORY_CHILD_BATCH,
  );
  const childListId = useId();
  const hasChildren = node.children.length > 0;
  const selected = selectedPaths.has(node.path);
  const visibleChildren = node.children.slice(0, visibleChildCount);
  const hiddenChildCount = node.children.length - visibleChildren.length;

  return (
    <li className="tree-node">
      <div className="tree-row">
        {hasChildren ? (
          <button
            className="tree-disclosure"
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
            aria-expanded={expanded}
            aria-controls={childListId}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded
              ? <ChevronDown aria-hidden="true" size={16} />
              : <ChevronRight aria-hidden="true" size={16} />}
          </button>
        ) : (
          <span className="tree-disclosure tree-disclosure--empty" aria-hidden="true" />
        )}

        <label className="tree-selector">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onTogglePath(node.path)}
          />
          <Folder aria-hidden="true" size={16} />
          <span title={node.name}>{node.name}</span>
        </label>
        <span className="tree-stat">{formatBytes(node.sizeBytes, 0)}</span>
        <span className="tree-stat">{node.itemsCount}</span>
      </div>

      {hasChildren && expanded && (
        <ul id={childListId}>
          {visibleChildren.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPaths={selectedPaths}
              onTogglePath={onTogglePath}
            />
          ))}
          {hiddenChildCount > 0 && (
            <li className="tree-more-row">
              <button
                type="button"
                onClick={() => {
                  setVisibleChildCount((count) => (
                    Math.min(node.children.length, count + DIRECTORY_CHILD_BATCH)
                  ));
                }}
              >
                Show next {Math.min(DIRECTORY_CHILD_BATCH, hiddenChildCount)} folders
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function DetailsPanel({
  id,
  hidden,
  groups,
  viewKey,
  selectedIds,
  selectedImages,
  onSetGroupSelection,
  onScrollToResolution,
  onClose,
  compact,
}: {
  id: string;
  hidden: boolean;
  groups: Array<[string, ImageFile[]]>;
  viewKey: string;
  selectedIds: Set<string>;
  selectedImages: ImageFile[];
  onSetGroupSelection: (images: ImageFile[], selected: boolean) => void;
  onScrollToResolution: (resolution: string) => void;
  onClose: () => void;
  compact: boolean;
}) {
  const [rowWindow, setRowWindow] = useState({
    key: '',
    limit: INITIAL_RESOLUTION_ROWS,
  });
  const visibleRowLimit = rowWindow.key === viewKey
    ? rowWindow.limit
    : INITIAL_RESOLUTION_ROWS;
  const visibleGroups = groups.slice(0, visibleRowLimit);
  const hiddenGroupCount = groups.length - visibleGroups.length;

  return (
    <aside
      id={id}
      className="sidebar sidebar--right"
      aria-label="Catalog details"
      hidden={hidden}
    >
      <section className="resolution-index" aria-labelledby="resolution-index-title">
        <header className="sidebar__header">
          <div>
            <span className="section-label">Index</span>
            <h2 id="resolution-index-title">Dimensions</h2>
          </div>
          <span className="count-badge">{groups.length}</span>
          {compact && (
            <button className="icon-button" type="button" aria-label="Close details panel" onClick={onClose}>
              <X aria-hidden="true" size={17} />
            </button>
          )}
        </header>
        <div className="resolution-list">
          {visibleGroups.map(([resolution, images]) => {
            const selectedCount = images.filter((image) => selectedIds.has(image.id)).length;
            return (
              <div className="resolution-row" key={resolution}>
                <TriStateCheckbox
                  label={`Select all ${images.length} images at ${resolution}`}
                  checked={selectedCount === images.length}
                  mixed={selectedCount > 0 && selectedCount < images.length}
                  onChange={(checked) => onSetGroupSelection(images, checked)}
                />
                <button
                  type="button"
                  className="resolution-link"
                  onClick={() => onScrollToResolution(resolution)}
                >
                  <span>{resolution}</span>
                  <span>{images.length}</span>
                </button>
              </div>
            );
          })}
          {hiddenGroupCount > 0 && (
            <button
              className="resolution-list__more"
              type="button"
              onClick={() => {
                setRowWindow({
                  key: viewKey,
                  limit: Math.min(
                    groups.length,
                    visibleGroups.length + RESOLUTION_ROW_INCREMENT,
                  ),
                });
              }}
            >
              Show next {Math.min(RESOLUTION_ROW_INCREMENT, hiddenGroupCount)} dimensions
            </button>
          )}
        </div>
      </section>

      <MetadataInspector selectedImages={selectedImages} />
    </aside>
  );
}

function TriStateCheckbox({
  label,
  checked,
  mixed,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed: boolean;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);

  return (
    <label className="tri-checkbox" title={label}>
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function MetadataInspector({ selectedImages }: { selectedImages: ImageFile[] }) {
  const selected = selectedImages[0];
  const selectedBytes = selectedImages.reduce((sum, image) => sum + image.sizeBytes, 0);
  const uniqueResolutions = new Set(selectedImages.map(getResolution));
  const metadataGroups = selected ? groupMetadata(selected.metadata) : [];

  return (
    <section className="metadata-inspector" aria-labelledby="metadata-title">
      <header className="sidebar__header">
        <div>
          <span className="section-label">Inspector</span>
          <h2 id="metadata-title">Metadata</h2>
        </div>
      </header>
      <div className="metadata-inspector__scroll" aria-live="polite">
        {selectedImages.length === 0 && (
          <div className="metadata-empty">
            <Info aria-hidden="true" size={22} />
            <strong>Select an image</strong>
            <span>File details and embedded metadata will appear here.</span>
          </div>
        )}

        {selectedImages.length > 1 && (
          <div className="metadata-aggregate">
            <span className="section-label">Selection</span>
            <strong>{selectedImages.length} images</strong>
            <dl>
              <div>
                <dt>Total size</dt>
                <dd>{formatBytes(selectedBytes)}</dd>
              </div>
              <div>
                <dt>Dimensions</dt>
                <dd>{uniqueResolutions.size} groups</dd>
              </div>
              <div>
                <dt>Formats</dt>
                <dd>{new Set(selectedImages.map((image) => image.extension)).size}</dd>
              </div>
            </dl>
            <p>Select one image to inspect its embedded EXIF, IPTC, and XMP fields.</p>
          </div>
        )}

        {selectedImages.length === 1 && selected && (
          <>
            <div className="metadata-file">
              <FileImage aria-hidden="true" size={20} />
              <div>
                <strong title={selected.name}>{selected.name}</strong>
                <span title={selected.relativePath}>{selected.relativePath}</span>
              </div>
            </div>
            <dl className="metadata-basics">
              <div>
                <dt>Dimensions</dt>
                <dd>{getResolution(selected)}</dd>
              </div>
              <div>
                <dt>File size</dt>
                <dd>{formatBytes(selected.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>{selected.extension.replace(/^\./, '').toUpperCase()}</dd>
              </div>
            </dl>

            {metadataGroups.length === 0 ? (
              <div className="metadata-empty metadata-empty--compact">
                <span>No embedded text metadata was found.</span>
              </div>
            ) : (
              <div className="metadata-groups">
                {metadataGroups.map((group) => (
                  <section key={group.title}>
                    <h3>{group.title}</h3>
                    <dl>
                      {group.entries.map(([key, value]) => (
                        <div key={`${group.title}-${key}`}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ImageCard({
  api,
  image,
  selected,
  onToggle,
  onOpen,
  onReveal,
}: {
  api: DesktopApi | null;
  image: ImageFile;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onReveal: () => void;
}) {
  const [thumbnailState, setThumbnailState] = useState<
    { kind: 'idle' | 'loading' | 'failed' } | { kind: 'loaded'; url: string }
  >({ kind: 'idle' });
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !api) {
      setThumbnailState({ kind: 'failed' });
      return undefined;
    }

    let active = true;
    const load = async () => {
      setThumbnailState({ kind: 'loading' });
      try {
        const url = await api.getThumbnail(image.path);
        if (!active) return;
        setThumbnailState(url ? { kind: 'loaded', url } : { kind: 'failed' });
      } catch {
        if (active) setThumbnailState({ kind: 'failed' });
      }
    };

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      void load();
    }, { rootMargin: '240px' });
    observer.observe(card);

    return () => {
      active = false;
      observer.disconnect();
    };
  }, [api, image.path]);

  return (
    <article
      ref={cardRef}
      className={`image-card${selected ? ' image-card--selected' : ''}`}
    >
      <label className="image-card__select-surface">
        <input
          className="image-card__checkbox"
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`${selected ? 'Deselect' : 'Select'} ${image.name}`}
        />
        <span className="image-card__check" aria-hidden="true">
          {selected && <Check size={16} />}
        </span>
        <span className="image-card__preview">
          {thumbnailState.kind === 'loaded' && (
            <img src={thumbnailState.url} alt="" loading="lazy" />
          )}
          {thumbnailState.kind === 'loading' && (
            <span className="thumbnail-status" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={22} />
              <span>Loading preview</span>
            </span>
          )}
          {thumbnailState.kind === 'idle' && (
            <span className="thumbnail-status" aria-hidden="true">
              <FileImage size={22} />
            </span>
          )}
          {thumbnailState.kind === 'failed' && (
            <span className="thumbnail-status thumbnail-status--failed">
              <ImageOff aria-hidden="true" size={22} />
              <span>Preview unavailable</span>
            </span>
          )}
        </span>
      </label>

      <div className="image-card__body">
        <div>
          <h4 title={image.name}>{image.name}</h4>
          <p title={image.relativePath}>{image.relativePath}</p>
        </div>
        <div className="image-card__facts">
          <span>{image.extension.replace(/^\./, '').toUpperCase()}</span>
          <span>{formatBytes(image.sizeBytes, 0)}</span>
        </div>
      </div>

      <div className="image-card__actions">
        <button type="button" onClick={onOpen} disabled={!api}>
          <ExternalLink aria-hidden="true" size={15} />
          Open
        </button>
        <button type="button" onClick={onReveal} disabled={!api}>
          <Folder aria-hidden="true" size={15} />
          Reveal
        </button>
      </div>
    </article>
  );
}

function ExportTray({
  api,
  copyState,
  selectedCount,
  selectedBytes,
  hiddenSelectedCount,
  onClear,
  onCopy,
}: {
  api: DesktopApi | null;
  copyState: CopyState;
  selectedCount: number;
  selectedBytes: number;
  hiddenSelectedCount: number;
  onClear: () => void;
  onCopy: () => void;
}) {
  const isCopying = copyState.kind === 'copying';
  let completedTargetDir: string | null = null;
  if (copyState.kind === 'success') {
    completedTargetDir = copyState.result.targetDir;
  } else if (copyState.kind === 'error' && copyState.result) {
    completedTargetDir = copyState.result.targetDir;
  }
  let title = selectedCount > 0
    ? `${selectedCount} image${selectedCount === 1 ? '' : 's'} selected`
    : 'No images selected';
  let detail = selectedCount > 0
    ? `${formatBytes(selectedBytes)} ready to copy`
    : 'Select individual images, a dimension group, or all filter matches.';
  let tone = 'neutral';

  if (hiddenSelectedCount > 0) {
    detail += ` · ${hiddenSelectedCount} outside the current filters`;
  }
  if (copyState.kind === 'copying') {
    title = `Copying ${copyState.count} image${copyState.count === 1 ? '' : 's'}…`;
    detail = `Destination: ${copyState.targetDir}`;
    tone = 'working';
  }
  if (copyState.kind === 'success') {
    title = `${copyState.result.copiedCount} image${copyState.result.copiedCount === 1 ? '' : 's'} copied`;
    detail = copyState.result.renamedCount > 0
      ? `${copyState.result.renamedCount} conflict${copyState.result.renamedCount === 1 ? '' : 's'} renamed safely · ${formatBytes(copyState.result.bytesCopied)}`
      : `${formatBytes(copyState.result.bytesCopied)} copied successfully`;
    tone = 'success';
  }
  if (copyState.kind === 'error') {
    title = copyState.result
      ? `${copyState.result.copiedCount} copied · ${copyState.result.failedCount} failed`
      : 'Copy could not be completed';
    detail = copyState.message;
    tone = 'error';
  }

  return (
    <footer className={`export-tray export-tray--${tone}`} aria-label="Safe export">
      <div className="export-tray__status" aria-live="polite">
        {isCopying
          ? <LoaderCircle className="spin" aria-hidden="true" size={21} />
          : tone === 'success'
            ? <CircleCheck aria-hidden="true" size={21} />
            : tone === 'error'
              ? <AlertTriangle aria-hidden="true" size={21} />
              : <Copy aria-hidden="true" size={21} />}
        <div>
          <strong>{title}</strong>
          <span title={detail}>{detail}</span>
        </div>
      </div>

      <div className="export-tray__promise">
        <ShieldCheck aria-hidden="true" size={20} />
        <span>
          <strong>Safe export</strong>
          Existing files are never overwritten.
        </span>
      </div>

      <div className="export-tray__actions">
        {completedTargetDir && (
          <button
            className="button button--dark-quiet"
            type="button"
            onClick={() => void api?.openPath(completedTargetDir)}
          >
            <FolderOpen aria-hidden="true" size={16} />
            Open destination
          </button>
        )}
        <button
          className="button button--dark-quiet"
          type="button"
          onClick={onClear}
          disabled={
            isCopying
            || (selectedCount === 0 && copyState.kind === 'idle')
          }
        >
          Clear
        </button>
        <button
          className="button button--export"
          type="button"
          onClick={onCopy}
          disabled={!api || selectedCount === 0 || isCopying}
        >
          {isCopying
            ? <LoaderCircle className="spin" aria-hidden="true" size={16} />
            : <Copy aria-hidden="true" size={16} />}
          {isCopying
            ? 'Copying…'
            : `Copy ${selectedCount || ''} file${selectedCount === 1 ? '' : 's'}…`}
        </button>
      </div>
    </footer>
  );
}
