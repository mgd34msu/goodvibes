// ============================================================================
// CLIPBOARD SCHEMAS
// ============================================================================

import { z } from 'zod';

/**
 * Context menu options schema
 */
export const contextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  isEditable: z.boolean(),
  isTerminal: z.boolean().optional(),
});

/**
 * Terminal context menu options schema
 */
export const terminalContextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  selectedText: z.string().max(100000).optional(),
});

/**
 * Clipboard write schema
 */
export const clipboardWriteSchema = z.string().max(10000000); // 10MB limit

/**
 * Clipboard read image schema
 */
export const clipboardReadImageSchema = z.string().optional();
