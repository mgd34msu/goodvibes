// ============================================================================
// CONTEXT MENU HOOK
// Provides right-click context menu support for the entire application
// ============================================================================

import { useEffect } from 'react';

/**
 * Hook that enables context menus (right-click) for standard input fields
 * and text areas throughout the application.
 *
 * For the terminal, context menu is handled separately in TerminalView.tsx
 * because it needs special handling for xterm.js selection.
 */
export function useContextMenu(): void {
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if target is an input, textarea, or has contenteditable
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]') !== null;

      // Get the current selection
      const selection = window.getSelection();
      const hasSelection = selection !== null && selection.toString().length > 0;

      // Skip if we're in the terminal area (handled by TerminalView)
      if (target.closest('.xterm') || target.closest('[data-terminal]')) {
        return;
      }

      // Show context menu for editable fields or when there's a selection
      if (isEditable || hasSelection) {
        e.preventDefault();
        window.goodvibes.showContextMenu({
          hasSelection,
          isEditable,
          isTerminal: false,
        });
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);
}
