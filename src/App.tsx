import { useState, useMemo, useRef, useEffect } from 'react';
import { Folder, Image as ImageIcon, Copy, Check, Search, ChevronRight, ChevronDown, Minus, Square, X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Ensure type matching with Electron
interface ImageFile {
  id: string;
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  resolution?: string;
  metadata?: Record<string, string>;
}

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

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0 || !bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

const SIZE_BUCKETS = {
  '>1GB': 1024 * 1024 * 1024,
  '100MB-1GB': 100 * 1024 * 1024,
  '10MB-100MB': 10 * 1024 * 1024,
  '1MB-10MB': 1024 * 1024,
  '<1MB': 0,
};

type SizeBucketName = keyof typeof SIZE_BUCKETS;

function getSizeBucket(bytes: number): SizeBucketName {
  if (bytes >= SIZE_BUCKETS['>1GB']) return '>1GB';
  if (bytes >= SIZE_BUCKETS['100MB-1GB']) return '100MB-1GB';
  if (bytes >= SIZE_BUCKETS['10MB-100MB']) return '10MB-100MB';
  if (bytes >= SIZE_BUCKETS['1MB-10MB']) return '1MB-10MB';
  return '<1MB';
}

const SIZE_BUCKET_ORDER: SizeBucketName[] = ['>1GB', '100MB-1GB', '10MB-100MB', '1MB-10MB', '<1MB'];

// Extract naming tags from filename
function extractTags(name: string): string[] {
  const noExt = name.replace(/\.[^/.]+$/, "");
  const parts = noExt.split(/[_\-\s]+/);
  // filter out numbers, resolutions, empty strings
  return parts.filter(p => isNaN(Number(p)) && !/^\d+x\d+$/i.test(p) && p.length > 1);
}

interface ActiveFilters {
  extensions: Set<string>;
  sizes: Set<string>;
  tags: Set<string>;
}

export default function App() {
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const [images, setImages] = useState<ImageFile[]>([]);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filtering
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({
    extensions: new Set(),
    sizes: new Set(),
    tags: new Set()
  });

  // UI state
  const [scanning, setScanning] = useState(false);
  const [copying, setCopying] = useState(false);
  const [resolutionSearch, setResolutionSearch] = useState('');

  // Directory Tree state
  const [dirTree, setDirTree] = useState<DirectoryStatNode | null>(null);
  const [selectedNodePaths, setSelectedNodePaths] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSelectFolder = async () => {
    try {
      // @ts-ignore
      const dir = await window.electronAPI.openDirectory();
      if (dir) {
        setTargetDir(dir);
        setSelectedNodePaths(new Set());
        setScanning(true);
        setDirTree(null); // Reset tree

        // Fetch full directory stats in parallel with image scanning
        // @ts-ignore
        window.electronAPI.getDirectoryStats(dir).then((stats: DirectoryStatNode) => {
          setDirTree(stats);
        }).catch(console.error);

        // @ts-ignore
        const scannedImages = await window.electronAPI.scanDirectory(dir);
        setImages(scannedImages || []);
        setSelectedIds(new Set());
        setActiveFilters({ extensions: new Set(), sizes: new Set(), tags: new Set() }); // Reset filters
        setScanning(false);
      }
    } catch (e) {
      console.error(e);
      setScanning(false);
    }
  };

  const handleCopyFiles = async () => {
    if (selectedIds.size === 0) return;
    try {
      // @ts-ignore
      const destDir = await window.electronAPI.openDirectory();
      if (destDir) {
        setCopying(true);
        const filesToCopy = images.filter(img => selectedIds.has(img.id)).map(img => img.path);
        // @ts-ignore
        const result = await window.electronAPI.copyFiles(filesToCopy, destDir);
        setCopying(false);
        if (result.success) {
          alert(`Successfully copied ${result.copiedCount} files to \n${destDir}`);
          setSelectedIds(new Set()); // Clear selection on success
        } else {
          alert('Failed to copy files: ' + result.error);
        }
      }
    } catch (e) {
      console.error(e);
      setCopying(false);
    }
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleFilter = (category: keyof ActiveFilters, value: string) => {
    setActiveFilters(prev => {
      const newFilters = { ...prev };
      const currentSet = new Set(newFilters[category]);
      if (currentSet.has(value)) {
        currentSet.delete(value);
      } else {
        currentSet.add(value);
      }
      newFilters[category] = currentSet;
      return newFilters;
    });
  };

  // 1. Compute all unique available filters across ALL images
  const filterOptions = useMemo(() => {
    const extCounts: Record<string, number> = {};
    const sizeCounts: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};

    images.forEach(img => {
      // Extensions
      const ext = img.extension.toUpperCase().replace('.', '');
      if (ext) extCounts[ext] = (extCounts[ext] || 0) + 1;

      // Sizes
      const sizeBucket = getSizeBucket(img.sizeBytes);
      sizeCounts[sizeBucket] = (sizeCounts[sizeBucket] || 0) + 1;

      // Tags
      const tags = extractTags(img.name);
      tags.forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    return {
      extensions: Object.keys(extCounts).sort(), // alphabetical
      sizes: SIZE_BUCKET_ORDER.filter(s => sizeCounts[s] > 0), // enforced order
      tags: Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1]) // by frequency
        .map(entry => entry[0])
        .slice(0, 40) // Limit tags to top 40 
    };
  }, [images]);

  // 2. Filter images based on selected filters (AND between categories, OR within categories)
  const filteredImages = useMemo(() => {
    // First, filter by the selected directory node if applicable
    let pathFilteredImages = images;
    if (selectedNodePaths.size > 0) {
      const normalizedSelectedPaths: string[] = [];
      selectedNodePaths.forEach(path => {
        normalizedSelectedPaths.push(path.replace(/\\/g, '/'));
      });

      pathFilteredImages = images.filter(img => {
        const normalizedImg = img.path.replace(/\\/g, '/');
        // Check exact match or starts with + slash against *any* selected path
        return normalizedSelectedPaths.some(selected =>
          normalizedImg === selected || normalizedImg.startsWith(selected + '/')
        );
      });
    }

    // Return early if no active tag/size/extension filters
    if (activeFilters.extensions.size === 0 &&
      activeFilters.sizes.size === 0 &&
      activeFilters.tags.size === 0) {
      return pathFilteredImages;
    }

    return pathFilteredImages.filter(img => {
      const imgExt = img.extension.toUpperCase().replace('.', '');
      const imgSizeBucket = getSizeBucket(img.sizeBytes);
      const imgTags = new Set(extractTags(img.name));

      // Check Extensions (OR within category)
      let passExt = true;
      if (activeFilters.extensions.size > 0) {
        passExt = activeFilters.extensions.has(imgExt);
      }

      // Check Sizes (OR within category)
      let passSize = true;
      if (activeFilters.sizes.size > 0) {
        passSize = activeFilters.sizes.has(imgSizeBucket);
      }

      // Check Tags (AND logic for tags, user usually wants items containing ALL selected tags)
      let passTags = true;
      if (activeFilters.tags.size > 0) {
        // Must contain all selected tags
        activeFilters.tags.forEach(t => {
          if (!imgTags.has(t)) passTags = false;
        });
      }

      // Final result is AND combining all categories
      return passExt && passSize && passTags;
    });
  }, [images, activeFilters, selectedNodePaths]);

  // 3. Group filtered images by Resolution only with 2-pixel fuzzy tolerance
  const groupedImages = useMemo(() => {
    // First, collect all unique raw resolutions and their images
    const rawGroups: Record<string, ImageFile[]> = {};
    filteredImages.forEach(img => {
      const key = img.resolution || 'Unknown Size';
      if (!rawGroups[key]) rawGroups[key] = [];
      rawGroups[key].push(img);
    });

    // We will establish "Anchor" resolutions.
    // Order raw keys by frequency (largest groups become anchors first) to pick the most representative resolution.
    const rawKeys = Object.keys(rawGroups).sort((a, b) => rawGroups[b].length - rawGroups[a].length);

    const anchorGroups: Record<string, ImageFile[]> = {};
    const parsedAnchors: { str: string, w: number, h: number }[] = [];

    // Assign each raw group to an anchor
    for (const key of rawKeys) {
      if (key === 'Unknown Size') {
        anchorGroups[key] = (anchorGroups[key] || []).concat(rawGroups[key]);
        continue;
      }

      const [w, h] = key.split('x').map(Number);

      // Find a matching anchor within 2 pixels tolerance
      const match = parsedAnchors.find(anchor =>
        Math.abs(anchor.w - w) <= 2 && Math.abs(anchor.h - h) <= 2
      );

      if (match) {
        // Merge into existing anchor
        anchorGroups[match.str] = anchorGroups[match.str].concat(rawGroups[key]);
      } else {
        // Create new anchor
        parsedAnchors.push({ str: key, w, h });
        anchorGroups[key] = [...rawGroups[key]];
      }
    }

    // Sort descending by resolution size (area)
    const sortedKeys = Object.keys(anchorGroups).sort((a, b) => {
      if (a === 'Unknown Size') return 1;
      if (b === 'Unknown Size') return -1;
      const [wA, hA] = a.split('x').map(Number);
      const [wB, hB] = b.split('x').map(Number);
      return (wB * hB) - (wA * hA);
    });

    return sortedKeys.reduce((acc, key) => {
      if (resolutionSearch && !key.toLowerCase().includes(resolutionSearch.toLowerCase())) {
        return acc;
      }
      acc[key] = anchorGroups[key];
      return acc;
    }, {} as Record<string, ImageFile[]>);

  }, [filteredImages, resolutionSearch]);

  // Group selection helpers
  const isGroupSelected = (resolution: string) => {
    const groupImgs = groupedImages[resolution];
    if (!groupImgs || groupImgs.length === 0) return false;
    return groupImgs.every(img => selectedIds.has(img.id));
  };

  const toggleGroupSelection = (resolution: string, select: boolean, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newSelected = new Set(selectedIds);
    const groupImgs = groupedImages[resolution] || [];

    groupImgs.forEach(img => {
      if (select) newSelected.add(img.id);
      else newSelected.delete(img.id);
    });
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredImages.length && filteredImages.length > 0) {
      // Deselect all
      setSelectedIds(new Set());
    } else {
      // Select all visible
      const newSelected = new Set(selectedIds);
      filteredImages.forEach(img => newSelected.add(img.id));
      setSelectedIds(newSelected);
    }
  };

  const scrollToResolution = (res: string) => {
    const el = document.getElementById(`res-${res}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // UI rendering helper for filter chips
  const renderFilterChips = (title: string, category: keyof ActiveFilters, items: string[]) => {
    if (items.length === 0) return null;
    return (
      <div className="flex items-start gap-3 mb-3 last:mb-0">
        <span className="text-[10px] font-bold text-black uppercase tracking-widest w-20 shrink-0 text-right pr-2 pt-1.5">
          {title}
        </span>
        <div className="flex flex-wrap gap-2 flex-1">
          {items.map(val => {
            const isActive = activeFilters[category].has(val);
            return (
              <button
                key={val}
                onClick={() => toggleFilter(category, val)}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-none transition-colors border-2 shadow-none",
                  isActive
                    ? "bg-black border-black text-white"
                    : "bg-white border-black text-black hover:bg-black hover:text-white"
                )}
              >
                {val}
              </button>
            )
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col bg-white text-black h-screen overflow-hidden font-sans">

      {/* Top Header - Draggable */}
      <header
        className="h-[60px] shrink-0 border-b-3 border-black flex items-center justify-between pl-6 bg-white relative z-20"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-6">
          <h1 className="font-serif text-3xl font-normal tracking-tightest text-black">Image Sorter</h1>
          {targetDir && (
            <div className="flex items-center gap-2 px-3 py-1 border-2 border-black bg-muted text-black text-xs font-mono rounded-none" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <Folder size={12} strokeWidth={2.5} />
              <span className="truncate max-w-[300px] font-bold">{targetDir}</span>
              <button onClick={handleSelectFolder} className="text-black hover:bg-black hover:text-white px-1 ml-2 transition-colors border border-transparent hover:border-black underline decoration-2 underline-offset-2">Change</button>
            </div>
          )}
        </div>

        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!targetDir ? (
            <button
              onClick={handleSelectFolder}
              className="py-1.5 px-6 bg-white hover:bg-black hover:text-white transition-colors rounded-none border-2 border-black text-sm font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]"
            >
              Select Folder
            </button>
          ) : (
            <div className="flex items-center gap-4">
              {selectedIds.size > 0 && (
                <span className="text-xs font-bold text-white px-3 py-1.5 bg-black border-2 border-black">
                  {selectedIds.size} STAGED
                </span>
              )}
              <button
                onClick={handleCopyFiles}
                disabled={copying || selectedIds.size === 0}
                className="py-1.5 px-5 bg-white hover:bg-black hover:text-white disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-black transition-colors rounded-none border-2 border-black text-sm font-bold flex items-center gap-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]"
              >
                {copying ? 'Copying...' : <><Copy size={14} strokeWidth={2.5} /> Copy Selected</>}
              </button>
            </div>
          )}
        </div>

        {/* Window Controls */}
        <div className="flex h-full border-l-3 border-black ml-6" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* @ts-ignore */}
          <button onClick={() => window.electronAPI.minimize()} className="w-[55px] h-full flex items-center justify-center hover:bg-black hover:text-white transition-colors border-r-3 border-black">
            <Minus size={18} strokeWidth={2.5} />
          </button>
          {/* @ts-ignore */}
          <button onClick={() => window.electronAPI.maximize()} className="w-[55px] h-full flex items-center justify-center hover:bg-black hover:text-white transition-colors border-r-3 border-black">
            <Square size={14} strokeWidth={2.5} />
          </button>
          {/* @ts-ignore */}
          <button onClick={() => window.electronAPI.close()} className="w-[55px] h-full flex items-center justify-center hover:bg-black hover:text-white transition-colors">
            <X size={20} strokeWidth={2.5} />
          </button>
        </div>
      </header>

      {/* Main App Area */}
      <div className="flex flex-1 overflow-hidden min-h-0 bg-white" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>

        {/* Left Sidebar - Directory Tree */}
        {targetDir && (
          <aside className="w-[320px] lg:w-[400px] shrink-0 bg-white flex flex-col border-r-3 border-black z-10 transition-all">
            <div className="p-4 border-b-2 border-black flex items-center justify-between bg-surface">
              <h2 className="text-xs font-bold tracking-widest text-black uppercase flex items-center gap-2">
                Directory Tree
              </h2>
            </div>

            {/* Tree Headers */}
            <div className="flex items-center px-4 py-2 border-b-2 border-black bg-white text-[10px] font-bold text-black uppercase tracking-widest">
              <span className="flex-1">Name</span>
              <div className="flex items-center gap-6 shrink-0 w-[130px]">
                <span className="w-20 text-right">Size</span>
                <span className="w-12 text-right">Items</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar bg-white p-2">
              {!dirTree ? (
                <div className="h-full flex flex-col items-center justify-center text-black/50 gap-4">
                  <div className="animate-spin h-6 w-6 border-2 border-black border-t-transparent rounded-full"></div>
                  <p className="text-xs font-bold uppercase tracking-widest">Calculating...</p>
                </div>
              ) : (
                <div className="pb-4">
                  <DirectoryTreeNode
                    node={dirTree}
                    selectedNodePaths={selectedNodePaths}
                    onToggleSelect={(path) => {
                      setSelectedNodePaths(prev => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      });
                    }}
                  />
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Center Area (Filters + Grid) */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Top Filters Bar - Categorized */}
          {targetDir && (
            <div className="shrink-0 border-b-3 border-black bg-muted p-4 flex flex-col overflow-y-auto max-h-48 custom-scrollbar">
              {renderFilterChips("Extensions", "extensions", filterOptions.extensions)}
              {renderFilterChips("File Size", "sizes", filterOptions.sizes)}
              {renderFilterChips("Tags", "tags", filterOptions.tags)}
            </div>
          )}

          {/* Image Grid Scroll Area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 md:p-8 custom-scrollbar bg-white">
            {!targetDir ? (
              <div className="h-full flex flex-col justify-center items-center opacity-100">
                <ImageIcon size={64} strokeWidth={1.5} className="mb-4 text-black" />
                <p className="text-black font-serif text-2xl tracking-tight cursor-pointer hover:underline transition-all" onClick={handleSelectFolder}>Please select a folder to start scanning.</p>
              </div>
            ) : scanning ? (
              <div className="h-full flex flex-col items-center justify-center text-black gap-4">
                <div className="animate-spin h-8 w-8 border-4 border-black border-t-white rounded-full"></div>
                <p className="text-sm font-bold uppercase tracking-widest">Scanning...</p>
              </div>
            ) : filteredImages.length === 0 ? (
              <div className="h-full flex flex-col justify-center items-center text-black">
                <p className="font-serif text-2xl">No images match the selected filters.</p>
              </div>
            ) : (
              <div className="space-y-12">
                {Object.entries(groupedImages).map(([resolution, imgs]) => (
                  <div key={resolution} id={`res-${resolution}`} className="scroll-mt-6">
                    <div className="flex items-center gap-4 mb-6">
                      <h3 className="text-2xl font-serif tracking-tightest text-black flex items-center gap-2">
                        {resolution} <span className="text-black font-sans font-normal text-sm border-2 border-black rounded-full px-2">({imgs.length})</span>
                      </h3>
                      <div className="flex-1 h-px border-b-2 border-black border-dashed opacity-30" />
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6 gap-6 pl-1 pt-1 pb-2">
                      {imgs.map(img => (
                        <ImageCard
                          key={img.id}
                          img={img}
                          selected={selectedIds.has(img.id)}
                          onToggle={() => toggleSelect(img.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar - Resolutions Panel */}
        {targetDir && !scanning && (
          <aside className="w-[300px] shrink-0 bg-surface flex flex-col border-l-3 border-black z-10">
            <div className="p-4 border-b-2 border-black flex items-center justify-between bg-white">
              <h2 className="text-xs font-bold tracking-widest text-black uppercase flex items-center gap-2">
                Resolutions <span className="bg-black text-white px-2 py-0.5 rounded-none text-[10px] font-mono shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)]">{Object.keys(groupedImages).length}</span>
              </h2>
            </div>

            {/* Search Input */}
            <div className="p-4 border-b-2 border-black bg-surface">
              <div className="relative pixel-shadow">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-black" strokeWidth={2.5} />
                <input
                  type="text"
                  placeholder="Search dimensions..."
                  value={resolutionSearch}
                  onChange={e => setResolutionSearch(e.target.value)}
                  className="w-full bg-white border-2 border-black rounded-none py-2 pl-9 pr-3 text-sm text-black placeholder-gray-500 focus:outline-none focus:ring-0 transition-colors"
                />
              </div>
            </div>

            <div className="p-4 border-b-2 border-black bg-surface">
              <button
                onClick={toggleSelectAll}
                className="w-full py-2.5 bg-white hover:bg-black border-2 border-black text-sm font-bold rounded-none transition-colors text-black hover:text-white text-center shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]"
              >
                Select All Visible
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar bg-white">
              {Object.entries(groupedImages).map(([res, imgs]) => {
                const isSelected = isGroupSelected(res);
                return (
                  <div
                    key={res}
                    className={cn(
                      "flex items-center gap-3 p-3 cursor-pointer transition-colors border-b-2 border-black/10 last:border-b-0",
                      isSelected ? "bg-black text-white" : "hover:bg-muted"
                    )}
                    onClick={() => scrollToResolution(res)}
                  >
                    {/* Checkbox */}
                    <div
                      className="shrink-0 flex items-center justify-center"
                      onClick={(e) => toggleGroupSelection(res, !isSelected, e)}
                    >
                      <div className={cn(
                        "w-5 h-5 border-2 flex items-center justify-center transition-colors rounded-none",
                        isSelected ? "bg-black border-white" : "border-black bg-white"
                      )}>
                        {isSelected && <Check size={14} className="text-white" strokeWidth={4} />}
                      </div>
                    </div>

                    {/* Label */}
                    <span className="text-sm font-semibold flex-1 truncate">
                      {res}
                    </span>

                    {/* Counter */}
                    <span className={cn("text-xs font-mono font-bold", isSelected ? "opacity-70" : "opacity-40")}>{imgs.length}</span>
                  </div>
                );
              })}
            </div>

            {/* Metadata Inspector */}
            <div className="shrink-0 h-[300px] border-t-3 border-black flex flex-col bg-white overflow-hidden">
              <div className="p-3 border-b-2 border-black bg-[#F1F1F1]">
                <h2 className="text-[10px] font-bold tracking-widest text-black uppercase">Metadata Inspector</h2>
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar p-4 text-xs">
                {selectedIds.size === 0 ? (
                  <div className="h-full flex items-center justify-center text-black/50 font-bold uppercase tracking-widest text-center px-4">
                    Select an image to view parameters
                  </div>
                ) : selectedIds.size > 1 ? (
                  <div className="h-full flex flex-col items-center justify-center text-black/50 gap-2 font-bold uppercase tracking-widest text-center px-4">
                    <div>Multiple Items Selected</div>
                    <div className="text-[10px] bg-black text-white px-2 py-1">{selectedIds.size} files</div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {(() => {
                      const selectedId = Array.from(selectedIds)[0];
                      const selectedImg = images.find(img => img.id === selectedId);
                      if (!selectedImg) return null;

                      const hasMeta = selectedImg.metadata && Object.keys(selectedImg.metadata).length > 0;
                      if (!hasMeta) {
                        return <div className="text-black/50 italic py-4 text-center">No standard string metadata found.</div>;
                      }

                      return Object.entries(selectedImg.metadata || {}).map(([key, val]) => (
                        <div key={key} className="flex flex-col border-b border-black/10 pb-2 last:border-0 last:pb-0">
                          <span className="font-bold text-[10px] uppercase text-black/60 font-sans tracking-wider truncate mb-1" title={key}>{key}</span>
                          <span className="font-mono text-black break-all">{val}</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function DirectoryTreeNode({
  node,
  level = 0,
  selectedNodePaths,
  onToggleSelect
}: {
  node: DirectoryStatNode;
  level?: number;
  selectedNodePaths: Set<string>;
  onToggleSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!node.isDirectory) return null; // Only show directories in the tree

  const isSelected = selectedNodePaths.has(node.path);

  return (
    <div className="flex flex-col border-b-2 border-black/10 last:border-0 font-sans">
      <div
        className={cn(
          "flex items-center py-2 px-3 cursor-pointer group transition-colors",
          isSelected ? "bg-black text-white" : "hover:bg-muted text-black",
          !isSelected && expanded ? "bg-muted/50" : ""
        )}
        style={{ paddingLeft: `${Math.max(0.75, level * 1.5)}rem` }}
        onClick={() => onToggleSelect(node.path)}
      >
        <div
          className={cn("w-5 h-5 flex items-center justify-center shrink-0 mr-1", isSelected ? "text-white" : "text-black")}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {node.children && node.children.length > 0 ? (
            expanded ? <ChevronDown size={16} strokeWidth={2.5} /> : <ChevronRight size={16} strokeWidth={2.5} />
          ) : <div className={cn("w-1.5 h-1.5 rounded-none", isSelected ? "bg-white/40" : "bg-black/20")} />}
        </div>

        <div className={cn(
          "w-4 h-4 border-2 flex items-center justify-center shrink-0 mr-2 transition-colors rounded-none",
          isSelected ? "bg-white border-white" : "border-black bg-white"
        )}>
          {isSelected && <Check size={12} className="text-black" strokeWidth={4} />}
        </div>

        <Folder size={16} className={cn("mr-2 shrink-0", isSelected ? "text-white" : "text-black")} strokeWidth={2} fill={expanded ? "currentColor" : "none"} />

        <span className="text-sm font-bold truncate flex-1 mr-4">{node.name}</span>

        <div className="flex items-center gap-6 text-xs font-mono shrink-0">
          <div className="w-20 text-right font-bold">{formatBytes(node.sizeBytes, 1)}</div>
          <div className="w-12 text-right opacity-60">{node.itemsCount}</div>
        </div>
      </div>

      {expanded && node.children && (
        <div className="flex flex-col border-l-2 border-black/10 ml-5">
          {node.children.map(child => (
            <DirectoryTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedNodePaths={selectedNodePaths}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ImageCard({ img, selected, onToggle }: { img: ImageFile, selected: boolean, onToggle: () => void }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [inView, setInView] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          observer.disconnect(); // Stop observing once it's in view
        }
      },
      { rootMargin: '200px' } // Load slightly before scrolling into view
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return; // Don't fetch until visible

    let mounted = true;
    const fetchThumbnail = async () => {
      try {
        // @ts-ignore
        const url = await window.electronAPI.getThumbnail(img.path);
        if (mounted && url) {
          setThumbnailUrl(url);
        }
      } catch (e) {
        console.error("Failed to load thumbnail for", img.path, e);
      }
    };
    fetchThumbnail();
    return () => { mounted = false; };
  }, [img.path, inView]);

  return (
    <div ref={cardRef} className="relative pixel-shadow h-full">
      <div
        onClick={onToggle}
        className={cn(
          "group relative flex flex-col h-full overflow-hidden cursor-pointer transition-colors duration-150 select-none",
          "border-3 rounded-none bg-white",
          selected ? "border-accent-green" : "border-black hover:bg-muted"
        )}
      >
        <div className="absolute top-2 left-2 z-10">
          <div className={cn(
            "w-6 h-6 border-2 flex items-center justify-center rounded-none shadow-sm transition-colors",
            selected ? "bg-accent-green border-accent-green" : "border-black bg-white/80 opacity-0 group-hover:opacity-100"
          )}>
            {selected && <Check size={16} className="text-white" strokeWidth={4} />}
          </div>
        </div>

        <div className="aspect-[4/3] relative overflow-hidden flex items-center justify-center p-2 bg-muted border-b-3 border-black">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={img.name}
              className="max-h-full max-w-full object-contain transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full bg-black/10 animate-pulse flex items-center justify-center">
              <ImageIcon size={24} className="text-black/30" strokeWidth={2} />
            </div>
          )}
        </div>

        <div className="p-3 flex flex-col justify-between flex-1 gap-1.5 bg-white">
          <p className="font-bold text-xs truncate text-black uppercase tracking-tight" title={img.name}>{img.name}</p>
          <div className="flex items-center justify-between text-black font-mono font-bold text-[10px] mt-auto">
            <span className="bg-muted px-1 border border-black">{img.extension.toUpperCase()}</span>
            <span>{formatBytes(img.sizeBytes, 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
