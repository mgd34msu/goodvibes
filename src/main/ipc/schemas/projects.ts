// ============================================================================
// PROJECTS/DIALOG SCHEMAS
// ============================================================================
//
// Zod validation schemas for project and dialog-related IPC handlers.
// These schemas ensure that all user input to file/folder operations
// is properly validated before being processed.
//
// ============================================================================

import { z } from 'zod';
import { filePathSchema, projectPathSchema } from './primitives.js';

// ============================================================================
// FILE PATH SCHEMAS
// ============================================================================

/**
 * Folder path schema for file system operations.
 * Uses the enhanced projectPathSchema which includes comprehensive
 * path traversal prevention (URL encoding, null bytes, normalization checks).
 */
export const folderPathSchema = projectPathSchema;

/**
 * Project name schema for optional display name.
 */
export const projectNameSchema = z.string()
  .max(200, 'Project name too long')
  .optional();

// ============================================================================
// IPC INPUT SCHEMAS
// ============================================================================

/**
 * Input schema for open-in-explorer handler.
 * Validates the folder path to be opened.
 */
export const openInExplorerInputSchema = folderPathSchema;

/**
 * Input schema for add-recent-project handler.
 * Validates the project path and optional name.
 */
export const addRecentProjectInputSchema = z.object({
  path: filePathSchema,
  name: projectNameSchema,
});

/**
 * Input schema for remove-recent-project handler.
 * Validates the project path to be removed.
 */
export const removeRecentProjectInputSchema = filePathSchema;

/**
 * Input schema for pin-project handler.
 * Validates the project path to be pinned/unpinned.
 */
export const pinProjectInputSchema = filePathSchema;

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type FolderPath = z.infer<typeof folderPathSchema>;
export type ProjectName = z.infer<typeof projectNameSchema>;
export type AddRecentProjectInput = z.infer<typeof addRecentProjectInputSchema>;
