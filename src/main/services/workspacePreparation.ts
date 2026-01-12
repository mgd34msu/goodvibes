// ============================================================================
// WORKSPACE PREPARATION SERVICE (P4) - Pre-Spawn File Writing
// ============================================================================

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { Logger } from './logger.js';
import { getAgentTemplate, type AgentTemplate } from '../database/primitives.js';

const logger = new Logger('WorkspacePreparation');

// ============================================================================
// TYPES
// ============================================================================

export interface WorkspaceConfig {
  cwd: string;
  templateId?: string;
  claudeMdContent?: string;
  contextFiles?: ContextFile[];
  initialPrompt?: string;
  cleanupOnExit?: boolean;
}

export interface ContextFile {
  relativePath: string;
  content: string;
  mode?: 'create' | 'append' | 'prepend';
}

export interface PreparedWorkspace {
  cwd: string;
  claudeMdPath: string | null;
  contextDir: string | null;
  createdFiles: string[];
  backupFiles: Map<string, string>;
  initialPrompt: string | null;
  cleanupFn: () => Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTEXT_DIR_NAME = '.goodvibes-context';
const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const BACKUP_SUFFIX = '.goodvibes-backup';

// ============================================================================
// WORKSPACE PREPARATION SERVICE
// ============================================================================

class WorkspacePreparationService {
  private activeWorkspaces: Map<string, PreparedWorkspace> = new Map();

  // ============================================================================
  // MAIN API
  // ============================================================================

  /**
   * Prepare a workspace for agent spawning
   * This creates/modifies necessary files before the agent starts
   */
  async prepare(config: WorkspaceConfig): Promise<PreparedWorkspace> {
    const {
      cwd,
      templateId,
      claudeMdContent,
      contextFiles = [],
      initialPrompt,
      cleanupOnExit = true,
    } = config;

    logger.info(`Preparing workspace: ${cwd}`, { templateId, hasClaudeMd: !!claudeMdContent });

    // Ensure CWD exists
    if (!existsSync(cwd)) {
      await fs.mkdir(cwd, { recursive: true });
      logger.debug(`Created workspace directory: ${cwd}`);
    }

    const createdFiles: string[] = [];
    const backupFiles = new Map<string, string>();
    let claudeMdPath: string | null = null;
    let contextDir: string | null = null;
    let finalInitialPrompt = initialPrompt || null;

    // Load template if specified
    let template: AgentTemplate | null = null;
    if (templateId) {
      template = getAgentTemplate(templateId);
      if (template) {
        logger.debug(`Using template: ${template.name}`);
        if (!finalInitialPrompt && template.initialPrompt) {
          finalInitialPrompt = template.initialPrompt;
        }
      }
    }

    // Determine CLAUDE.md content
    const finalClaudeMdContent = claudeMdContent || template?.claudeMdContent;

    // Write CLAUDE.md if content provided
    if (finalClaudeMdContent) {
      claudeMdPath = await this.writeClaudeMd(cwd, finalClaudeMdContent, backupFiles, createdFiles);
    }

    // Create context directory and files
    if (contextFiles.length > 0) {
      contextDir = path.join(cwd, CONTEXT_DIR_NAME);
      await this.ensureContextDir(contextDir);

      for (const file of contextFiles) {
        await this.writeContextFile(contextDir, file, createdFiles);
      }
    }

    // Create cleanup function
    const cleanupFn = async () => {
      if (cleanupOnExit) {
        await this.cleanup(cwd, createdFiles, backupFiles);
      }
    };

    const workspace: PreparedWorkspace = {
      cwd,
      claudeMdPath,
      contextDir,
      createdFiles,
      backupFiles,
      initialPrompt: finalInitialPrompt,
      cleanupFn,
    };

    this.activeWorkspaces.set(cwd, workspace);

    logger.info(`Workspace prepared: ${cwd}`, {
      claudeMdPath,
      contextDir,
      filesCreated: createdFiles.length,
      filesBackedUp: backupFiles.size,
    });

    return workspace;
  }

