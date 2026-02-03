// FileExplorer - Custom file browser with grid/list views
import { useState } from 'react';
import { File, Folder, FileText, FileCode, Image, Grid, List, Pencil, Trash2, ExternalLink, Pin, Play, FolderPlus } from 'lucide-react';
import { clsx } from 'clsx';

interface FileEntry {
id: string;
name: string;
isDir: boolean;
size?: number;
modified?: string;
}

interface FileExplorerProps {
files: FileEntry[];
currentPath: string;
onFileOpen: (file: FileEntry) => void;
onFileSelect: (file: FileEntry | null) => void;
onRename: (file: FileEntry) => void;
onDelete: (file: FileEntry) => void;
onPinFolder?: (path: string, name: string) => void;
onStartSession?: (path: string) => void;
onAddToRegistry?: (path: string) => void;
selectedFile: FileEntry | null;
isLoading: boolean;
}

const getFileIcon = (file: FileEntry) => {
if (file.isDir) return Folder;
const ext = file.name.split('.').pop()?.toLowerCase() || '';
if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return Image;
if (['js', 'ts', 'tsx', 'jsx', 'json', 'py', 'go', 'rs'].includes(ext)) return FileCode;
if (['txt', 'md', 'html', 'css', 'xml'].includes(ext)) return FileText;
return File;
};

const formatSize = (bytes?: number) => {
if (!bytes) return '-';
if (bytes < 1024) return bytes + ' B';
if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

export function FileExplorer({ files, currentPath, onFileOpen, onFileSelect, onRename, onDelete, onPinFolder, onStartSession, onAddToRegistry, selectedFile, isLoading }:
FileExplorerProps) {
const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
const [whitespaceMenu, setWhitespaceMenu] = useState<{ x: number; y: number } | null>(null);
const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified'>('name');
const [sortAsc, setSortAsc] = useState(true);

const sortedFiles = [...files].sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (sortBy === 'modified') cmp = (a.modified || '').localeCompare(b.modified || '');
    return sortAsc ? cmp : -cmp;
});

const handleContextMenu = (e: React.MouseEvent, file: FileEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
};

const closeContextMenu = () => {
    setContextMenu(null);
    setWhitespaceMenu(null);
};

const handleWhitespaceContextMenu = (e: React.MouseEvent) => {
    // Only show if clicking on the container itself, not on a file
    if (e.target === e.currentTarget) {
        e.preventDefault();
        setWhitespaceMenu({ x: e.clientX, y: e.clientY });
        setContextMenu(null);
    }
};

const handleSort = (col: 'name' | 'size' | 'modified') => {
    if (sortBy === col) setSortAsc(!sortAsc);
    else { setSortBy(col); setSortAsc(true); }
};

if (isLoading) {
    return (
    <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-surface-600 border-t-primary-400 rounded-full animate-spin" />
    </div>
    );
}

if (files.length === 0) {
    return (
    <div className="flex flex-col items-center justify-center h-full text-surface-500">
        <Folder className="w-16 h-16 mb-4 opacity-50" />
        <p>No files in this directory</p>
    </div>
    );
}

