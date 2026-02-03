// ============================================================================
// FILE VIEWER COMPONENT
// File viewer/editor with syntax highlighting and edit mode
// ============================================================================

import { useState, useEffect, useMemo } from 'react';
import { X, Edit, Save, FileText, Image as ImageIcon } from 'lucide-react';
import { clsx } from 'clsx';

interface FileViewerProps {
  file: { id: string; name: string; isDir: boolean } | null;
  content: string | null;
  isLoading: boolean;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
}

type FileType = 'text' | 'image' | 'binary';

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase();
  const textExts = [
    'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx',
    'css', 'html', 'xml', 'yaml', 'yml', 'sh',
    'py', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'java', 'rb', 'php', 'sql', 'env', 'gitignore',
    'log', 'conf', 'config', 'toml', 'ini'
  ];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];
  if (ext && textExts.includes(ext)) return 'text';
  if (ext && imageExts.includes(ext)) return 'image';
  return 'binary';
}

export function FileViewer({ file, content, isLoading, onClose, onSave }: FileViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    if (content !== null) {
      setEditContent(content);
      setHasUnsavedChanges(false);
    }
  }, [content]);

  useEffect(() => {
    setIsEditing(false);
    setHasUnsavedChanges(false);
  }, [file?.id]);

  const fileType = useMemo<FileType>(() => {
    return file ? detectFileType(file.name) : 'binary';
  }, [file?.name]);

  const handleSave = async () => {
    if (!hasUnsavedChanges) return;
    try {
      setIsSaving(true);
      await onSave(editContent);
      setHasUnsavedChanges(false);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save file:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    setHasUnsavedChanges(e.target.value !== content);
  };

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-900 text-surface-400">
        <div className="text-center">
          <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p>Select a file to view</p>
        </div>
      </div>
    );
  }

  if (file.isDir) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-900 text-surface-400">
        <div className="text-center">
          <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p>Cannot view directory</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-900">
      <div className="flex items-center justify-between px-4 py-3 bg-surface-800 border-b border-surface-700">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="w-4 h-4 text-surface-400 flex-shrink-0" />
          <h2 className="text-sm font-medium text-surface-100 truncate">
            {file.name}
            {hasUnsavedChanges && <span className="ml-2 text-primary-400" title="Unsaved changes">•</span>}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {fileType === 'text' && (
            <>
              {isEditing ? (
                <button onClick={handleSave} disabled={!hasUnsavedChanges || isSaving} className="px-3 py-1.5 rounded-md bg-primary-600 hover:bg-primary-700 disabled:bg-surface-700 disabled:text-surface-400 text-white text-sm font-medium transition-colors flex items-center gap-1.5">
                  <Save className="w-3.5 h-3.5" />
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              ) : (
                <button onClick={() => setIsEditing(true)} className="px-3 py-1.5 rounded-md bg-surface-700 hover:bg-surface-600 text-surface-100 text-sm font-medium transition-colors flex items-center gap-1.5">
                  <Edit className="w-3.5 h-3.5" />
                  Edit
                </button>
              )}
            </>
          )}
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface-700 text-surface-400 hover:text-surface-100 transition-colors" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-surface-600 border-t-primary-400 rounded-full animate-spin" />
          </div>
        ) : fileType === 'binary' ? (
          <div className="flex items-center justify-center h-full text-surface-400">
            <div className="text-center">
              <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p>Binary file - cannot preview</p>
            </div>
          </div>
        ) : fileType === 'image' ? (
          <div className="flex items-center justify-center h-full p-8">
            {content ? (
              <img src={"file://" + file.id} alt={file.name} className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />
            ) : (
              <div className="text-center text-surface-400">
                <ImageIcon className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p>Failed to load image</p>
              </div>
            )}
          </div>
        ) : isEditing ? (
          <textarea value={editContent} onChange={handleContentChange} className="w-full h-full p-4 bg-surface-900 text-surface-100 font-mono text-sm resize-none focus:outline-none" spellCheck={false} />
        ) : (
          <pre className="h-full p-4 m-0 overflow-auto">
            <code className={clsx('block font-mono text-sm leading-relaxed whitespace-pre-wrap', 'text-surface-200')}>
              {content || ''}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}
