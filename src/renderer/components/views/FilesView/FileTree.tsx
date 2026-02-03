// ============================================================================
// FILE TREE COMPONENT
// Left panel folder tree navigation
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Home, ArrowUp, Pin, X, GripHorizontal, Play, FolderPlus } from 'lucide-react';
import { clsx } from 'clsx';

interface TreeNode {
  id: string;
  name: string;
  isDir: boolean;
  children?: TreeNode[];
}

interface PinnedFolder {
  path: string;
  name: string;
}

interface FileTreeProps {
  rootPath: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onLoadChildren: (path: string) => Promise<TreeNode[]>;
  pinnedFolders: PinnedFolder[];
  onPinFolder: (path: string, name: string) => void;
  onUnpinFolder: (path: string) => void;
  onStartSession?: (path: string) => void;
  onAddToRegistry?: (path: string) => void;
}

interface TreeItemProps {
  node: TreeNode;
  level: number;
  currentPath: string;
  onNavigate: (path: string) => void;
  onLoadChildren: (path: string) => Promise<TreeNode[]>;
  onPinFolder: (path: string, name: string) => void;
  onStartSession?: (path: string) => void;
  onAddToRegistry?: (path: string) => void;
  isPinned: boolean;
  isExpanded: boolean;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  registerRef: (path: string, el: HTMLDivElement | null) => void;
}

