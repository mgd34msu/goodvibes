/**
 * Path resolution utilities for handling encoded project directory names.
 * 
 * Claude CLI encodes project paths by replacing `/` with `-`. This is lossy because
 * hyphens in actual directory names become indistinguishable from path separators.
 * 
 * Example: `/home/buzzkill/Projects/goodvibes-plugin` -> `-home-buzzkill-Projects-goodvibes-plugin`
 * Naive decode would produce: `/home/buzzkill/Projects/goodvibes/plugin` (incorrect)
 * 
 * This module provides filesystem-aware resolution to handle these ambiguous cases.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../services/logger.js';
import { getAllRegisteredProjects } from '../database/projectRegistry/projects.js';

const logger = new Logger('PathResolver');

/**
 * Resolve an encoded project directory name to an actual filesystem path.
 * Handles the ambiguity where hyphens could be path separators or literal hyphens.
 * 
 * Strategy: Start with naive decode (all hyphens = separators), then validate
 * progressively from the root, trying hyphen-joined alternatives when a path
 * segment doesn't exist.
 * 
 * @param encodedName - Encoded directory name (e.g., "-home-buzzkill-Projects-goodvibes-plugin")
 * @returns Resolved filesystem path, or null if resolution fails
 * 
 * @example
 * resolveEncodedProjectPath("-home-buzzkill-Projects-goodvibes-plugin")
 * // Filesystem check: /home/buzzkill/Projects/goodvibes doesn't exist
 * // Try: /home/buzzkill/Projects/goodvibes-plugin (exists!)
 * // Returns: "/home/buzzkill/Projects/goodvibes-plugin"
 */
export function resolveEncodedProjectPath(encodedName: string): string | null {
  if (!encodedName) {
    logger.debug('Empty encoded name provided');
    return null;
  }

  // Try registry lookup first (exact match, zero ambiguity)
  try {
    const projects = getAllRegisteredProjects();
    for (const project of projects) {
      const encoded = project.path.replace(/:/g, '-').replace(/[\/\\]/g, '-');
      if (encoded === encodedName) {
        logger.debug('Resolved via project registry', { encodedName, path: project.path });
        return project.path;
      }
    }
  } catch (error) {
    // Registry might not be initialized yet — fall through to backtracking
    logger.debug('Registry lookup failed, using backtracking', { error });
  }

  let segments: string[];

  // Handle Unix-style paths (leading dash)
  if (encodedName.startsWith('-')) {
    segments = encodedName.substring(1).split('-').filter(Boolean);
    return resolvePathSegments(segments, '/');
  }

  // Handle Windows-style paths (drive letter)
  // Format: "C--Users-name-project" (-- after drive, - between dirs)
  if (encodedName.includes('--') || encodedName.match(/^[A-Z]-/)) {
    const mainParts = encodedName.split('--');
    if (mainParts.length < 2) {
      logger.debug('Invalid Windows-style encoded path', { encodedName });
      return null;
    }

    const driveLetter = mainParts[0];
    const pathSegments = mainParts.slice(1).join('-').split('-').filter(Boolean);

    const root = driveLetter + ':';
    return resolvePathSegments(pathSegments, root);
  }

  logger.debug('Unsupported encoded path format', { encodedName });
  return null;
}

/**
 * Internal helper to resolve path segments with filesystem validation.
 * Uses recursive backtracking to try longest matches first.
 * 
 * @param segments - Array of path segments (already split by hyphens)
 * @param root - Root path to start from (e.g., "/" or "C:")
 * @returns Resolved path or null
 */
function resolvePathSegments(segments: string[], root: string): string | null {
  if (segments.length === 0) {
    return root;
  }

  /**
   * Recursive backtracking: try all possible ways to partition segments into path components.
   * Each component is 1+ consecutive segments joined by hyphens.
   * Try longest first so "goodvibes-plugin" is tried before "goodvibes" + "plugin".
   */
  function backtrack(startIdx: number, currentPath: string): string | null {
    if (startIdx >= segments.length) {
      // All segments consumed — this is a valid path
      return currentPath;
    }

    // Try longest match first (most segments joined), down to single segment
    for (let endIdx = segments.length; endIdx > startIdx; endIdx--) {
      const component = segments.slice(startIdx, endIdx).join('-');
      const candidatePath = path.join(currentPath, component);

      if (fs.existsSync(candidatePath)) {
        const result = backtrack(endIdx, candidatePath);
        if (result !== null) return result;
      }
    }

    // No valid partition found from this point
    return null;
  }

  // Try filesystem-validated backtracking first
  const resolved = backtrack(0, root);
  if (resolved) return path.normalize(resolved);

  // Fallback: naive join (all segments as individual path components)
  const naivePath = path.join(root, ...segments);
  logger.debug('Backtracking failed, using naive path', { segments, naivePath });
  return path.normalize(naivePath);
}


