// ============================================================================
// RECENT PROJECTS SERVICE
// ============================================================================

import path from 'path';
import { getSetting, setSetting } from '../database/index.js';
import { Logger } from './logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';
import { MAX_RECENT_PROJECTS } from '../../shared/constants.js';

const logger = new Logger('RecentProjects');

interface RecentProject {
  path: string;
  name: string;
  lastOpened: string;
  pinned?: boolean;
}

let recentProjects: RecentProject[] = [];

export function loadRecentProjects(): void {
  try {
    const saved = getSetting<RecentProject[]>('recentProjects');
    if (saved && Array.isArray(saved)) {
      recentProjects = saved;
      logger.info(`Loaded ${recentProjects.length} recent projects`);
    }
  } catch (error) {
    logger.error('Failed to load recent projects', error);
  }
}

export function saveRecentProjects(): void {
  try {
    setSetting('recentProjects', recentProjects);
  } catch (error) {
    logger.error('Failed to save recent projects', error);
  }
}

export function addRecentProject(projectPath: string, name?: string): void {
  // Remove if already exists
  const existingIndex = recentProjects.findIndex(p => p.path === projectPath);
  if (existingIndex !== -1) {
    recentProjects.splice(existingIndex, 1);
  }

  // Add to front
  recentProjects.unshift({
    path: projectPath,
    name: name || path.basename(projectPath),
    lastOpened: formatTimestamp(),
  });

  // Keep only MAX_RECENT_PROJECTS
  if (recentProjects.length > MAX_RECENT_PROJECTS) {
    recentProjects.pop();
  }

  saveRecentProjects();
  logger.debug(`Added recent project: ${projectPath}`);
}

export function getRecentProjects(): RecentProject[] {
  // Sort: pinned first, then by lastOpened
  const sorted = [...recentProjects].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
  });

  // Deduplicate by normalized path (case-insensitive on Windows, handles trailing slashes)
  const seen = new Set<string>();
  return sorted.filter(project => {
    const normalizedPath = path.normalize(project.path).toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(normalizedPath)) {
      return false;
    }
    seen.add(normalizedPath);
    return true;
  });
}

export function pinProject(projectPath: string): RecentProject[] {
  const project = recentProjects.find(p => p.path === projectPath);
  if (project) {
    project.pinned = !project.pinned;
    saveRecentProjects();
  }
  return getRecentProjects();
}

export function removeRecentProject(projectPath: string): void {
  const index = recentProjects.findIndex(p => p.path === projectPath);
  if (index !== -1) {
    recentProjects.splice(index, 1);
    saveRecentProjects();
  }
}

export function clearRecentProjects(): void {
  recentProjects = [];
  saveRecentProjects();
}
