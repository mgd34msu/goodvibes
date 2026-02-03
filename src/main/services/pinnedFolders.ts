// ============================================================================
// PINNED FOLDERS SERVICE
// ============================================================================

import { getSetting, setSetting } from '../database/index.js';
import { Logger } from './logger.js';

const logger = new Logger('PinnedFolders');

export interface PinnedFolder {
  path: string;
  name: string;
}

let pinnedFolders: PinnedFolder[] = [];

export function loadPinnedFolders(): void {
  try {
    const saved = getSetting<PinnedFolder[]>('pinnedFolders');
    if (saved && Array.isArray(saved)) {
      pinnedFolders = saved;
      logger.info(`Loaded ${pinnedFolders.length} pinned folders`);
    }
  } catch (error) {
    logger.error('Failed to load pinned folders', error);
  }
}

export function savePinnedFolders(): void {
  try {
    setSetting('pinnedFolders', pinnedFolders);
  } catch (error) {
    logger.error('Failed to save pinned folders', error);
  }
}

export function getPinnedFolders(): PinnedFolder[] {
  return [...pinnedFolders];
}

export function addPinnedFolder(path: string, name: string): PinnedFolder[] {
  // Check if already pinned
  const existingIndex = pinnedFolders.findIndex(f => f.path === path);
  if (existingIndex !== -1) {
    logger.debug(`Folder already pinned: ${path}`);
    return getPinnedFolders();
  }

  // Add to pinned folders
  pinnedFolders.push({ path, name });
  savePinnedFolders();
  logger.debug(`Pinned folder: ${path}`);
  return getPinnedFolders();
}

export function removePinnedFolder(path: string): PinnedFolder[] {
  const index = pinnedFolders.findIndex(f => f.path === path);
  if (index !== -1) {
    pinnedFolders.splice(index, 1);
    savePinnedFolders();
    logger.debug(`Unpinned folder: ${path}`);
  }
  return getPinnedFolders();
}

export function clearPinnedFolders(): void {
  pinnedFolders = [];
  savePinnedFolders();
}
