// ============================================================================
// FILE TREE COMPONENT
// ============================================================================

import { RefreshCw, File, Folder } from 'lucide-react';
import type { ClaudeMdFile } from './types';

type ScopeFilter = 'all' | 'user' | 'project';

interface FileTreeProps {
  files: ClaudeMdFile[];
  selectedPath: string | null;
  onSelect: (file: ClaudeMdFile) => void;
  onRefresh: () => void;
  scopeFilter?: ScopeFilter;
}

export function FileTree({ files, selectedPath, onSelect, onRefresh, scopeFilter = 'all' }: FileTreeProps): React.JSX.Element {
  const groupedFiles = {
    user: files.filter((f) => f.scope === 'user'),
    project: files.filter((f) => f.scope === 'project'),
    local: files.filter((f) => f.scope === 'local'),
  };

  // Determine which sections to show based on scopeFilter
  const showUserSection = scopeFilter === 'all' || scopeFilter === 'user';
  const showProjectSection = scopeFilter === 'all' || scopeFilter === 'project';
  const showLocalSection = scopeFilter === 'all' || scopeFilter === 'project';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-surface-300">CLAUDE.md Files</h3>
        <button
          onClick={onRefresh}
          className="p-1 text-surface-400 hover:text-surface-200 rounded"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* User scope */}
      {showUserSection && groupedFiles.user.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs text-surface-500 mb-2">
            <Folder className="w-3 h-3" />
            User (Global)
          </div>
          {groupedFiles.user.map((file) => (
            <button
              key={file.path}
              onClick={() => onSelect(file)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm ${
                selectedPath === file.path
                  ? 'bg-accent-purple/20 text-accent-purple'
                  : 'text-surface-300 hover:bg-surface-800'
              }`}
            >
              <File className="w-4 h-4" />
              <span className="truncate">{file.name}</span>
              {!file.exists && <span className="text-xs text-surface-500">(create)</span>}
            </button>
          ))}
        </div>
      )}

      {/* Project scope */}
      {showProjectSection && groupedFiles.project.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs text-surface-500 mb-2">
            <Folder className="w-3 h-3" />
            Project
          </div>
          {groupedFiles.project.map((file) => (
            <button
              key={file.path}
              onClick={() => onSelect(file)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm ${
                selectedPath === file.path
                  ? 'bg-accent-purple/20 text-accent-purple'
                  : 'text-surface-300 hover:bg-surface-800'
              }`}
            >
              <File className="w-4 h-4" />
              <span className="truncate">{file.name}</span>
              {!file.exists && <span className="text-xs text-surface-500">(create)</span>}
            </button>
          ))}
        </div>
      )}

      {/* Local scope */}
      {showLocalSection && groupedFiles.local.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-xs text-surface-500 mb-2">
            <Folder className="w-3 h-3" />
            Local (gitignored)
          </div>
          {groupedFiles.local.map((file) => (
            <button
              key={file.path}
              onClick={() => onSelect(file)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm ${
                selectedPath === file.path
                  ? 'bg-accent-purple/20 text-accent-purple'
                  : 'text-surface-300 hover:bg-surface-800'
              }`}
            >
              <File className="w-4 h-4" />
              <span className="truncate">{file.name}</span>
              {!file.exists && <span className="text-xs text-surface-500">(create)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
