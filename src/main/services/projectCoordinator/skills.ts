// ============================================================================
// PROJECT COORDINATOR - Shared skill configuration
// ============================================================================
//
// Handles skill configurations that are shared across multiple projects.
//
// ============================================================================

import { Logger } from '../logger.js';
import type { SharedSkillConfig } from './types.js';
import {
  getSharedSkillConfigFromState,
  setSharedSkillConfig,
  deleteSharedSkillConfig,
  getAllSharedSkillConfigsFromState,
} from './state.js';
import { emitEvent } from './events.js';

const logger = new Logger('ProjectCoordinator:Skills');

// ============================================================================
// SKILL SHARING
// ============================================================================

/**
 * Share a skill configuration across projects
 */
export function shareSkillAcrossProjects(
  skillId: number,
  skillName: string,
  projectIds: number[],
  settings: Record<string, unknown> = {}
): SharedSkillConfig {
  const existing = getSharedSkillConfigFromState(skillId);

  const config: SharedSkillConfig = {
    skillId,
    skillName,
    sharedAcross: existing
      ? [...new Set([...existing.sharedAcross, ...projectIds])]
      : projectIds,
    settings: { ...existing?.settings, ...settings },
    enabled: existing?.enabled ?? true,
    lastModified: new Date(),
  };

  setSharedSkillConfig(skillId, config);
  emitEvent('coordinator:skill-shared', { config });
  logger.info(`Shared skill ${skillName} across ${config.sharedAcross.length} projects`);

  return config;
}

/**
 * Unshare a skill from projects
 */
export function unshareSkillFromProjects(skillId: number, projectIds: number[]): void {
  const config = getSharedSkillConfigFromState(skillId);
  if (!config) return;

  config.sharedAcross = config.sharedAcross.filter(id => !projectIds.includes(id));
  config.lastModified = new Date();

  if (config.sharedAcross.length === 0) {
    deleteSharedSkillConfig(skillId);
  }

  emitEvent('coordinator:skill-unshared', { skillId, removedFrom: projectIds });
}

// ============================================================================
// SKILL QUERIES
// ============================================================================

/**
 * Get shared skill configuration
 */
export function getSharedSkillConfig(skillId: number): SharedSkillConfig | null {
  return getSharedSkillConfigFromState(skillId) || null;
}

/**
 * Get all shared skill configurations
 */
export function getAllSharedSkillConfigs(): SharedSkillConfig[] {
  return getAllSharedSkillConfigsFromState();
}

/**
 * Get shared skills for a project
 */
export function getSharedSkillsForProject(projectId: number): SharedSkillConfig[] {
  return getAllSharedSkillConfigsFromState()
    .filter(config => config.sharedAcross.includes(projectId));
}

// ============================================================================
// SKILL UPDATES
// ============================================================================

/**
 * Update shared skill settings
 */
export function updateSharedSkillSettings(
  skillId: number,
  settings: Record<string, unknown>
): SharedSkillConfig | null {
  const config = getSharedSkillConfigFromState(skillId);
  if (!config) return null;

  config.settings = { ...config.settings, ...settings };
  config.lastModified = new Date();

  emitEvent('coordinator:skill-updated', { config });
  return config;
}

/**
 * Enable/disable a shared skill
 */
export function setSharedSkillEnabled(skillId: number, enabled: boolean): void {
  const config = getSharedSkillConfigFromState(skillId);
  if (config) {
    config.enabled = enabled;
    config.lastModified = new Date();
    emitEvent('coordinator:skill-toggled', { skillId, enabled });
  }
}

// ============================================================================
// SKILL CLEANUP
// ============================================================================

/**
 * Remove a project from all shared skill configurations
 * Called when a project is removed from the registry
 */
export function removeProjectFromSkills(projectId: number): void {
  for (const config of getAllSharedSkillConfigsFromState()) {
    config.sharedAcross = config.sharedAcross.filter(id => id !== projectId);
  }
}
