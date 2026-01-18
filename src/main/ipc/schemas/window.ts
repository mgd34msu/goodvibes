// ============================================================================
// WINDOW SCHEMAS - Validation for window-related IPC handlers
// ============================================================================
// Note: This app uses native Windows title bar controls (titleBarOverlay),
// so there are no custom minimize/maximize/close handlers.
// These schemas cover window-related operations like clipboard and context menus.
// ============================================================================

import { z } from 'zod';

// ============================================================================
// CLIPBOARD SCHEMAS
// ============================================================================

/**
 * Clipboard write schema - validates text to be written to clipboard
 * Limit to 10MB to prevent memory issues
 */
export const clipboardWriteSchema = z.string()
  .max(10_000_000, 'Text exceeds maximum clipboard size of 10MB');

/**
 * Context menu options schema - validates options for generic context menu
 */
export const contextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  isEditable: z.boolean(),
  isTerminal: z.boolean().optional(),
});

/**
 * Terminal context menu options schema - validates terminal-specific context menu options
 */
export const terminalContextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  selectedText: z.string()
    .max(100_000, 'Selected text exceeds 100KB limit')
    .optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ClipboardWriteInput = z.infer<typeof clipboardWriteSchema>;
export type ContextMenuOptions = z.infer<typeof contextMenuOptionsSchema>;
export type TerminalContextMenuOptions = z.infer<typeof terminalContextMenuOptionsSchema>;