function TreeItem({ node, level, currentPath, onNavigate, onLoadChildren, onPinFolder, onStartSession, onAddToRegistry, isPinned, isExpanded, expandedPaths, onToggleExpand, registerRef }: TreeItemProps) {
  const [children, setChildren] = useState<TreeNode[] | null>(node.children || null);
  const [isLoading, setIsLoading] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState<{ x: number; y: number } | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  // Register this item's ref for scrolling
  useEffect(() => {
    registerRef(node.id, itemRef.current);
    return () => registerRef(node.id, null);
  }, [node.id, registerRef]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handlePin = () => {
    onPinFolder(node.id, node.name);
    setShowContextMenu(null);
  };

  useEffect(() => {
    const closeMenu = () => setShowContextMenu(null);
    if (showContextMenu) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
    return undefined;
  }, [showContextMenu]);

  const isSelected = currentPath === node.id;
  const indent = level * 12 + 8;

  // Load children when expanded (if not already loaded)
  useEffect(() => {
    const loadChildrenIfNeeded = async () => {
      if (isExpanded && !children) {
        setIsLoading(true);
        try {
          const loadedChildren = await onLoadChildren(node.id);
          setChildren(loadedChildren.filter(c => c.isDir));
        } catch {
          setChildren([]);
        } finally {
          setIsLoading(false);
        }
      }
    };
    loadChildrenIfNeeded();
  }, [isExpanded, children, node.id, onLoadChildren]);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.id);
  };

  const handleClick = () => {
    onNavigate(node.id);
  };

  if (!node.isDir) return null;

  return (
    <div>
      <div
        ref={itemRef}
        className={clsx(
          'flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
          isSelected
            ? 'bg-primary-600/20 text-primary-300'
            : 'hover:bg-surface-700/50 text-surface-300 hover:text-surface-100'
        )}
        style={{ paddingLeft: indent }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <button
          onClick={handleToggle}
          className="p-0.5 hover:bg-surface-600/50 rounded"
        >
          {isLoading ? (
            <div className="w-3.5 h-3.5 border-2 border-surface-500 border-t-primary-400 rounded-full animate-spin" />
          ) : isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        
        {isExpanded ? (
          <FolderOpen className="w-4 h-4 text-primary-400" />
        ) : (
          <Folder className="w-4 h-4 text-surface-400" />
        )}
        
        <span className="text-sm truncate flex-1">{node.name}</span>
        {isPinned && <Pin className="w-3 h-3 text-primary-400" />}
      </div>
      
      {showContextMenu && (
        <div
          className="fixed bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 z-50"
          style={{ left: showContextMenu.x, top: showContextMenu.y }}
        >
          {!isPinned && (
            <button
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
              onClick={handlePin}
            >
              <Pin className="w-4 h-4" /> Pin folder
            </button>
          )}
          {onStartSession && (
            <button
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
              onClick={() => { onStartSession(node.id); setShowContextMenu(null); }}
            >
              <Play className="w-4 h-4" /> Start new session
            </button>
          )}
          {onAddToRegistry && (
            <button
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
              onClick={() => { onAddToRegistry(node.id); setShowContextMenu(null); }}
            >
              <FolderPlus className="w-4 h-4" /> Add to project registry
            </button>
          )}
        </div>
      )}
      
      {isExpanded && children && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              level={level + 1}
              currentPath={currentPath}
              onNavigate={onNavigate}
              onLoadChildren={onLoadChildren}
              onPinFolder={onPinFolder}
              onStartSession={onStartSession}
              onAddToRegistry={onAddToRegistry}
              isPinned={false}
              isExpanded={expandedPaths.has(child.id)}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              registerRef={registerRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ rootPath, currentPath, onNavigate, onLoadChildren, pinnedFolders, onPinFolder, onUnpinFolder, onStartSession, onAddToRegistry }: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pinnedContextMenu, setPinnedContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [pinnedHeight, setPinnedHeight] = useState(30); // percentage
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isDragging = useRef(false);

  // Register/unregister tree item refs for scrolling
  const registerItemRef = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(path, el);
    } else {
      itemRefs.current.delete(path);
    }
  }, []);

  // Toggle expansion of a path
  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Get all ancestor paths for a given path (relative to rootPath)
  const getAncestorPaths = useCallback((targetPath: string): string[] => {
    const paths: string[] = [];
    // Build path from root to target
    const targetParts = targetPath.split('/').filter(Boolean);
    const rootParts = rootPath.split('/').filter(Boolean);
    
    // Start from one level after root
    let currentPath = rootPath;
    for (let i = rootParts.length; i < targetParts.length; i++) {
      currentPath = currentPath + '/' + targetParts[i];
      paths.push(currentPath);
    }
    return paths;
  }, [rootPath]);

  // Expand to a specific path (collapse all, then expand ancestors + target)
  const expandToPath = useCallback((targetPath: string) => {
    const ancestorPaths = getAncestorPaths(targetPath);
    // Include the target path itself to expand it
    const pathsToExpand = [...ancestorPaths];
    setExpandedPaths(new Set(pathsToExpand));
  }, [getAncestorPaths]);

  // Scroll to a specific path in the tree (with retry for async loading)
  const scrollToPath = useCallback((targetPath: string) => {
    let attempts = 0;
    const maxAttempts = 20; // Max 2 seconds (20 * 100ms)
    
    const tryScroll = () => {
      const el = itemRefs.current.get(targetPath);
      const scrollContainer = treeScrollRef.current;
      
      if (el && scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const offsetTop = elRect.top - containerRect.top + scrollContainer.scrollTop;
        // Scroll so the element is at the top of the container
        scrollContainer.scrollTo({ top: offsetTop, behavior: 'smooth' });
      } else if (attempts < maxAttempts) {
        // Element not found yet, retry after delay (waiting for async load)
        attempts++;
        setTimeout(tryScroll, 100);
      }
    };
    
    // Start trying after initial delay for state update
    setTimeout(tryScroll, 50);
  }, []);

  // Handle pinned folder click: collapse all, expand to path, scroll
  const handlePinnedFolderClick = useCallback((folderPath: string) => {
    onNavigate(folderPath);
    expandToPath(folderPath);
    scrollToPath(folderPath);
  }, [onNavigate, expandToPath, scrollToPath]);

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newHeight = ((rect.bottom - e.clientY) / rect.height) * 100;
    setPinnedHeight(Math.min(70, Math.max(15, newHeight)));
  };

  const handleDragEnd = () => {
    isDragging.current = false;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  };

  const handlePinnedContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setPinnedContextMenu({ x: e.clientX, y: e.clientY, path });
  };

  useEffect(() => {
    const closeMenu = () => setPinnedContextMenu(null);
    if (pinnedContextMenu) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
    return undefined;
  }, [pinnedContextMenu]);

  const isPinned = (path: string) => pinnedFolders.some(p => p.path === path);

  const loadChildren = useCallback(onLoadChildren, [onLoadChildren]);

  useEffect(() => {
    const loadRoot = async () => {
      setIsLoading(true);
      try {
        const children = await loadChildren(rootPath);
        setRootNodes(children.filter(c => c.isDir));
      } catch {
        setRootNodes([]);
      } finally {
        setIsLoading(false);
      }
    };
    loadRoot();
  }, [rootPath, loadChildren]);

  const getParentPath = (path: string) => {
    const parts = path.split(/[\/]/).filter(Boolean);
    if (parts.length <= 1) return path;
    parts.pop();
    if (path.match(/^[a-zA-Z]:/)) {
      return parts.join('\\') || path.slice(0, 3);
    }
    return '/' + parts.join('/');
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-700/50">
        <h3 className="text-sm font-medium text-surface-300 uppercase tracking-wider">
          Folders
        </h3>
      </div>

      <div className="px-2 py-2 border-b border-surface-700/50 space-y-1">
        <button
          onClick={() => onNavigate(rootPath)}
          className={clsx(
            'flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm transition-colors',
            currentPath === rootPath
              ? 'bg-primary-600/20 text-primary-300'
              : 'hover:bg-surface-700/50 text-surface-400 hover:text-surface-100'
          )}
        >
          <Home className="w-4 h-4" />
          <span>Home</span>
        </button>
        
        {currentPath !== rootPath && (
          <button
            onClick={() => onNavigate(getParentPath(currentPath))}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm hover:bg-surface-700/50 text-surface-400 hover:text-surface-100 transition-colors"
          >
            <ArrowUp className="w-4 h-4" />
            <span>Up one level</span>
          </button>
        )}
      </div>

      <div ref={treeScrollRef} className="overflow-y-auto p-2" style={{ flex: `1 1 ${100 - pinnedHeight}%` }}>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-surface-600 border-t-primary-400 rounded-full animate-spin" />
          </div>
        ) : rootNodes.length === 0 ? (
          <div className="text-center py-8 text-surface-500 text-sm">
            No folders found
          </div>
        ) : (
          rootNodes.map((node) => (
            <TreeItem
              key={node.id}
              node={node}
              level={0}
              currentPath={currentPath}
              onNavigate={onNavigate}
              onLoadChildren={onLoadChildren}
              onPinFolder={onPinFolder}
              onStartSession={onStartSession}
              onAddToRegistry={onAddToRegistry}
              isPinned={isPinned(node.id)}
              isExpanded={expandedPaths.has(node.id)}
              expandedPaths={expandedPaths}
              onToggleExpand={handleToggleExpand}
              registerRef={registerItemRef}
            />
          ))
        )}
      </div>

      {/* Resizable Divider */}
      <div
        className="h-1.5 bg-surface-700/50 hover:bg-primary-500/50 cursor-row-resize flex items-center justify-center group"
        onMouseDown={handleDragStart}
      >
        <GripHorizontal className="w-4 h-4 text-surface-500 group-hover:text-primary-400" />
      </div>

      {/* Pinned Folders Section - Always visible */}
      <div className="border-t border-surface-700/50 overflow-y-auto" style={{ flex: `0 0 ${pinnedHeight}%` }}>
        <div className="px-4 py-2">
          <h4 className="text-xs font-medium text-surface-500 uppercase tracking-wider">Pinned</h4>
        </div>
        <div className="px-2 pb-2 space-y-0.5">
          {pinnedFolders.length === 0 ? (
            <div className="text-center py-4 text-surface-500 text-xs">
              Right-click folders to pin them
            </div>
          ) : (
            pinnedFolders.map((folder) => (
              <button
                key={folder.path}
                onClick={() => handlePinnedFolderClick(folder.path)}
                onContextMenu={(e) => handlePinnedContextMenu(e, folder.path)}
                className={clsx(
                  'flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm transition-colors group',
                  currentPath === folder.path
                    ? 'bg-primary-600/20 text-primary-300'
                    : 'hover:bg-surface-700/50 text-surface-400 hover:text-surface-100'
                )}
              >
                <Pin className="w-3.5 h-3.5 text-primary-400" />
                <span className="truncate flex-1 text-left">{folder.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Pinned folder context menu */}
      {pinnedContextMenu && (
        <div
          className="fixed bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 z-50"
          style={{ left: pinnedContextMenu.x, top: pinnedContextMenu.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
            onClick={() => { onUnpinFolder(pinnedContextMenu.path); setPinnedContextMenu(null); }}
          >
            <X className="w-4 h-4" /> Unpin folder
          </button>
          {onStartSession && (
            <button
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
              onClick={() => { onStartSession(pinnedContextMenu.path); setPinnedContextMenu(null); }}
            >
              <Play className="w-4 h-4" /> Start new session
            </button>
          )}
          {onAddToRegistry && (
            <button
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
              onClick={() => { onAddToRegistry(pinnedContextMenu.path); setPinnedContextMenu(null); }}
            >
              <FolderPlus className="w-4 h-4" /> Add to project registry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
