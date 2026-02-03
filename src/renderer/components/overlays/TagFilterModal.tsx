// ============================================================================
// TAG FILTER MODAL - Visual tag filter builder with boolean logic
// ============================================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

import { Search, X, ChevronDown, ChevronRight } from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { TagChip } from '../common/TagChip';
import type { Tag, TagFilterExpression } from '../../../shared/types/tag-types';
import { createLogger } from '../../../shared/logger';
import { toast } from '../../stores/toastStore';

const logger = createLogger('TagFilterModal');

// ============================================================================
// TYPES
// ============================================================================

export interface TagFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (expression: TagFilterExpression | null) => void;
  initialExpression?: TagFilterExpression | null;
}

type FilterLogic = 'AND' | 'OR';

// ============================================================================
// COMPONENT
// ============================================================================

export function TagFilterModal({
  isOpen,
  onClose,
  onApply,
  initialExpression = null,
}: TagFilterModalProps) {
  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [filterLogic, setFilterLogic] = useState<FilterLogic>('AND');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [pinnedTags, setPinnedTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedExpression, setAdvancedExpression] = useState('');

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ============================================================================
  // LOAD TAGS
  // ============================================================================

  const loadTags = useCallback(async () => {
    try {
      setLoading(true);
      const [allTagsResult, pinnedTagsResult] = await Promise.all([
        window.goodvibes.getAllTags(),
        window.goodvibes.getPinnedTags(),
      ]);

      if (allTagsResult.success) {
        // Sort by usage count descending
        const sorted = [...allTagsResult.data].sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
        setAllTags(sorted);
      } else {
        logger.error('Failed to load tags', { error: allTagsResult.error });
        toast.error('Failed to load tags');
      }

      if (pinnedTagsResult.success) {
        setPinnedTags(pinnedTagsResult.data);
      } else {
        logger.error('Failed to load pinned tags', { error: pinnedTagsResult.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to load tag data', { error: errorMessage });
      toast.error('Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadTags();
    }
  }, [isOpen, loadTags]);

  // ============================================================================
  // INITIALIZE FROM EXPRESSION
  // ============================================================================

  useEffect(() => {
    if (isOpen && initialExpression) {
      // Parse initial expression to extract tag IDs and logic
      const extractedIds = extractTagIdsFromExpression(initialExpression);
      setSelectedTagIds(extractedIds);

      // Determine logic type (simple heuristic)
      if (initialExpression.type === 'or') {
        setFilterLogic('OR');
      } else {
        setFilterLogic('AND');
      }

      // Set advanced expression if complex
      if (isComplexExpression(initialExpression)) {
        setShowAdvanced(true);
        setAdvancedExpression(expressionToString(initialExpression));
      }
    } else if (isOpen) {
      // Reset state when opening fresh
      setSelectedTagIds([]);
      setFilterLogic('AND');
      setSearchQuery('');
      setShowAdvanced(false);
      setAdvancedExpression('');
    }
  }, [isOpen, initialExpression]);

  // ============================================================================
  // APPLY/CANCEL HANDLERS
  // ============================================================================

  const handleApply = useCallback(() => {
    if (selectedTagIds.length === 0) {
      // No filter - clear filter
      onApply(null);
      onClose();
      return;
    }

    // Build expression from selected tags
    const expression = buildExpression(selectedTagIds, filterLogic);
    onApply(expression);
    onClose();
  }, [selectedTagIds, filterLogic, onApply, onClose]);

  // ============================================================================
  // KEYBOARD HANDLERS
  // ============================================================================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleApply();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, handleApply]);

  // Auto-focus search input when modal opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // ============================================================================
  // TAG SELECTION HANDLERS
  // ============================================================================

  const handleToggleTag = (tagId: number) => {
    setSelectedTagIds(prev => {
      if (prev.includes(tagId)) {
        return prev.filter(id => id !== tagId);
      } else {
        return [...prev, tagId];
      }
    });
  };

  const handleClearAll = () => {
    setSelectedTagIds([]);
  };

  const handleCancel = () => {
    onClose();
  };

  // ============================================================================
  // FILTERING
  // ============================================================================

  const filteredTags = allTags.filter(tag => {
    if (!searchQuery) return true;
    return tag.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const selectedTags = allTags.filter(tag => selectedTagIds.includes(tag.id));

  // ============================================================================
  // RENDER
  // ============================================================================

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-backdrop-premium" onClick={handleCancel}>
      <FocusTrap>
        <ErrorBoundary
          fallback={
            <div className="modal-panel-premium modal-md">
              <div className="p-8 text-center">
                <p className="text-slate-400">Tag Filter Modal encountered an error</p>
                <button onClick={handleCancel} className="btn btn-secondary mt-4">
                  Close
                </button>
              </div>
            </div>
          }
          onReset={handleCancel}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tag-filter-modal-title"
            className="modal-panel-premium modal-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-surface-700">
              <h2
                id="tag-filter-modal-title"
                className="text-xl font-semibold text-slate-100"
              >
                Filter by Tags
              </h2>
              <button
                onClick={handleCancel}
                className="text-surface-400 hover:text-surface-200 transition-colors p-1 rounded hover:bg-surface-700"
                aria-label="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 space-y-6 max-h-[600px] overflow-y-auto">
              {/* Search Input */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search tags..."
                  aria-label="Search tags"
                  className="w-full pl-10 pr-4 py-2 bg-surface-700 border border-surface-600 rounded focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 text-surface-100 placeholder-surface-400 transition-colors"
                />
              </div>

              {/* Active Filters */}
              {selectedTags.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-surface-300">Active Filters:</h3>
                    <button
                      onClick={handleClearAll}
                      className="text-xs text-surface-400 hover:text-surface-200 transition-colors"
                      aria-label="Clear all selected filters"
                    >
                      Clear All
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedTags.map((tag, index) => (
                      <React.Fragment key={tag.id}>
                        <TagChip
                          tag={tag}
                          selected
                          selectable
                          onClick={() => handleToggleTag(tag.id)}
                          size="sm"
                        />
                        {index < selectedTags.length - 1 && (
                          <div className="relative inline-block">
                            <select
                              value={filterLogic}
                              onChange={(e) => setFilterLogic(e.target.value as FilterLogic)}
                              className="appearance-none bg-surface-700 border border-surface-600 rounded px-2 py-1 text-xs text-surface-300 pr-6 cursor-pointer hover:bg-surface-600 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/50"
                              aria-label="Filter logic operator"
                            >
                              <option value="AND">AND</option>
                              <option value="OR">OR</option>
                            </select>
                            <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-400 pointer-events-none" />
                          </div>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* Pinned Tags */}
              {!loading && pinnedTags.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-surface-300 mb-3">Pinned Tags:</h3>
                  <div className="flex flex-wrap gap-2">
                    {pinnedTags.map(tag => (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        selectable
                        selected={selectedTagIds.includes(tag.id)}
                        onClick={() => handleToggleTag(tag.id)}
                        size="sm"
                        showCount
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* All Tags */}
              <div>
                <h3 className="text-sm font-medium text-surface-300 mb-3">All Tags:</h3>
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-sm text-surface-400">Loading tags...</div>
                  </div>
                ) : filteredTags.length > 0 ? (
                  <div className="flex flex-wrap gap-2 max-h-[300px] overflow-y-auto p-2 bg-surface-800/50 rounded border border-surface-700">
                    {filteredTags.map(tag => (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        selectable
                        selected={selectedTagIds.includes(tag.id)}
                        onClick={() => handleToggleTag(tag.id)}
                        size="sm"
                        showCount
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-surface-400 text-center py-8">
                    No tags found matching "{searchQuery}"
                  </div>
                )}
              </div>

              {/* Advanced Expression */}
              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm text-surface-400 hover:text-surface-200 transition-colors"
                >
                  {showAdvanced ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  <span>Advanced Expression</span>
                </button>
                {showAdvanced && (
                  <div className="mt-3">
                    <input
                      type="text"
                      value={advancedExpression || buildExpressionString(selectedTagIds, filterLogic, allTags)}
                      onChange={(e) => setAdvancedExpression(e.target.value)}
                      placeholder="(#feature OR #bugfix) AND NOT #wip"
                      className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded font-mono text-sm text-surface-200 placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-colors"
                      disabled
                    />
                    <p className="text-xs text-surface-500 mt-2">
                      Advanced expression editing coming soon. Use the tag selector above to build your filter.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 p-6 border-t border-surface-700">
              <button
                onClick={handleCancel}
                className="btn btn-secondary min-w-[100px]"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                className="btn btn-primary min-w-[100px]"
              >
                Apply Filter
              </button>
            </div>
          </div>
        </ErrorBoundary>
      </FocusTrap>
    </div>,
    document.body
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build a TagFilterExpression from selected tag IDs and logic
 */
function buildExpression(
  tagIds: number[],
  logic: FilterLogic
): TagFilterExpression {
  if (tagIds.length === 0) {
    throw new Error('Cannot build expression with no tags');
  }

  if (tagIds.length === 1) {
    return {
      type: 'tag',
      tagId: tagIds[0],
    };
  }

  return {
    type: logic.toLowerCase() as 'and' | 'or',
    children: tagIds.map(tagId => ({
      type: 'tag',
      tagId,
    })),
  };
}

/**
 * Extract tag IDs from a TagFilterExpression (recursive)
 */
function extractTagIdsFromExpression(expression: TagFilterExpression): number[] {
  if (expression.type === 'tag' && expression.tagId !== undefined) {
    return [expression.tagId];
  }

  if (expression.children) {
    return expression.children.flatMap(child => extractTagIdsFromExpression(child));
  }

  return [];
}

/**
 * Check if expression is complex (has NOT or nested logic)
 */
function isComplexExpression(expression: TagFilterExpression): boolean {
  if (expression.type === 'not') {
    return true;
  }

  if (expression.children) {
    return expression.children.some(child => child.type !== 'tag');
  }

  return false;
}

/**
 * Convert expression to human-readable string
 */
function expressionToString(expression: TagFilterExpression): string {
  if (expression.type === 'tag' && expression.tagId !== undefined) {
    return `#tag${expression.tagId}`;
  }

  if (expression.type === 'not' && expression.children && expression.children[0]) {
    return `NOT ${expressionToString(expression.children[0])}`;
  }

  if (expression.children) {
    const operator = expression.type.toUpperCase();
    const childStrings = expression.children.map(child => expressionToString(child));
    return `(${childStrings.join(` ${operator} `)})`;
  }

  return '';
}

/**
 * Build human-readable expression string from tag IDs and logic
 */
function buildExpressionString(
  tagIds: number[],
  logic: FilterLogic,
  tags: Tag[]
): string {
  if (tagIds.length === 0) {
    return '';
  }

  const tagNames = tagIds
    .map(id => tags.find(t => t.id === id))
    .filter((tag): tag is Tag => tag !== undefined)
    .map(tag => `#${tag.name}`);

  if (tagNames.length === 1) {
    return tagNames[0] || '';
  }

  return `(${tagNames.join(` ${logic} `)})`;
}