  /**
   * Clean up a prepared workspace
   */
  async cleanup(cwd: string, createdFiles?: string[], backupFiles?: Map<string, string>): Promise<void> {
    const workspace = this.activeWorkspaces.get(cwd);
    const files = createdFiles || workspace?.createdFiles || [];
    const backups = backupFiles || workspace?.backupFiles || new Map();

    logger.info(`Cleaning up workspace: ${cwd}`, {
      filesToRemove: files.length,
      filesToRestore: backups.size,
    });

    // Remove created files
    for (const file of files) {
      try {
        if (existsSync(file)) {
          await fs.unlink(file);
          logger.debug(`Removed: ${file}`);
        }
      } catch (error) {
        logger.warn(`Failed to remove file: ${file}`, error);
      }
    }

    // Restore backed up files
    for (const [original, backup] of backups) {
      try {
        if (existsSync(backup)) {
          await fs.rename(backup, original);
          logger.debug(`Restored: ${original}`);
        }
      } catch (error) {
        logger.warn(`Failed to restore file: ${original}`, error);
      }
    }

    // Remove context directory if empty
    const contextDir = path.join(cwd, CONTEXT_DIR_NAME);
    if (existsSync(contextDir)) {
      try {
        const contents = await fs.readdir(contextDir);
        if (contents.length === 0) {
          await fs.rmdir(contextDir);
          logger.debug(`Removed empty context directory: ${contextDir}`);
        }
      } catch (error) {
        logger.warn(`Failed to clean context directory: ${contextDir}`, error);
      }
    }

    this.activeWorkspaces.delete(cwd);
    logger.info(`Workspace cleanup complete: ${cwd}`);
  }

  /**
   * Get active workspaces
   */
  getActiveWorkspaces(): PreparedWorkspace[] {
    return Array.from(this.activeWorkspaces.values());
  }

  /**
   * Check if a workspace is prepared
   */
  isWorkspacePrepared(cwd: string): boolean {
    return this.activeWorkspaces.has(cwd);
  }

  // ============================================================================
  // CLAUDE.MD MANAGEMENT
  // ============================================================================

  /**
   * Write CLAUDE.md to workspace
   */
  private async writeClaudeMd(
    cwd: string,
    content: string,
    backupFiles: Map<string, string>,
    createdFiles: string[]
  ): Promise<string> {
    const claudeMdPath = path.join(cwd, CLAUDE_MD_FILENAME);

    // Backup existing CLAUDE.md if present
    if (existsSync(claudeMdPath)) {
      const backupPath = claudeMdPath + BACKUP_SUFFIX;
      await fs.copyFile(claudeMdPath, backupPath);
      backupFiles.set(claudeMdPath, backupPath);
      logger.debug(`Backed up existing CLAUDE.md to: ${backupPath}`);
    } else {
      createdFiles.push(claudeMdPath);
    }

    await fs.writeFile(claudeMdPath, content, 'utf-8');
    logger.debug(`Wrote CLAUDE.md: ${claudeMdPath}`);

    return claudeMdPath;
  }

  /**
   * Merge CLAUDE.md content with existing content
   */
  async mergeClaudeMd(cwd: string, additionalContent: string, position: 'prepend' | 'append' = 'append'): Promise<string> {
    const claudeMdPath = path.join(cwd, CLAUDE_MD_FILENAME);
    let existingContent = '';

    if (existsSync(claudeMdPath)) {
      existingContent = await fs.readFile(claudeMdPath, 'utf-8');
    }

    const newContent = position === 'prepend'
      ? `${additionalContent}\n\n${existingContent}`
      : `${existingContent}\n\n${additionalContent}`;

    await fs.writeFile(claudeMdPath, newContent.trim(), 'utf-8');
    logger.debug(`Merged CLAUDE.md: ${claudeMdPath} (${position})`);

    return claudeMdPath;
  }

  /**
   * Read user's global CLAUDE.md
   */
  async readUserClaudeMd(): Promise<string | null> {
    const userClaudeMdPath = path.join(os.homedir(), '.claude', CLAUDE_MD_FILENAME);

    if (existsSync(userClaudeMdPath)) {
      return fs.readFile(userClaudeMdPath, 'utf-8');
    }

    return null;
  }

  /**
   * Read project CLAUDE.md (checks multiple locations)
   */
  async readProjectClaudeMd(cwd: string): Promise<{ content: string; path: string } | null> {
    const locations = [
      path.join(cwd, CLAUDE_MD_FILENAME),
      path.join(cwd, '.claude', CLAUDE_MD_FILENAME),
    ];

    for (const location of locations) {
      if (existsSync(location)) {
        const content = await fs.readFile(location, 'utf-8');
        return { content, path: location };
      }
    }

    return null;
  }

  // ============================================================================
  // CONTEXT FILE MANAGEMENT
  // ============================================================================

  /**
   * Ensure context directory exists
   */
  private async ensureContextDir(contextDir: string): Promise<void> {
    if (!existsSync(contextDir)) {
      await fs.mkdir(contextDir, { recursive: true });
      logger.debug(`Created context directory: ${contextDir}`);
    }
  }

  /**
   * Write a context file
   */
  private async writeContextFile(
    contextDir: string,
    file: ContextFile,
    createdFiles: string[]
  ): Promise<void> {
    const filePath = path.join(contextDir, file.relativePath);
    const fileDir = path.dirname(filePath);

    // Ensure parent directory exists
    if (!existsSync(fileDir)) {
      await fs.mkdir(fileDir, { recursive: true });
    }

    let content = file.content;

    // Handle different write modes
    if (file.mode && existsSync(filePath)) {
      const existingContent = await fs.readFile(filePath, 'utf-8');

      if (file.mode === 'append') {
        content = `${existingContent}\n${content}`;
      } else if (file.mode === 'prepend') {
        content = `${content}\n${existingContent}`;
      }
    } else {
      createdFiles.push(filePath);
    }

    await fs.writeFile(filePath, content, 'utf-8');
    logger.debug(`Wrote context file: ${filePath}`);
  }

