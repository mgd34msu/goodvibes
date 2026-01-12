// ============================================================================
// GIT TAGS COMPONENT - Tag management
// ============================================================================

import { clsx } from 'clsx';
import type { GitTag, ExpandedSections } from './types';

interface GitTagsProps {
  tags: GitTag[];
  expandedSections: { tags: boolean };
  showTagModal: boolean;
  newTagName: string;
  newTagMessage: string;
  newTagCommit: string;
  toggleSection: (section: keyof ExpandedSections) => void;
  onTagNameChange: (name: string) => void;
  onTagMessageChange: (message: string) => void;
  onTagCommitChange: (commit: string) => void;
  onShowTagModal: () => void;
  onCloseTagModal: () => void;
  onCreateTag: () => void;
  onDeleteTag: (name: string) => void;
}

export function GitTags({
  tags,
  expandedSections,
  showTagModal,
  newTagName,
  newTagMessage,
  newTagCommit,
  toggleSection,
  onTagNameChange,
  onTagMessageChange,
  onTagCommitChange,
  onShowTagModal,
  onCloseTagModal,
  onCreateTag,
  onDeleteTag,
}: GitTagsProps) {
  return (
    <>
      {/* Tags Section */}
      <div className="border border-surface-700 rounded overflow-hidden">
        <button
          onClick={() => toggleSection('tags')}
          className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg
              className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.tags && 'rotate-90')}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-xs font-medium text-surface-300">Tags</span>
            {tags.length > 0 && (
              <span className="text-xs text-surface-500">({tags.length})</span>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onShowTagModal(); }}
            className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
            title="Create tag"
          >
            + Tag
          </button>
        </button>
        {expandedSections.tags && (
          <div className="max-h-32 overflow-y-auto">
            {tags.length === 0 ? (
              <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                No tags
              </div>
            ) : (
              tags.map((tag) => (
                <div
                  key={tag.name}
                  className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                >
                  <span className={clsx(
                    'w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold flex-shrink-0',
                    tag.isAnnotated ? 'text-warning-400 bg-warning-400/20' : 'text-surface-400 bg-surface-400/20'
                  )}>
                    {tag.isAnnotated ? 'T' : 't'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-surface-200 font-mono truncate">{tag.name}</div>
                    {tag.message && (
                      <div className="text-[10px] text-surface-500 truncate">{tag.message}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onDeleteTag(tag.name)}
                      className="p-1 rounded hover:bg-error-500/20 text-error-400"
                      title="Delete tag"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Tag Modal */}
      {showTagModal && (
        <TagModal
          newTagName={newTagName}
          newTagMessage={newTagMessage}
          newTagCommit={newTagCommit}
          onTagNameChange={onTagNameChange}
          onTagMessageChange={onTagMessageChange}
          onTagCommitChange={onTagCommitChange}
          onCreateTag={onCreateTag}
          onClose={onCloseTagModal}
        />
      )}
    </>
  );
}

// ============================================================================
// TAG MODAL
// ============================================================================

interface TagModalProps {
  newTagName: string;
  newTagMessage: string;
  newTagCommit: string;
  onTagNameChange: (name: string) => void;
  onTagMessageChange: (message: string) => void;
  onTagCommitChange: (commit: string) => void;
  onCreateTag: () => void;
  onClose: () => void;
}

function TagModal({
  newTagName,
  newTagMessage,
  newTagCommit,
  onTagNameChange,
  onTagMessageChange,
  onTagCommitChange,
  onCreateTag,
  onClose,
}: TagModalProps) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
          <svg className="w-5 h-5 text-warning-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <span className="font-medium text-surface-100">Create Tag</span>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-surface-400 mb-1">Tag name</label>
            <input
              type="text"
              value={newTagName}
              onChange={(e) => onTagNameChange(e.target.value)}
              placeholder="v1.0.0"
              className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-surface-400 mb-1">Message (optional, creates annotated tag)</label>
            <input
              type="text"
              value={newTagMessage}
              onChange={(e) => onTagMessageChange(e.target.value)}
              placeholder="Release 1.0.0"
              className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-surface-400 mb-1">Commit (optional, defaults to HEAD)</label>
            <input
              type="text"
              value={newTagCommit}
              onChange={(e) => onTagCommitChange(e.target.value)}
              placeholder="HEAD"
              className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500 font-mono"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onCreateTag}
            disabled={!newTagName.trim()}
            className="px-4 py-2 text-sm bg-warning-500 hover:bg-warning-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
          >
            Create Tag
          </button>
        </div>
      </div>
    </div>
  );
}
