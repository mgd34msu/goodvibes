// ============================================================================
// MEMORY VIEW - CLAUDE.md Editor and Context Management
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Brain,
  Save,
  RefreshCw,
  FileText,
  Edit2,
  Eye,
  Copy,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
} from 'lucide-react';
import { createLogger } from '../../../shared/logger';
import { formatTimestamp } from '../../../shared/dateUtils';

const logger = createLogger('MemoryView');

// ============================================================================
// TYPES
// ============================================================================

interface ClaudeMdFile {
  path: string;
  name: string;
  scope: 'user' | 'project' | 'local';
  content: string;
  exists: boolean;
  lastModified?: string;
}


interface MemoryTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  variables: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TEMPLATES: MemoryTemplate[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Instructions for code review sessions',
    content: `# Code Review Agent

You are a code review specialist. Your role is to:
- Review code changes for bugs, security issues, and best practices
- Provide constructive feedback with specific suggestions
- Focus on code quality, maintainability, and performance
- Be thorough but respectful in your reviews

## Project Context
{{project_description}}

## Review Guidelines
- Always explain the "why" behind your suggestions
- Prioritize issues by severity (critical, major, minor)
- Include code examples when suggesting improvements
`,
    variables: ['project_description'],
  },
  {
    id: 'backend',
    name: 'Backend Developer',
    description: 'Instructions for backend development',
    content: `# Backend Developer

You are a backend development specialist. Your expertise includes:
- API design and implementation (REST, GraphQL)
- Database schema design and optimization
- Authentication and authorization
- Performance optimization
- Testing and debugging

## Tech Stack
{{tech_stack}}

## Coding Standards
- Follow existing project patterns
- Write comprehensive tests for new code
- Document all public APIs
- Handle errors gracefully
`,
    variables: ['tech_stack'],
  },
  {
    id: 'frontend',
    name: 'Frontend Developer',
    description: 'Instructions for frontend development',
    content: `# Frontend Developer

You are a frontend development specialist. Your expertise includes:
- Component architecture and state management
- CSS and responsive design
- Accessibility (WCAG compliance)
- Performance optimization
- User experience

## Framework
{{framework}}

## Guidelines
- Use semantic HTML
- Follow component composition patterns
- Implement proper error boundaries
- Optimize for performance
`,
    variables: ['framework'],
  },
];

// ============================================================================
// MARKDOWN EDITOR COMPONENT
// ============================================================================

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

