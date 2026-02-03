// ============================================================================
// TAGS SECTION - Tag management section for session detail modal
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import type { Tag, TagSuggestion } from '../../../../shared/types/tag-types';
import { TagChip } from '../../common/TagChip';
import { TagInput } from '../../common/TagInput';
import { createLogger } from '../../../../shared/logger';
import { toast } from '../../../stores/toastStore';

const logger = createLogger('TagsSection');

// ============================================================================
// TYPES
// ============================================================================

export interface TagsSectionProps {
  sessionId: string;
  onTagsChange?: () => void; // Callback when tags are modified
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TagsSection({ sessionId, onTagsChange }: TagsSectionProps): React.JSX.Element {
  const [tags, setTags] = useState<Tag[]>([]);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<number>>(new Set());

  // ============================================================================
  // LOAD DATA
  // ============================================================================

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [tagsResult, suggestionsResult] = await Promise.all([
        window.goodvibes.getSessionTags(sessionId),
        window.goodvibes.getSessionSuggestions(sessionId),
      ]);

      if (tagsResult.success) {
        setTags(tagsResult.data);
      } else {
        logger.error('Failed to load session tags', { error: tagsResult.error });
        toast.error('Failed to load tags');
      }

      if (suggestionsResult.success) {
        // Only show pending suggestions
        const pending = suggestionsResult.data.filter(s => s.status === 'pending');
        setSuggestions(pending);
      } else {
        logger.error('Failed to load suggestions', { error: suggestionsResult.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to load tag data', { error: errorMessage });
      toast.error('Failed to load tag data');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // ============================================================================
  // TAG HANDLERS
  // ============================================================================

  const handleAddTag = async (tag: Tag) => {
    try {
      const result = await window.goodvibes.addTagToSession(sessionId, tag.id);
      if (result.success) {
        await loadData();
        onTagsChange?.();
        toast.success(`Added tag: ${tag.name}`);
      } else {
        logger.error('Failed to add tag', { error: result.error });
        toast.error(`Failed to add tag: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to add tag', { error: errorMessage });
      toast.error('Failed to add tag');
    }
  };

  const handleCreateAndAdd = async (name: string, color: string, effect: import('../../../../shared/types/tag-types').TagEffect | null) => {
    try {
      // Create the tag with color and effect
      const createResult = await window.goodvibes.createTag({ 
        name, 
        color, 
        effect: effect ?? undefined 
      });
      if (!createResult.success || !createResult.data) {
        logger.error('Failed to create tag', { error: createResult.error });
        toast.error(`Failed to create tag: ${createResult.error}`);
        return;
      }

      // Add it to the session
      const addResult = await window.goodvibes.addTagToSession(sessionId, createResult.data.id);
      if (addResult.success) {
        await loadData();
        onTagsChange?.();
        toast.success(`Created and added tag: ${name}`);
      } else {
        logger.error('Failed to add new tag to session', { error: addResult.error });
        toast.error(`Failed to add tag: ${addResult.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to create and add tag', { error: errorMessage });
      toast.error('Failed to create tag');
    }
  };

  const handleRemoveTag = async (tagId: number) => {
    try {
      const tag = tags.find(t => t.id === tagId);
      const result = await window.goodvibes.removeTagFromSession(sessionId, tagId);
      if (result.success) {
        await loadData();
        onTagsChange?.();
        if (tag) {
          toast.success(`Removed tag: ${tag.name}`);
        }
      } else {
        logger.error('Failed to remove tag', { error: result.error });
        toast.error(`Failed to remove tag: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to remove tag', { error: errorMessage });
      toast.error('Failed to remove tag');
    }
  };

  const handleClearAll = async () => {
    try {
      const result = await window.goodvibes.clearSessionTags(sessionId);
      if (result.success) {
        await loadData();
        onTagsChange?.();
        toast.success('Cleared all tags');
      } else {
        logger.error('Failed to clear tags', { error: result.error });
        toast.error(`Failed to clear tags: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to clear tags', { error: errorMessage });
      toast.error('Failed to clear tags');
    }
  };

  // ============================================================================
  // SUGGESTION HANDLERS
  // ============================================================================

  const handleAcceptSuggestion = async (suggestionId: number) => {
    try {
      setProcessingIds(prev => new Set(prev).add(suggestionId));
      const result = await window.goodvibes.acceptSuggestion(suggestionId);
      if (result.success) {
        await loadData();
        onTagsChange?.();
        toast.success('Accepted suggestion');
      } else {
        logger.error('Failed to accept suggestion', { error: result.error });
        toast.error(`Failed to accept suggestion: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to accept suggestion', { error: errorMessage });
      toast.error('Failed to accept suggestion');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });
    }
  };

  const handleRejectSuggestion = async (suggestionId: number) => {
    try {
      setProcessingIds(prev => new Set(prev).add(suggestionId));
      const result = await window.goodvibes.rejectSuggestion(suggestionId);
      if (result.success) {
        await loadData();
        toast.success('Rejected suggestion');
      } else {
        logger.error('Failed to reject suggestion', { error: result.error });
        toast.error(`Failed to reject suggestion: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to reject suggestion', { error: errorMessage });
      toast.error('Failed to reject suggestion');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });
    }
  };

  const handleAcceptAll = async () => {
    try {
      const result = await window.goodvibes.acceptAllSuggestions(sessionId);
      if (result.success) {
        await loadData();
        onTagsChange?.();
        toast.success(`Accepted ${result.data} suggestions`);
      } else {
        logger.error('Failed to accept all suggestions', { error: result.error });
        toast.error(`Failed to accept suggestions: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to accept all suggestions', { error: errorMessage });
      toast.error('Failed to accept suggestions');
    }
  };

  const handleDismissAll = async () => {
    try {
      const result = await window.goodvibes.dismissAllSuggestions(sessionId);
      if (result.success) {
        await loadData();
        toast.success(`Dismissed ${result.data} suggestions`);
      } else {
        logger.error('Failed to dismiss all suggestions', { error: result.error });
        toast.error(`Failed to dismiss suggestions: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to dismiss all suggestions', { error: errorMessage });
      toast.error('Failed to dismiss suggestions');
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-sm text-surface-400">Loading tags...</div>
      </div>
    );
  }

  const existingTagIds = tags.map(t => t.id);

  return (
    <div className="space-y-6 min-h-[400px]">
      {/* Applied Tags Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-surface-300">Tags</h4>
          {tags.length > 1 && (
            <button
              onClick={handleClearAll}
              className="text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              Clear All
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.map(tag => (
            <TagChip
              key={tag.id}
              tag={tag}
              removable
              onRemove={() => handleRemoveTag(tag.id)}
            />
          ))}
          {tags.length === 0 && (
            <span className="text-sm text-surface-400">No tags applied</span>
          )}
        </div>
      </div>

      {/* Add Tag Section */}
      <div>
        <h4 className="text-sm font-medium text-surface-300 mb-3">Add Tag</h4>
        <TagInput
          onTagSelect={handleAddTag}
          onTagCreate={handleCreateAndAdd}
          existingTagIds={existingTagIds}
          placeholder="Search or create tag..."
          showRecentTags
        />
      </div>

      {/* AI Suggestions Section */}
      {suggestions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-surface-300">Suggested Tags</h4>
            <div className="flex gap-2">
              <button
                onClick={handleAcceptAll}
                className="text-xs text-green-400 hover:text-green-300 transition-colors"
              >
                Accept All
              </button>
              <button
                onClick={handleDismissAll}
                className="text-xs text-surface-400 hover:text-surface-200 transition-colors"
              >
                Dismiss All
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map(suggestion => {
              const isProcessing = processingIds.has(suggestion.id);
              // Create a temporary tag object for TagChip
              const tempTag: Tag = {
                id: 0,
                name: suggestion.tagName,
                color: '#6B7280', // Default gray color
                effect: null,
                parentId: null,
                aliasOf: null,
                description: suggestion.reasoning,
                isPinned: false,
                usageCount: 0,
                createdAt: suggestion.createdAt,
                updatedAt: suggestion.createdAt,
              };

              return (
                <div key={suggestion.id} className="relative">
                  <TagChip
                    tag={tempTag}
                    suggested
                    showConfidence
                    confidence={suggestion.confidence}
                    selectable
                    onClick={() => !isProcessing && handleAcceptSuggestion(suggestion.id)}
                  />
                  {/* Reject button overlay */}
                  {!isProcessing && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRejectSuggestion(suggestion.id);
                      }}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-800 border border-surface-600 flex items-center justify-center hover:bg-red-500 hover:border-red-500 transition-colors text-surface-400 hover:text-white text-xs leading-none"
                      aria-label={`Reject ${suggestion.tagName}`}
                    >
                      ×
                    </button>
                  )}
                  {isProcessing && (
                    <div className="absolute inset-0 flex items-center justify-center bg-surface-900/50 rounded-full">
                      <div className="text-xs text-surface-400">...</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
