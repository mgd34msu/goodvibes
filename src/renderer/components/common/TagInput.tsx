// ============================================================================
// TAG INPUT - Autocomplete input for selecting or creating tags
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Tag } from '../../../shared/types/tag-types';
import { createLogger } from '../../../shared/logger';
import { toast } from '../../stores/toastStore';

const logger = createLogger('TagInput');

// Debounce implementation
function useDebounce<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

// ============================================================================
// TYPES
// ============================================================================

interface TagInputProps {
  onTagSelect: (tag: Tag) => void;
  onTagCreate?: (name: string) => void;
  existingTagIds?: number[];
  placeholder?: string;
  autoFocus?: boolean;
  showRecentTags?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

// ============================================================================
// SIZE VARIANTS
// ============================================================================

const SIZE_CLASSES = {
  sm: 'text-xs px-2 py-1',
  md: 'text-sm px-3 py-2',
  lg: 'text-base px-4 py-3',
} as const;

// ============================================================================
// COMPONENT
// ============================================================================

export function TagInput({
  onTagSelect,
  onTagCreate,
  existingTagIds = [],
  placeholder = 'Search or create tag...',
  autoFocus = false,
  showRecentTags = false,
  size = 'md',
}: TagInputProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [recentTags, setRecentTags] = useState<Tag[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const debouncedQuery = useDebounce(query, 300);

  // ============================================================================
  // UPDATE DROPDOWN POSITION
  // ============================================================================

  useEffect(() => {
    if (isOpen && containerRef.current) {
      const updatePosition = () => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          setDropdownPosition({
            top: rect.bottom,
            left: rect.left,
            width: rect.width,
          });
        }
      };

      updatePosition();
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);

      return () => {
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
      };
    }
  }, [isOpen]);

  // ============================================================================
  // HANDLE CLICKS OUTSIDE
  // ============================================================================

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // ============================================================================
  // FETCH SUGGESTIONS
  // ============================================================================

  useEffect(() => {
    if (debouncedQuery.length > 0) {
      void (async () => {
        try {
          const result = await window.goodvibes.getAllTags();
          if (result.success) {
            const filtered = result.data
              .filter((tag) => !existingTagIds.includes(tag.id))
              .filter((tag) => tag.name.toLowerCase().includes(debouncedQuery.toLowerCase()));
            setSuggestions(filtered);
            setIsOpen(true);
            setHighlightedIndex(0);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Failed to fetch tags', { error: errorMessage });
          toast.error('Failed to load tags');
        }
      })();
    } else {
      setSuggestions([]);
      setIsOpen(false);
    }
  }, [debouncedQuery, existingTagIds]);

  // ============================================================================
  // FETCH RECENT TAGS
  // ============================================================================

  useEffect(() => {
    if (showRecentTags) {
      void (async () => {
        try {
          const result = await window.goodvibes.getRecentTags(5);
          if (result.success) {
            const filtered = result.data.filter((tag) => !existingTagIds.includes(tag.id));
            setRecentTags(filtered);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Failed to fetch recent tags', { error: errorMessage });
        }
      })();
    }
  }, [showRecentTags, existingTagIds]);

  // ============================================================================
  // KEYBOARD NAVIGATION
  // ============================================================================

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) return;

    const totalItems = suggestions.length + (hasExactMatch ? 0 : 1); // +1 for "Create" option

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev + 1) % totalItems);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 + totalItems) % totalItems);
        break;
      case 'Enter':
        e.preventDefault();
        handleSelectHighlighted();
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setQuery('');
        break;
    }
  };

  // ============================================================================
  // SELECTION HANDLERS
  // ============================================================================

  const handleSelectHighlighted = () => {
    if (highlightedIndex < suggestions.length) {
      const selectedTag = suggestions[highlightedIndex];
      if (selectedTag) {
        handleSelectTag(selectedTag);
      }
    } else if (onTagCreate && query.trim()) {
      handleCreateTag(query.trim());
    }
  };

  const handleSelectTag = (tag: Tag) => {
    onTagSelect(tag);
    setQuery('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleCreateTag = (name: string) => {
    if (onTagCreate) {
      onTagCreate(name);
      setQuery('');
      setIsOpen(false);
      inputRef.current?.focus();
    }
  };

  const handleRecentTagClick = (tag: Tag) => {
    handleSelectTag(tag);
  };

  // ============================================================================
  // HELPERS
  // ============================================================================

  const hasExactMatch = suggestions.some(
    (tag) => tag.name.toLowerCase() === query.toLowerCase()
  );

  const shouldShowCreateOption = onTagCreate && query.trim() && !hasExactMatch;

  // Highlight matching characters in tag name
  const highlightMatch = (text: string, query: string) => {
    if (!query) return text;

    const parts = [];
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let lastIndex = 0;

    let index = lowerText.indexOf(lowerQuery, lastIndex);
    while (index !== -1) {
      // Text before match
      if (index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`} className="text-surface-200">
            {text.slice(lastIndex, index)}
          </span>
        );
      }

      // Matched text
      parts.push(
        <span key={`match-${index}`} className="text-accent-purple font-semibold">
          {text.slice(index, index + query.length)}
        </span>
      );

      lastIndex = index + query.length;
      index = lowerText.indexOf(lowerQuery, lastIndex);
    }

    // Remaining text
    if (lastIndex < text.length) {
      parts.push(
        <span key={`text-${lastIndex}`} className="text-surface-200">
          {text.slice(lastIndex)}
        </span>
      );
    }

    return parts;
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="space-y-2">
      {/* Input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => query && setIsOpen(true)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={`w-full bg-surface-700 border border-surface-600 rounded focus:outline-none focus:ring-2 focus:ring-accent-purple/50 focus:border-accent-purple text-surface-100 placeholder-surface-400 transition-colors ${SIZE_CLASSES[size]}`}
        />

        {/* Dropdown */}
        {isOpen && (suggestions.length > 0 || shouldShowCreateOption) && (
          <div
            ref={dropdownRef}
            className="absolute z-50 w-full mt-1 bg-surface-800 border border-surface-600 rounded shadow-lg max-h-60 overflow-y-auto"
          >
            {/* Existing tag suggestions */}
            {suggestions.map((tag, index) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => handleSelectTag(tag)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors ${
                  highlightedIndex === index
                    ? 'bg-accent-purple/20 text-surface-100'
                    : 'text-surface-300 hover:bg-surface-700'
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <span>{highlightMatch(tag.name, query)}</span>
                {tag.usageCount > 0 && (
                  <span className="ml-auto text-xs text-surface-500">{tag.usageCount}</span>
                )}
              </button>
            ))}

            {/* Create new tag option */}
            {shouldShowCreateOption && (
              <button
                type="button"
                onClick={() => handleCreateTag(query.trim())}
                onMouseEnter={() => setHighlightedIndex(suggestions.length)}
                className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 border-t border-surface-600 transition-colors ${
                  highlightedIndex === suggestions.length
                    ? 'bg-accent-purple/20 text-surface-100'
                    : 'text-surface-300 hover:bg-surface-700'
                }`}
              >
                <span className="text-accent-purple text-lg leading-none">+</span>
                <span>
                  Create <span className="font-semibold">"{query.trim()}"</span>
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recent tags strip */}
      {showRecentTags && recentTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-surface-400 text-xs">Recent:</span>
          {recentTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => handleRecentTagClick(tag)}
              className="px-2 py-1 rounded text-xs bg-surface-700 hover:bg-surface-600 text-surface-300 border border-surface-600 transition-colors flex items-center gap-1.5"
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: tag.color }}
              />
              <span>{tag.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default TagInput;
