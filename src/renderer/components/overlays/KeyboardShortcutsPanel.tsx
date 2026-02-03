// ============================================================================
// KEYBOARD SHORTCUTS PANEL
// Premium cinematic overlay with glass morphism
// ============================================================================

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import {
  X,
  Search,
  RotateCcw,
  AlertTriangle,
  Keyboard,
  ChevronDown,
  ChevronRight,
  Edit2,
  Check,
} from 'lucide-react';
import { FocusTrap } from '../common/FocusTrap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useConfirm } from './ConfirmModal';
import {
  useShortcutState,
  bindingToDisplayString,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type KeyBinding,
  type ShortcutDefinition,
  type ShortcutCategory,
} from '../../hooks/useKeyboardShortcuts';

// ============================================================================
// Component
// ============================================================================

export function KeyboardShortcutsPanel(): React.JSX.Element | null {
  const {
    shortcutsByCategory,
    customBindings,
    conflicts,
    isHelpOpen,
    closeHelp,
    setCustomBinding,
    resetBinding,
    resetAllBindings,
    getEffectiveBinding,
  } = useShortcutState();

  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<ShortcutCategory>>(
    new Set(CATEGORY_ORDER)
  );
  const [editingShortcut, setEditingShortcut] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Confirm dialog for reset all
  const { confirm: confirmReset, ConfirmDialog } = useConfirm({
    title: 'Reset All Shortcuts',
    message: 'Reset all keyboard shortcuts to their defaults?',
    confirmText: 'Reset',
    cancelText: 'Cancel',
    variant: 'warning',
  });

  // Focus search input when opened
  useEffect(() => {
    if (isHelpOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isHelpOpen]);

  // Reset search when closed
  useEffect(() => {
    if (!isHelpOpen) {
      setSearchQuery('');
      setEditingShortcut(null);
    }
  }, [isHelpOpen]);

  // Filter shortcuts by search query
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) {
      return shortcutsByCategory;
    }

    const query = searchQuery.toLowerCase();
    const filtered = new Map<ShortcutCategory, ShortcutDefinition[]>();

    for (const [category, shortcuts] of shortcutsByCategory) {
      const matchingShortcuts = shortcuts.filter(
        (s) =>
          s.label.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query) ||
          bindingToDisplayString(s.binding).toLowerCase().includes(query)
      );

      if (matchingShortcuts.length > 0) {
        filtered.set(category, matchingShortcuts);
      }
    }

    return filtered;
  }, [shortcutsByCategory, searchQuery]);

  // Toggle category expansion
  const toggleCategory = useCallback((category: ShortcutCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  // Check if shortcut has a custom binding
  const hasCustomBinding = useCallback(
    (id: string) => customBindings.has(id),
    [customBindings]
  );

  // Check if shortcut has a conflict
  const hasConflict = useCallback(
    (id: string) => conflicts.some((c) => c.shortcutId === id || c.conflictingId === id),
    [conflicts]
  );

  // Handle reset all
  const handleResetAll = useCallback(async () => {
    const confirmed = await confirmReset();
    if (confirmed) {
      resetAllBindings();
    }
  }, [resetAllBindings, confirmReset]);

  if (!isHelpOpen) return null;

  const hasCustomizations = customBindings.size > 0;
  const hasConflicts = conflicts.length > 0;

  return (
    <>
    <ConfirmDialog />
    <div
      className="modal-backdrop-premium"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      onClick={closeHelp}
    >
      {/* Panel */}
      <FocusTrap active>
        <ErrorBoundary
          fallback={
            <div className="modal-panel-premium modal-lg">
              <div className="p-8 text-center">
                <p className="text-slate-400">Keyboard Shortcuts Panel encountered an error</p>
                <button onClick={closeHelp} className="btn btn-secondary mt-4">
                  Close
                </button>
              </div>
            </div>
          }
          onReset={closeHelp}
        >
          <div
            className="modal-panel-premium modal-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="modal-header-premium">
              <div className="flex items-center gap-3">
                <div className="modal-icon-container icon-info" style={{ width: 44, height: 44, margin: 0 }}>
                  <Keyboard className="w-5 h-5 text-violet-400" />
                </div>
                <div>
                  <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
                  <p className="modal-subtitle">
                    {shortcutsByCategory.size > 0
                      ? `${Array.from(shortcutsByCategory.values()).reduce((a, b) => a + b.length, 0)} shortcuts available`
                      : 'Loading shortcuts...'}
                  </p>
                </div>
              </div>
              <button onClick={closeHelp} className="modal-close-premium">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="modal-search-premium border-b border-white/[0.06]">
              <Search className="w-4 h-4 search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search shortcuts..."
                aria-label="Search shortcuts"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="p-1 rounded text-slate-500 hover:text-slate-300 transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Conflicts Warning */}
            {hasConflicts && (
              <div className="px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
                <div className="flex items-center gap-2 text-sm text-amber-400">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>
                    {conflicts.length} shortcut conflict{conflicts.length > 1 ? 's' : ''} detected
                  </span>
                </div>
              </div>
            )}

            {/* Shortcuts List */}
            <div className="modal-body-premium p-0">
              {filteredCategories.size === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Search className="w-12 h-12 text-slate-600 mb-4" />
                  <p className="text-slate-400 font-medium">No shortcuts found</p>
                  <p className="text-sm text-slate-500 mt-1">
                    Try a different search term
                  </p>
                </div>
              ) : (
                <div className="py-2">
                  {CATEGORY_ORDER.filter((cat) => filteredCategories.has(cat)).map((category) => (
                    <CategorySection
                      key={category}
                      category={category}
                      shortcuts={filteredCategories.get(category) || []}
                      isExpanded={expandedCategories.has(category)}
                      onToggle={() => toggleCategory(category)}
                      editingShortcut={editingShortcut}
                      onEditShortcut={setEditingShortcut}
                      getEffectiveBinding={getEffectiveBinding}
                      hasCustomBinding={hasCustomBinding}
                      hasConflict={hasConflict}
                      onSetCustomBinding={setCustomBinding}
                      onResetBinding={resetBinding}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="modal-footer-premium modal-footer-split">
              <div className="text-xs text-slate-500">
                Press <kbd className="kbd-premium">Esc</kbd> to close
              </div>
              {hasCustomizations && (
                <button
                  onClick={handleResetAll}
                  className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset All
                </button>
              )}
            </div>
          </div>
        </ErrorBoundary>
      </FocusTrap>
    </div>
    </>
  );
}

// ============================================================================
// Category Section
// ============================================================================

interface CategorySectionProps {
  category: ShortcutCategory;
  shortcuts: ShortcutDefinition[];
  isExpanded: boolean;
  onToggle: () => void;
  editingShortcut: string | null;
  onEditShortcut: (id: string | null) => void;
  getEffectiveBinding: (id: string) => KeyBinding | undefined;
  hasCustomBinding: (id: string) => boolean;
  hasConflict: (id: string) => boolean;
  onSetCustomBinding: (id: string, binding: KeyBinding) => void;
  onResetBinding: (id: string) => void;
}

function CategorySection({
  category,
  shortcuts,
  isExpanded,
  onToggle,
  editingShortcut,
  onEditShortcut,
  getEffectiveBinding,
  hasCustomBinding,
  hasConflict,
  onSetCustomBinding,
  onResetBinding,
}: CategorySectionProps) {
  return (
    <div className="mb-1">
      {/* Category Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-6 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-500" />
        )}
        <span className="text-sm font-medium text-slate-300">
          {CATEGORY_LABELS[category]}
        </span>
        <span className="text-xs text-slate-600">({shortcuts.length})</span>
      </button>

      {/* Shortcuts */}
      {isExpanded && (
        <div className="px-4 pb-2">
          {shortcuts.map((shortcut) => (
            <ShortcutRow
              key={shortcut.id}
              shortcut={shortcut}
              isEditing={editingShortcut === shortcut.id}
              onStartEdit={() => onEditShortcut(shortcut.id)}
              onStopEdit={() => onEditShortcut(null)}
              effectiveBinding={getEffectiveBinding(shortcut.id)}
              isCustom={hasCustomBinding(shortcut.id)}
              hasConflict={hasConflict(shortcut.id)}
              onSetBinding={(binding) => onSetCustomBinding(shortcut.id, binding)}
              onReset={() => onResetBinding(shortcut.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Shortcut Row
// ============================================================================

interface ShortcutRowProps {
  shortcut: ShortcutDefinition;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  effectiveBinding: KeyBinding | undefined;
  isCustom: boolean;
  hasConflict: boolean;
  onSetBinding: (binding: KeyBinding) => void;
  onReset: () => void;
}

function ShortcutRow({
  shortcut,
  isEditing,
  onStartEdit,
  onStopEdit,
  effectiveBinding,
  isCustom,
  hasConflict,
  onSetBinding,
  onReset,
}: ShortcutRowProps) {
  const [pendingBinding, setPendingBinding] = useState<KeyBinding | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  // Handle key capture
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels
      if (e.key === 'Escape') {
        setPendingBinding(null);
        onStopEdit();
        return;
      }

      // Enter confirms
      if (e.key === 'Enter' && pendingBinding) {
        onSetBinding(pendingBinding);
        setPendingBinding(null);
        onStopEdit();
        return;
      }

      // Ignore modifier-only presses
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        return;
      }

      // Capture the binding
      setPendingBinding({
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    },
    [pendingBinding, onSetBinding, onStopEdit]
  );

  const handleConfirm = useCallback(() => {
    if (pendingBinding) {
      onSetBinding(pendingBinding);
    }
    setPendingBinding(null);
    onStopEdit();
  }, [pendingBinding, onSetBinding, onStopEdit]);

  const handleCancel = useCallback(() => {
    setPendingBinding(null);
    onStopEdit();
  }, [onStopEdit]);

  const displayBinding = pendingBinding || effectiveBinding || shortcut.binding;

  return (
    <div
      className={clsx(
        'group flex items-center justify-between py-2.5 px-4 rounded-xl transition-colors',
        isEditing && 'bg-violet-500/10 border border-violet-500/20',
        hasConflict && !isEditing && 'bg-amber-500/5',
        !isEditing && !hasConflict && 'hover:bg-white/[0.03]'
      )}
    >
      {/* Label and Description */}
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-200">{shortcut.label}</span>
          {isCustom && !isEditing && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
              Custom
            </span>
          )}
          {hasConflict && !isEditing && (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          )}
        </div>
        <p className="text-xs text-slate-500 truncate mt-0.5">{shortcut.description}</p>
      </div>

      {/* Binding */}
      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={bindingToDisplayString(displayBinding)}
              onKeyDown={handleKeyDown}
              className="w-40 px-3 py-1.5 text-sm text-center bg-white/[0.05] border border-violet-500/30 rounded-lg focus:outline-none focus:border-violet-500 text-slate-200"
              placeholder="Press keys..."
            />
            <button
              onClick={handleConfirm}
              className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/20 transition-colors"
              title="Confirm"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              onClick={handleCancel}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.05] transition-colors"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        ) : (
          <>
            <kbd className="kbd-premium">
              {bindingToDisplayString(displayBinding)}
            </kbd>
            <button
              onClick={onStartEdit}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] opacity-0 group-hover:opacity-100 transition-all"
              title="Edit shortcut"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            {isCustom && (
              <button
                onClick={onReset}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition-colors"
                title="Reset to default"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
