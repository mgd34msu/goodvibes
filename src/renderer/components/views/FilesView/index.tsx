// ============================================================================
// FILES VIEW COMPONENT
// File manager view with split layout: tree navigation + file manager
// ============================================================================

import { useState, useEffect } from 'react';
import { Folder, RefreshCw } from 'lucide-react';
import { FileExplorer } from './FileExplorer';
import { FileViewer } from './FileViewer';
import { toast } from '../../../stores/toastStore';
import { createLogger } from '../../../../shared/logger';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useAppStore } from '../../../stores/appStore';

import { FileTree } from './FileTree';
import { SessionsPanel } from './SessionsPanel';

const logger = createLogger('FilesView');

interface TreeNode {
  id: string;
  name: string;
  isDir: boolean;
  size?: number;
  modified?: Date;
}

interface PinnedFolder {
  path: string;
  name: string;
}

const PINNED_FOLDERS_KEY = 'goodvibes-pinned-folders';

const loadPinnedFolders = (): PinnedFolder[] => {
  try {
    const stored = localStorage.getItem(PINNED_FOLDERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

const savePinnedFolders = (folders: PinnedFolder[]) => {
  localStorage.setItem(PINNED_FOLDERS_KEY, JSON.stringify(folders));
};

export default function FilesView() {
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [homeDir, setHomeDir] = useState<string>('');
  const [fileTree, setFileTree] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [showViewer, setShowViewer] = useState(false);
  const [pinnedFolders, setPinnedFolders] = useState<PinnedFolder[]>(loadPinnedFolders);
  const [sessionCount, setSessionCount] = useState(0);
  const [sessions, setSessions] = useState<any[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  const handlePinFolder = (path: string, name: string) => {
    const newPinned = [...pinnedFolders, { path, name }];
    setPinnedFolders(newPinned);
    savePinnedFolders(newPinned);
  };

  const handleUnpinFolder = (path: string) => {
    const newPinned = pinnedFolders.filter(f => f.path !== path);
    setPinnedFolders(newPinned);
    savePinnedFolders(newPinned);
  };

  // Load home directory and initial directory
  useEffect(() => {
    const init = async () => {
      const home = await window.goodvibes.getHomeDirectory() || '/';
      setHomeDir(home);
      loadDirectory();
    };
    init();
  }, []);

  const loadDirectory = async (path?: string) => {
    try {
      setIsLoading(true);
      // Get current project directory or home directory
      const targetPath = path || currentPath || await getInitialPath();
      const tree = await buildFileTree(targetPath);
      setFileTree(tree);
      setCurrentPath(targetPath);
      // Load sessions for new directory
      await loadSessions(targetPath);
    } catch (error) {
      logger.error('Failed to load directory:', error);
      toast.error('Failed to load directory');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSessions = async (path: string) => {
    try {
      const result = await window.goodvibes.getProjectSessions(path, 50);
      if (result && Array.isArray(result)) {
        setSessions(result);
        setSessionCount(result.length);
      } else {
        setSessions([]);
        setSessionCount(0);
      }
    } catch (error) {
      logger.error('Failed to load sessions:', error);
      setSessions([]);
      setSessionCount(0);
    }
  };

  const getInitialPath = async (): Promise<string> => {
    try {
      // Try to get recent projects first
      const recentProjects = await window.goodvibes.getRecentProjects();
      if (recentProjects && recentProjects.length > 0) {
        return recentProjects[0].path;
      }
    } catch (error) {
      logger.debug('No recent projects, using home directory');
    }
    // Fallback to home directory
    return await window.goodvibes.getHomeDirectory() || '/';
  };

  const buildFileTree = async (dirPath: string): Promise<any> => {
    try {
      const entries = await window.goodvibes.readDirectory(dirPath);

      return {
        id: dirPath,
        name: dirPath.split(/[\/]/).pop() || dirPath,
        isDir: true,
        children: entries.map((entry: any) => ({
          id: `${dirPath}/${entry.name}`,
          name: entry.name,
          isDir: entry.isDirectory,
          size: entry.size,
          modified: entry.modified,
        })),
      };
    } catch (error) {
      logger.error('Failed to build file tree:', error);
      throw error;
    }
  };

  const loadChildren = async (path: string): Promise<TreeNode[]> => {
    try {
      const entries = await window.goodvibes.readDirectory(path);
      return entries.map((entry: any) => ({
        id: `${path}/${entry.name}`,
        name: entry.name,
        isDir: entry.isDirectory,
        size: entry.size,
        modified: entry.modified,
      }));
    } catch (error) {
      logger.error('Failed to load children:', error);
      return [];
    }
  };

  const handleNavigate = async (path: string) => {
    await loadDirectory(path);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadDirectory(currentPath);
      toast.success('Directory refreshed');
    } catch (error) {
      logger.error('Failed to refresh:', error);
      toast.error('Failed to refresh directory');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleFileOpen = async (file: any) => {
    if (file.isDir) {
      await loadDirectory(file.id);
    } else {
      setSelectedFile(file);
      setShowViewer(true);
      setIsLoadingContent(true);
      try {
        const content = await window.goodvibes.readFileContent(file.id);
        setFileContent(content);
      } catch {
        setFileContent(null);
      } finally {
        setIsLoadingContent(false);
      }
    }
  };

  const handleFileSelect = (file: any) => {
    setSelectedFile(file);
  };

  const handleSaveFile = async (content: string) => {
    if (!selectedFile) return;
    try {
      await window.goodvibes.writeFileContent(selectedFile.id, content);
      setFileContent(content);
      toast.success('File saved');
    } catch (error) {
      logger.error('Failed to save file:', error);
      toast.error('Failed to save file');
      throw error;
    }
  };

  const handleCloseViewer = () => {
    setShowViewer(false);
    setFileContent(null);
  };

  const handleFileRename = async (file: any, newName: string) => {
    try {
      const parentPath = file.id.substring(0, file.id.lastIndexOf('/'));
      const newPath = `${parentPath}/${newName}`;
      await window.goodvibes.renameFile(file.id, newPath);
      await loadDirectory(currentPath);
      toast.success('File renamed');
    } catch (error) {
      logger.error('Failed to rename file:', error);
      toast.error('Failed to rename file');
    }
  };

  const handleFileDelete = async (file: any) => {
    try {
      if (file.isDir) {
        await window.goodvibes.deleteDirectory(file.id);
      } else {
        await window.goodvibes.deleteFile(file.id);
      }
      await loadDirectory(currentPath);
      toast.success('File deleted');
    } catch (error) {
      logger.error('Failed to delete file:', error);
      toast.error('Failed to delete file');
    }
  };



  const handleStartSession = async (path: string) => {
    try {
      const result = await createTerminal(path);
      if (result.error) {
        logger.error('Failed to start session:', result.error);
        toast.error('Failed to start Claude session');
      } else {
        toast.success(`Started Claude session in ${path}`);
        setCurrentView('terminal');
      }
    } catch (error) {
      logger.error('Failed to start session:', error);
      toast.error('Failed to start Claude session');
    }
  };

  const handleAddToRegistry = async (path: string) => {
    try {
      await window.goodvibes.projectRegister({ path });
      toast.success(`Added ${path} to project registry`);
    } catch (error) {
      logger.error('Failed to add to registry:', error);
      toast.error('Failed to add to project registry');
    }
  };

  if (isLoading && !fileTree) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-surface-400">Loading file manager...</div>
      </div>
    );
  }

  // Root the tree at user's home directory
  const rootPath = homeDir || '/';

  return (
    <div className="h-full flex flex-col bg-surface-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface-800 border-b border-surface-700">
        <div className="flex items-center gap-3">
          <Folder className="w-5 h-5 text-primary-400" />
          <h1 className="text-lg font-semibold text-surface-100">File Manager</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <span className="font-mono truncate max-w-md">{currentPath}</span>
            {sessionCount > 0 && (
              <>
                <span>·</span>
                <button
                  onClick={() => setShowSessions(true)}
                  className="text-primary-400 hover:text-primary-300 transition-colors hover:underline"
                  title="View sessions for this directory"
                >
                  {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                </button>
              </>
            )}
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-2 rounded-md hover:bg-surface-700 text-surface-400 hover:text-surface-100 transition-colors disabled:opacity-50"
            title="Refresh directory"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Split Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Folder Tree */}
        <div className="w-[280px] bg-surface-800 border-r border-surface-700 overflow-y-auto">
          <FileTree
            rootPath={rootPath}
            currentPath={currentPath}
            onNavigate={handleNavigate}
            onLoadChildren={loadChildren}
            pinnedFolders={pinnedFolders}
            onPinFolder={handlePinFolder}
            onUnpinFolder={handleUnpinFolder}
            onStartSession={handleStartSession}
            onAddToRegistry={handleAddToRegistry}
          />
        </div>

        {/* Right Panel: File Explorer + Viewer OR Sessions Panel */}
        <div className="flex-1 flex overflow-hidden">
          {showSessions ? (
            <SessionsPanel
              sessions={sessions}
              onClose={() => setShowSessions(false)}
            />
          ) : (
            <>
              <div className={showViewer ? 'w-1/2 border-r border-surface-700' : 'flex-1'}>
                <FileExplorer
                  files={fileTree?.children || []}
                  currentPath={currentPath}
                  onFileOpen={handleFileOpen}
                  onFileSelect={handleFileSelect}
                  onRename={(f) => handleFileRename(f, prompt('New name:', f.name) || f.name)}
                  onDelete={handleFileDelete}
                  onPinFolder={handlePinFolder}
                  selectedFile={selectedFile}
                  isLoading={isLoading}
                  onStartSession={handleStartSession}
                  onAddToRegistry={handleAddToRegistry}
                />
              </div>
              {showViewer && (
                <div className="w-1/2">
                  <FileViewer
                    file={selectedFile}
                    content={fileContent}
                    isLoading={isLoadingContent}
                    onClose={handleCloseViewer}
                    onSave={handleSaveFile}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