  /**
   * Write shared state file for inter-agent coordination
   */
  async writeSharedState(cwd: string, state: Record<string, unknown>): Promise<string> {
    const contextDir = path.join(cwd, CONTEXT_DIR_NAME);
    await this.ensureContextDir(contextDir);

    const statePath = path.join(contextDir, 'shared-state.json');
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');

    logger.debug(`Wrote shared state: ${statePath}`);
    return statePath;
  }

  /**
   * Read shared state file
   */
  async readSharedState(cwd: string): Promise<Record<string, unknown> | null> {
    const statePath = path.join(cwd, CONTEXT_DIR_NAME, 'shared-state.json');

    if (existsSync(statePath)) {
      const content = await fs.readFile(statePath, 'utf-8');
      return JSON.parse(content);
    }

    return null;
  }

  /**
   * Update shared state file
   */
  async updateSharedState(cwd: string, updates: Record<string, unknown>): Promise<void> {
    const currentState = await this.readSharedState(cwd) || {};
    const newState = { ...currentState, ...updates };
    await this.writeSharedState(cwd, newState);
  }

  // ============================================================================
  // TEMPLATE UTILITIES
  // ============================================================================

  /**
   * Generate CLAUDE.md content from template variables
   */
  generateClaudeMdFromTemplate(
    template: string,
    variables: Record<string, string>
  ): string {
    let content = template;

    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      content = content.replace(pattern, value);
    }

    return content;
  }

  /**
   * Get default CLAUDE.md templates
   */
  getDefaultTemplates(): Record<string, string> {
    return {
      'code-review': `# Code Review Agent

You are a code review specialist. Your role is to:
- Review code changes for bugs, security issues, and best practices
- Provide constructive feedback with specific suggestions
- Focus on code quality, maintainability, and performance
- Be thorough but respectful in your reviews

## Project Context
{{project_description}}

## Review Focus Areas
- Security vulnerabilities
- Error handling
- Code style consistency
- Performance implications
- Test coverage
`,

      'backend-developer': `# Backend Developer Agent

You are a backend development specialist. Your expertise includes:
- API design and implementation
- Database schema design and optimization
- Authentication and authorization
- Performance optimization
- Testing and debugging

## Project Context
{{project_description}}

## Tech Stack
{{tech_stack}}
`,

      'frontend-developer': `# Frontend Developer Agent

You are a frontend development specialist. Your expertise includes:
- React/Vue/Angular component development
- CSS and responsive design
- State management
- Accessibility (a11y)
- Performance optimization

## Project Context
{{project_description}}

## Tech Stack
{{tech_stack}}
`,

      'debugger': `# Debugging Agent

You are a debugging specialist. Your role is to:
- Analyze error messages and stack traces
- Identify root causes of bugs
- Propose and implement fixes
- Write regression tests
- Document the issue and solution

## Current Issue
{{issue_description}}

## Steps to Reproduce
{{steps_to_reproduce}}
`,

      'documentation': `# Documentation Agent

You are a technical documentation specialist. Your role is to:
- Write clear, comprehensive documentation
- Generate API documentation
- Create user guides and tutorials
- Document architecture decisions
- Maintain README files

## Project Context
{{project_description}}

## Documentation Style
- Use clear, concise language
- Include code examples
- Add diagrams where helpful
- Keep content up to date
`,

      'test-writer': `# Test Writing Agent

You are a testing specialist. Your role is to:
- Write comprehensive unit tests
- Create integration tests
- Implement end-to-end tests
- Improve test coverage
- Ensure tests are maintainable

## Testing Framework
{{testing_framework}}

## Focus Areas
- Edge cases
- Error scenarios
- Happy paths
- Performance tests
`,
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let workspaceService: WorkspacePreparationService | null = null;

export function getWorkspaceService(): WorkspacePreparationService {
  if (!workspaceService) {
    workspaceService = new WorkspacePreparationService();
  }
  return workspaceService;
}

export function shutdownWorkspaceService(): void {
  if (workspaceService) {
    // Cleanup all active workspaces
    const workspaces = workspaceService.getActiveWorkspaces();
    for (const workspace of workspaces) {
      workspace.cleanupFn().catch(err => {
        logger.error(`Failed to cleanup workspace: ${workspace.cwd}`, err);
      });
    }
    workspaceService = null;
  }
}

// Export the class for testing
export { WorkspacePreparationService };
