// ============================================================================
// MEMORY VIEW - CLAUDE.md Editor and Context Management
// ============================================================================

import { useState, useMemo } from 'react';
import { useConfirm } from '../../overlays/ConfirmModal';
import {
  Brain,
  Save,
  FileText,
  Copy,
  Check,
  AlertCircle,
  User,
  FolderOpen,
} from 'lucide-react';
import { FileTree } from './FileTree';
import { TemplateSelector } from './TemplateSelector';
import { MarkdownEditor } from './MarkdownEditor';
import { useMemoryFiles } from './useMemoryFiles';
import ProjectSelector from '../../shared/ProjectSelector';
import type { MemoryTemplate, ClaudeMdFile } from './types';

// ============================================================================
// TYPES
// ============================================================================

type ScopeFilter = 'all' | 'user' | 'project';

// ============================================================================
// MAIN MEMORY VIEW
// ============================================================================

export default function MemoryView() {
  const [copied, setCopied] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  // Project path stored for future use when loading project-specific CLAUDE.md files
  const [_selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);

  // Confirm dialog for unsaved changes
  const { confirm: confirmDiscard, ConfirmDialog } = useConfirm({
    title: 'Unsaved Changes',
    message: 'You have unsaved changes. Discard them?',
    confirmText: 'Discard',
    cancelText: 'Cancel',
    variant: 'warning',
  });

  const {
    files,
    selectedFile,
    content,
    loading,
    saving,
    hasUnsavedChanges,
    setContent,
    loadFiles,
    handleSelectFile,
    handleSave,
  } = useMemoryFiles(confirmDiscard);

  // Filter files based on scope selection
  const filteredFiles = useMemo((): ClaudeMdFile[] => {
    if (scopeFilter === 'all') {
      return files;
    }
    if (scopeFilter === 'user') {
      return files.filter((f) => f.scope === 'user');
    }
    // 'project' scope shows both project and local files
    return files.filter((f) => f.scope === 'project' || f.scope === 'local');
  }, [files, scopeFilter]);

  const handleProjectChange = (projectId: number | null, projectPath: string | null): void => {
    setSelectedProjectId(projectId);
    setSelectedProjectPath(projectPath);
    // Future: Reload CLAUDE.md files for the selected project
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsertTemplate = (template: MemoryTemplate) => {
    const insertion = content ? `\n\n${template.content}` : template.content;
    setContent(content + insertion);
  };

  return (
    <>
      <ConfirmDialog />
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Brain className="w-6 h-6 text-accent-purple" />
              <div>
                <h1 className="text-xl font-semibold text-surface-100">Memory</h1>
                <p className="text-sm text-surface-400">
                  CLAUDE.md editor and context management
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {hasUnsavedChanges && (
                <span className="text-xs text-yellow-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Unsaved changes
                </span>
              )}
              <button
                onClick={handleCopy}
                className="p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded-lg transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={handleSave}
                disabled={!hasUnsavedChanges || saving}
                className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                  hasUnsavedChanges
                    ? 'bg-accent-purple text-white hover:bg-accent-purple/80'
                    : 'bg-surface-700 text-surface-500 cursor-not-allowed'
                }`}
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Scope Filter */}
          <div className="flex items-center gap-4 mt-4">
            <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-1">
              <button
                onClick={() => setScopeFilter('all')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
                  scopeFilter === 'all'
                    ? 'bg-accent-purple text-white'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setScopeFilter('user')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
                  scopeFilter === 'user'
                    ? 'bg-accent-purple text-white'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                User
              </button>
              <button
                onClick={() => setScopeFilter('project')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
                  scopeFilter === 'project'
                    ? 'bg-accent-purple text-white'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
                }`}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Project
              </button>
            </div>

            {/* Project Selector - shown when project scope is selected */}
            {scopeFilter === 'project' && (
              <div className="flex-1 max-w-xs">
                <ProjectSelector
                  scope="project"
                  selectedProjectId={selectedProjectId}
                  onProjectChange={handleProjectChange}
                />
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {/* Sidebar */}
          <div className="w-64 flex-shrink-0 border-r border-surface-800 p-4 overflow-y-auto">
            <FileTree
              files={filteredFiles}
              selectedPath={selectedFile?.path || null}
              onSelect={handleSelectFile}
              onRefresh={loadFiles}
              scopeFilter={scopeFilter}
            />

            <div className="mt-6">
              <TemplateSelector onSelect={handleInsertTemplate} />
            </div>

            {/* Info */}
            <div className="mt-6 p-3 bg-surface-900 rounded-lg border border-surface-700">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-surface-400 mt-0.5" />
                <div className="text-xs text-surface-400">
                  <p className="font-medium text-surface-300 mb-1">About CLAUDE.md</p>
                  <p>
                    CLAUDE.md files provide persistent instructions for Claude. User-level
                    files apply globally, while project-level files apply to specific
                    projects.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 p-4 overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
              </div>
            ) : selectedFile ? (
              <div className="h-full flex flex-col">
                {/* File info */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-surface-400" />
                    <span className="font-medium text-surface-200">
                      {selectedFile.name}
                    </span>
                    <span className="text-xs text-surface-500">
                      ({selectedFile.scope})
                    </span>
                  </div>
                  {selectedFile.lastModified && (
                    <span className="text-xs text-surface-500">
                      Modified: {new Date(selectedFile.lastModified).toLocaleString()}
                    </span>
                  )}
                </div>

                {/* Editor */}
                <div className="flex-1 overflow-hidden">
                  <MarkdownEditor
                    value={content}
                    onChange={setContent}
                    placeholder="Enter your CLAUDE.md content here..."
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-surface-500">
                <p>Select a file to edit</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