function MarkdownEditor({ value, onChange, placeholder, readOnly }: MarkdownEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col h-full border border-surface-700 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-800 border-b border-surface-700">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreview(false)}
            className={`px-2 py-1 text-sm rounded ${
              !showPreview
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            <Edit2 className="w-4 h-4 inline mr-1" />
            Edit
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className={`px-2 py-1 text-sm rounded ${
              showPreview
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            <Eye className="w-4 h-4 inline mr-1" />
            Preview
          </button>
        </div>

        <div className="text-xs text-surface-500">
          {value.length} characters
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {showPreview ? (
          <div className="p-4 prose prose-invert prose-sm max-w-none">
            <pre className="whitespace-pre-wrap text-surface-200 font-sans">
              {value || 'Nothing to preview'}
            </pre>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            readOnly={readOnly}
            className="w-full h-full p-4 bg-transparent text-surface-100 font-mono text-sm resize-none focus:outline-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// FILE TREE COMPONENT
// ============================================================================

interface FileTreeProps {
  files: ClaudeMdFile[];
  selectedPath: string | null;
  onSelect: (file: ClaudeMdFile) => void;
  onRefresh: () => void;
}

function FileTree({ files, selectedPath, onSelect, onRefresh }: FileTreeProps) {
  const groupedFiles = {
    user: files.filter((f) => f.scope === 'user'),
    project: files.filter((f) => f.scope === 'project'),
    local: files.filter((f) => f.scope === 'local'),
  };

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
            {!file.exists && (
              <span className="text-xs text-surface-500">(create)</span>
            )}
          </button>
        ))}
      </div>

      {/* Project scope */}
      {groupedFiles.project.length > 0 && (
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
              {!file.exists && (
                <span className="text-xs text-surface-500">(create)</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Local scope */}
      {groupedFiles.local.length > 0 && (
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
              {!file.exists && (
                <span className="text-xs text-surface-500">(create)</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TEMPLATE SELECTOR COMPONENT
// ============================================================================

interface TemplateSelectorProps {
  onSelect: (template: MemoryTemplate) => void;
}

function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-surface-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-800 text-surface-200 hover:bg-surface-700 transition-colors"
      >
        <span className="font-medium">Insert Template</span>
        {expanded ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
      </button>

      {expanded && (
        <div className="p-4 space-y-3 bg-surface-900">
          {DEFAULT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              onClick={() => {
                onSelect(template);
                setExpanded(false);
              }}
              className="w-full text-left p-3 bg-surface-800 rounded-lg hover:bg-surface-700 transition-colors"
            >
              <div className="font-medium text-surface-200">{template.name}</div>
              <div className="text-sm text-surface-400 mt-1">{template.description}</div>
              {template.variables.length > 0 && (
                <div className="flex gap-2 mt-2">
                  {template.variables.map((v) => (
                    <span
                      key={v}
                      className="text-xs px-2 py-0.5 bg-accent-purple/20 text-accent-purple rounded"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MAIN MEMORY VIEW
// ============================================================================

export default function MemoryView() {
  const [files, setFiles] = useState<ClaudeMdFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<ClaudeMdFile | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Load files - uses knowledge base as storage for CLAUDE.md content
  // Each file scope (user/project/local) is stored as a knowledge entry with a special category
  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      // Get all knowledge entries with 'claude-md' category
      const entries = await window.goodvibes.getAllKnowledgeEntries();
      const claudeMdEntries = entries.filter(
        (e: { category?: string }) => e.category === 'claude-md'
      );

      // Map entries to ClaudeMdFile format
      const loadedFiles: ClaudeMdFile[] = [];

      // User scope file
      const userEntry = claudeMdEntries.find(
        (e: { tags?: string }) => e.tags?.includes('scope:user')
      );
      loadedFiles.push({
        path: 'user://CLAUDE.md',
        name: 'CLAUDE.md',
        scope: 'user',
        content: userEntry?.content || '',
        exists: !!userEntry,
        lastModified: userEntry?.updatedAt || undefined,
      });

      // Project scope file
      const projectEntry = claudeMdEntries.find(
        (e: { tags?: string }) => e.tags?.includes('scope:project')
      );
      loadedFiles.push({
        path: 'project://CLAUDE.md',
        name: 'CLAUDE.md',
        scope: 'project',
        content: projectEntry?.content || '',
        exists: !!projectEntry,
        lastModified: projectEntry?.updatedAt || undefined,
      });

      // Local scope file
      const localEntry = claudeMdEntries.find(
        (e: { tags?: string }) => e.tags?.includes('scope:local')
      );
      loadedFiles.push({
        path: 'local://CLAUDE.local.md',
        name: 'CLAUDE.local.md',
        scope: 'local',
        content: localEntry?.content || '',
        exists: !!localEntry,
        lastModified: localEntry?.updatedAt || undefined,
      });

      setFiles(loadedFiles);

      // Select first file by default
      const firstFile = loadedFiles[0];
      if (loadedFiles.length > 0 && !selectedFile && firstFile) {
        handleSelectFile(firstFile);
      }
    } catch (error) {
      logger.error('Failed to load CLAUDE.md files:', error);
      // Set default empty files on error
      const defaultFiles: ClaudeMdFile[] = [
        { path: 'user://CLAUDE.md', name: 'CLAUDE.md', scope: 'user', content: '', exists: false },
        { path: 'project://CLAUDE.md', name: 'CLAUDE.md', scope: 'project', content: '', exists: false },
        { path: 'local://CLAUDE.local.md', name: 'CLAUDE.local.md', scope: 'local', content: '', exists: false },
      ];
      setFiles(defaultFiles);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Check for unsaved changes
  useEffect(() => {
    setHasUnsavedChanges(content !== originalContent);
  }, [content, originalContent]);

  const handleSelectFile = (file: ClaudeMdFile) => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Discard them?')) {
        return;
      }
    }
    setSelectedFile(file);
    setContent(file.content);
    setOriginalContent(file.content);
  };

  const handleSave = async () => {
    if (!selectedFile) return;

    setSaving(true);
    try {
      // Get all entries to find existing one
      const entries = await window.goodvibes.getAllKnowledgeEntries();
      const existingEntry = entries.find(
        (e: { category?: string; tags?: string }) =>
          e.category === 'claude-md' && e.tags?.includes(`scope:${selectedFile.scope}`)
      );

      const title = `CLAUDE.md (${selectedFile.scope})`;
      const tags = `scope:${selectedFile.scope}`;

      if (existingEntry?.id) {
        // Update existing entry
        await window.goodvibes.updateKnowledgeEntry(
          existingEntry.id,
          title,
          content,
          'claude-md',
          tags
        );
      } else {
        // Create new entry
        await window.goodvibes.createKnowledgeEntry(
          title,
          content,
          'claude-md',
          tags
        );
      }

      // Update state
      setOriginalContent(content);
      setHasUnsavedChanges(false);

      // Update file in list
      setFiles((prev) =>
        prev.map((f) =>
          f.path === selectedFile.path
            ? { ...f, content, exists: true, lastModified: formatTimestamp() }
            : f
        )
      );
    } catch (error) {
      logger.error('Failed to save CLAUDE.md:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsertTemplate = (template: MemoryTemplate) => {
    setContent((prev) => {
      const insertion = prev ? `\n\n${template.content}` : template.content;
      return prev + insertion;
    });
  };

  return (
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Sidebar */}
        <div className="w-64 flex-shrink-0 border-r border-surface-800 p-4 overflow-y-auto">
          <FileTree
            files={files}
            selectedPath={selectedFile?.path || null}
            onSelect={handleSelectFile}
            onRefresh={loadFiles}
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
                  <span className="font-medium text-surface-200">{selectedFile.name}</span>
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
  );
}