return (
    <div className="h-full flex flex-col" onClick={closeContextMenu}>
    <div className="flex items-center justify-between px-4 py-2 border-b border-surface-700/50">
        <span className="text-sm text-surface-400">{files.length} items</span>
        <div className="flex gap-1">
        <button onClick={() => setViewMode('grid')} className={clsx('p-1.5 rounded', viewMode === 'grid' ?
'bg-surface-700 text-surface-100' : 'text-surface-400 hover:text-surface-100')}>
            <Grid className="w-4 h-4" />
        </button>
        <button onClick={() => setViewMode('list')} className={clsx('p-1.5 rounded', viewMode === 'list' ?
'bg-surface-700 text-surface-100' : 'text-surface-400 hover:text-surface-100')}>
            <List className="w-4 h-4" />
        </button>
        </div>
    </div>

    <div className="flex-1 overflow-auto p-4" onContextMenu={handleWhitespaceContextMenu}>
        {viewMode === 'grid' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3" onContextMenu={handleWhitespaceContextMenu}>
            {sortedFiles.map(file => {
            const Icon = getFileIcon(file);
            const isSelected = selectedFile?.id === file.id;
            return (
                <div key={file.id} className={clsx('flex flex-col items-center p-3 rounded-lg cursor-pointer transition-colors', isSelected ? 'bg-primary-600/20 ring-1 ring-primary-500' : 'hover:bg-surface-700/50')} onClick={() => file.isDir ? onFileSelect(file) : onFileOpen(file)} onDoubleClick={() => file.isDir ? onFileOpen(file) : undefined} onContextMenu={(e) => handleContextMenu(e, file)}>
                <Icon className={clsx('w-10 h-10 mb-2', file.isDir ? 'text-primary-400' : 'text-surface-400')} />
                <span className="text-sm text-center truncate w-full text-surface-200">{file.name}</span>
                </div>
            );
            })}
        </div>
        ) : (
        <table className="w-full">
            <thead>
            <tr className="text-left text-xs text-surface-500 border-b border-surface-700/50">
                <th className="pb-2 cursor-pointer hover:text-surface-300" onClick={() => handleSort('name')}>Name</th>
                <th className="pb-2 cursor-pointer hover:text-surface-300 w-24" onClick={() => handleSort('size')}>Size</th>
                <th className="pb-2 cursor-pointer hover:text-surface-300 w-32" onClick={() => handleSort('modified')}>Modified</th>
            </tr>
            </thead>
            <tbody>
            {sortedFiles.map(file => {
                const Icon = getFileIcon(file);
                const isSelected = selectedFile?.id === file.id;
                return (
                <tr key={file.id} className={clsx('cursor-pointer transition-colors', isSelected ?
'bg-primary-600/20' : 'hover:bg-surface-700/50')} onClick={() => file.isDir ? onFileSelect(file) : onFileOpen(file)} onDoubleClick={() => file.isDir ? onFileOpen(file) : undefined} onContextMenu={(e) => handleContextMenu(e, file)}>
                    <td className="py-2 flex items-center gap-2">
                    <Icon className={clsx('w-4 h-4', file.isDir ? 'text-primary-400' : 'text-surface-400')} />
                    <span className="text-sm text-surface-200">{file.name}</span>
                    </td>
                    <td className="py-2 text-sm text-surface-500">{file.isDir ? '-' : formatSize(file.size)}</td>
                    <td className="py-2 text-sm text-surface-500">{file.modified || '-'}</td>
                </tr>
                );
            })}
            </tbody>
        </table>
        )}
    </div>

    {contextMenu && (
        <div className="fixed bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 z-50" style={{ left: contextMenu.x, top: contextMenu.y }}>
        <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onFileOpen(contextMenu.file); closeContextMenu(); }}>
            <ExternalLink className="w-4 h-4" /> Open
        </button>
        {contextMenu.file.isDir && onPinFolder && (
          <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onPinFolder(contextMenu.file.id, contextMenu.file.name); closeContextMenu(); }}>
            <Pin className="w-4 h-4" /> Pin folder
          </button>
        )}
        {contextMenu.file.isDir && onStartSession && (
          <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onStartSession(contextMenu.file.id); closeContextMenu(); }}>
            <Play className="w-4 h-4" /> Start new session
          </button>
        )}
        {contextMenu.file.isDir && onAddToRegistry && (
          <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onAddToRegistry(contextMenu.file.id); closeContextMenu(); }}>
            <FolderPlus className="w-4 h-4" /> Add to project registry
          </button>
        )}
        <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onRename(contextMenu.file); closeContextMenu(); }}>
            <Pencil className="w-4 h-4" /> Rename
        </button>
        <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-error-400 hover:bg-surface-700"
onClick={() => { onDelete(contextMenu.file); closeContextMenu(); }}>
            <Trash2 className="w-4 h-4" /> Delete
        </button>
        </div>
    )}

    {whitespaceMenu && (
        <div className="fixed bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 z-50" style={{ left: whitespaceMenu.x, top: whitespaceMenu.y }}>
        {onStartSession && (
          <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onStartSession(currentPath); closeContextMenu(); }}>
            <Play className="w-4 h-4" /> Start new session here
          </button>
        )}
        {onAddToRegistry && (
          <button className="flex items-center gap-2 w-full px-4 py-2 text-sm text-surface-200 hover:bg-surface-700"
onClick={() => { onAddToRegistry(currentPath); closeContextMenu(); }}>
            <FolderPlus className="w-4 h-4" /> Add to project registry
          </button>
        )}
        </div>
    )}
    </div>
);
}