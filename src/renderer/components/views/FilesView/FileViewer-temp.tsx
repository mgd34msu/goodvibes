// ============================================================================
// FILE TREE COMPONENT
// Left panel folder tree navigation
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Home, ArrowUp } from 'lucide-react';
import { clsx } from 'clsx';

interface TreeNode {
  id: string;
  name: string;
  isDir: boolean;
  children?: TreeNode[];
}

interface FileTreeProps {
  rootPath: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onLoadChildren: (path: string) => Promise<TreeNode[]>;
}

interface TreeItemProps {
  node: TreeNode;
  level: number;
  currentPath: string;
  onNavigate: (path: string) => void;
  onLoadChildren: (path: string) => Promise<TreeNode[]>;
}

function TreeItem({ node, level, currentPath, onNavigate, onLoadChildren }: TreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNode[] | null>(node.children || null);
  const [isLoading, setIsLoading] = useState(false);

  const isSelected = currentPath === node.id;
  const indent = level * 12 + 8;

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!isExpanded && !children) {
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
    setIsExpanded(!isExpanded);
  };

  const handleClick = () => {
    onNavigate(node.id);
  };

  if (!node.isDir) return null;

  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
          isSelected
            ? 'bg-primary-600/20 text-primary-300'
            : 'hover:bg-surface-700/50 text-surface-300 hover:text-surface-100'
        )}
        style={{ paddingLeft: indent }}
        onClick={handleClick}
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
        
        <span className="text-sm truncate">{node.name}</span>
      </div>
      
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ rootPath, currentPath, onNavigate, onLoadChildren }: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
    <div className="flex flex-col h-full">
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

      <div className="flex-1 overflow-y-auto p-2">
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
            />
          ))
        )}
      </div>
    </div>
  );
}
