// ============================================================================
// PROJECT REGISTRY - Template Management
// ============================================================================

import { Logger } from '../logger.js';
import {
  createProjectTemplate,
  getProjectTemplate,
  getProjectTemplateByName,
  getAllProjectTemplates,
  updateProjectTemplate,
  deleteProjectTemplate,
  applyTemplateToProject,
  createTemplateFromProject,
  type ProjectSettings,
  type ProjectTemplate,
  type TemplateAgent,
  type RegisteredProject,
} from '../../database/projectRegistry.js';

const logger = new Logger('ProjectRegistryService:Templates');

// Event emitter will be injected
let emitEventFn: ((event: string, data: Record<string, unknown>) => void) | null = null;

export function setTemplateEventEmitter(fn: (event: string, data: Record<string, unknown>) => void): void {
  emitEventFn = fn;
}

function emitEvent(event: string, data: Record<string, unknown>): void {
  if (emitEventFn) {
    emitEventFn(event, data);
  }
}

// ============================================================================
// TEMPLATE MANAGEMENT
// ============================================================================

/**
 * Create a new project template
 */
export function createTemplate(
  name: string,
  description?: string,
  settings?: ProjectSettings,
  agents?: TemplateAgent[]
): ProjectTemplate {
  const template = createProjectTemplate(name, description, settings, agents);
  emitEvent('template:created', { template });
  logger.info(`Created project template: ${name}`);
  return template;
}

/**
 * Get a template by ID
 */
export function getTemplate(templateId: number): ProjectTemplate | null {
  return getProjectTemplate(templateId);
}

/**
 * Get a template by name
 */
export function getTemplateByName(name: string): ProjectTemplate | null {
  return getProjectTemplateByName(name);
}

/**
 * Get all templates
 */
export function getAllTemplates(): ProjectTemplate[] {
  return getAllProjectTemplates();
}

/**
 * Update a template
 */
export function updateTemplate(
  templateId: number,
  updates: Partial<{
    name: string;
    description: string | null;
    settings: ProjectSettings;
    agents: TemplateAgent[];
  }>
): ProjectTemplate | null {
  const template = updateProjectTemplate(templateId, updates);
  if (template) {
    emitEvent('template:updated', { template });
  }
  return template;
}

/**
 * Delete a template
 */
export function removeTemplate(templateId: number): void {
  const template = getProjectTemplate(templateId);
  if (!template) return;

  deleteProjectTemplate(templateId);
  emitEvent('template:deleted', { templateId, templateName: template.name });
  logger.info(`Deleted project template: ${template.name}`);
}

/**
 * Apply a template to a project
 */
export function applyTemplate(projectId: number, templateId: number): RegisteredProject | null {
  const result = applyTemplateToProject(projectId, templateId);
  if (result) {
    emitEvent('template:applied', { projectId, templateId });
    logger.info(`Applied template ${templateId} to project ${projectId}`);
  }
  return result;
}

/**
 * Create a template from an existing project
 */
export function createTemplateFromExistingProject(
  projectId: number,
  templateName: string,
  description?: string
): ProjectTemplate | null {
  const template = createTemplateFromProject(projectId, templateName, description);
  if (template) {
    emitEvent('template:created-from-project', { template, projectId });
    logger.info(`Created template '${templateName}' from project ${projectId}`);
  }
  return template;
}
