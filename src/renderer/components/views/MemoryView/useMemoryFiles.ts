// ============================================================================
// MEMORY FILES HOOK
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { createLogger } from '../../../../shared/logger';
import { formatTimestamp } from '../../../../shared/dateUtils';
import { toast } from '../../../stores/toastStore';
import type { ClaudeMdFile } from './types';

const logger = createLogger('MemoryView');

interface UseMemoryFilesReturn {
  files: ClaudeMdFile[];
  selectedFile: ClaudeMdFile | null;
  content: string;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  hasUnsavedChanges: boolean;
  setSelectedFile: (file: ClaudeMdFile | null) => void;
  setContent: (content: string) => void;
  loadFiles: () => Promise<void>;
  handleSelectFile: (file: ClaudeMdFile) => Promise<boolean>;
  handleSave: () => Promise<void>;
}

export function useMemoryFiles(
  confirmDiscard: () => Promise<boolean>
): UseMemoryFilesReturn {
  const [files, setFiles] = useState<ClaudeMdFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<ClaudeMdFile | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Track if initial file selection has been done
  const hasSelectedInitialFile = useRef(false);

  // Load files - uses knowledge base as storage for CLAUDE.md content
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
      const userEntry = claudeMdEntries.find((e: { tags?: string }) =>
        e.tags?.includes('scope:user')
      );
      loadedFiles.push({
        path: 'user://CLAUDE.md',
        name: 'CLAUDE.md',
        scope: 'user',
        content: userEntry?.content || '',
        exists: !!userEntry,
        lastModified: userEntry?.updatedAt || undefined,
        entryId: userEntry?.id,
      });

      // Project scope file
      const projectEntry = claudeMdEntries.find((e: { tags?: string }) =>
        e.tags?.includes('scope:project')
      );
      loadedFiles.push({
        path: 'project://CLAUDE.md',
        name: 'CLAUDE.md',
        scope: 'project',
        content: projectEntry?.content || '',
        exists: !!projectEntry,
        lastModified: projectEntry?.updatedAt || undefined,
        entryId: projectEntry?.id,
      });

      // Local scope file
      const localEntry = claudeMdEntries.find((e: { tags?: string }) =>
        e.tags?.includes('scope:local')
      );
      loadedFiles.push({
        path: 'local://CLAUDE.local.md',
        name: 'CLAUDE.local.md',
        scope: 'local',
        content: localEntry?.content || '',
        exists: !!localEntry,
        lastModified: localEntry?.updatedAt || undefined,
        entryId: localEntry?.id,
      });

      setFiles(loadedFiles);

      // Select first file by default (only on initial load)
      const firstFile = loadedFiles[0];
      if (loadedFiles.length > 0 && !hasSelectedInitialFile.current && firstFile) {
        hasSelectedInitialFile.current = true;
        setSelectedFile(firstFile);
        setContent(firstFile.content);
        setOriginalContent(firstFile.content);
      }
    } catch (error) {
      logger.error('Failed to load CLAUDE.md files:', error);
      toast.error('Failed to load memory files');
      // Set default empty files on error
      const defaultFiles: ClaudeMdFile[] = [
        {
          path: 'user://CLAUDE.md',
          name: 'CLAUDE.md',
          scope: 'user',
          content: '',
          exists: false,
        },
        {
          path: 'project://CLAUDE.md',
          name: 'CLAUDE.md',
          scope: 'project',
          content: '',
          exists: false,
        },
        {
          path: 'local://CLAUDE.local.md',
          name: 'CLAUDE.local.md',
          scope: 'local',
          content: '',
          exists: false,
        },
      ];
      setFiles(defaultFiles);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Check for unsaved changes
  useEffect(() => {
    setHasUnsavedChanges(content !== originalContent);
  }, [content, originalContent]);

  const handleSelectFile = useCallback(
    async (file: ClaudeMdFile): Promise<boolean> => {
      if (hasUnsavedChanges) {
        const confirmed = await confirmDiscard();
        if (!confirmed) {
          return false;
        }
      }
      setSelectedFile(file);
      setContent(file.content);
      setOriginalContent(file.content);
      return true;
    },
    [hasUnsavedChanges, confirmDiscard]
  );

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;

    setSaving(true);
    try {
      const title = `CLAUDE.md (${selectedFile.scope})`;
      const tags = `scope:${selectedFile.scope}`;

      if (selectedFile.entryId) {
        // Update existing entry using cached ID - no fetch needed
        await window.goodvibes.updateKnowledgeEntry(
          selectedFile.entryId,
          title,
          content,
          'claude-md',
          tags
        );
      } else {
        // Create new entry
        const newEntry = await window.goodvibes.createKnowledgeEntry(
          title,
          content,
          'claude-md',
          tags
        );
        // Update the file with the new entry ID
        if (newEntry?.id) {
          setFiles((prev) =>
            prev.map((f) =>
              f.path === selectedFile.path ? { ...f, entryId: newEntry.id } : f
            )
          );
        }
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
      toast.success('Memory file saved');
    } catch (error) {
      logger.error('Failed to save CLAUDE.md:', error);
      toast.error('Failed to save memory file');
    } finally {
      setSaving(false);
    }
  }, [selectedFile, content]);

  return {
    files,
    selectedFile,
    content,
    originalContent,
    loading,
    saving,
    hasUnsavedChanges,
    setSelectedFile,
    setContent,
    loadFiles,
    handleSelectFile,
    handleSave,
  };
}
