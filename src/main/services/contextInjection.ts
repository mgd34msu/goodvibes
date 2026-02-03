// ============================================================================
// CONTEXT INJECTION SYSTEM
// ============================================================================
//
// Handles injection of agent configurations and skills into Claude sessions.
// Manages CLAUDE.md manipulation, skill queuing, and agent activation.
//
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import {
  getIndexedAgent,
  getIndexedSkill,
  getActiveAgentsForSession,
  getActiveAgentsForProject,
  getPendingSkillsForSession,
  getPendingSkillsForProject,
  activateAgent,
  deactivateAgentByAgentId,
  queueSkill,
  markSkillInjected,
  removeQueuedSkill,
  clearSkillQueue,
  recordAgentUsage,
  recordSkillUsage,
  type IndexedAgent,
  type IndexedSkill,
  type ActiveAgent,
  type QueuedSkill,
} from '../database/agencyIndex.js';

const logger = new Logger('ContextInjection');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Session context for injection
 */
export interface SessionContext {
  sessionId: string;
  projectPath: string;
  workingDirectory: string;
}

/**
 * Injection result
 */
export interface InjectionResult {
  success: boolean;
  injectedAgents: string[];
  injectedSkills: string[];
  claudeMdPath: string | null;
  errors: string[];
}

/**
 * CLAUDE.md section markers
 */
const SECTION_MARKERS = {
  AGENT_START: '<!-- GOODVIBES:AGENTS:START -->',
  AGENT_END: '<!-- GOODVIBES:AGENTS:END -->',
  SKILL_START: '<!-- GOODVIBES:SKILLS:START -->',
  SKILL_END: '<!-- GOODVIBES:SKILLS:END -->',
};

// ============================================================================
// CONTEXT INJECTION SERVICE
// ============================================================================

export class ContextInjectionService extends EventEmitter {
  private injecting: boolean = false;

  constructor() {
    super();
  }

  /**
   * Inject activated agents and queued skills for a session
   */
  async injectForSession(context: SessionContext): Promise<InjectionResult> {
    if (this.injecting) {
      return {
        success: false,
        injectedAgents: [],
        injectedSkills: [],
        claudeMdPath: null,
        errors: ['Injection already in progress'],
      };
    }

    this.injecting = true;
    const result: InjectionResult = {
      success: true,
      injectedAgents: [],
      injectedSkills: [],
      claudeMdPath: null,
      errors: [],
    };

    try {
      // Get active agents for this session/project
      const activeAgents = [
        ...getActiveAgentsForSession(context.sessionId),
        ...getActiveAgentsForProject(context.projectPath),
      ];

      // Get pending skills for this session/project
      const pendingSkills = [
        ...getPendingSkillsForSession(context.sessionId),
        ...getPendingSkillsForProject(context.projectPath),
      ];

      // Remove duplicates
      const uniqueAgents = this.deduplicateAgents(activeAgents);
      const uniqueSkills = this.deduplicateSkills(pendingSkills);

      logger.info(`Injecting ${uniqueAgents.length} agents and ${uniqueSkills.length} skills`);

      // Load agent and skill content
      const agentContents: Array<{ agent: IndexedAgent; content: string }> = [];
      const skillContents: Array<{ skill: IndexedSkill; content: string; queuedId: number }> = [];

      for (const activeAgent of uniqueAgents) {
        const agent = getIndexedAgent(activeAgent.agentId);
        if (agent) {
          agentContents.push({ agent, content: agent.content });
          result.injectedAgents.push(agent.name);
          recordAgentUsage(agent.id);
        }
      }

      for (const queuedSkill of uniqueSkills) {
        const skill = getIndexedSkill(queuedSkill.skillId);
        if (skill) {
          skillContents.push({ skill, content: skill.content, queuedId: queuedSkill.id });
          result.injectedSkills.push(skill.name);
          recordSkillUsage(skill.id);
        }
      }

      // Find or create CLAUDE.md
      const claudeMdPath = await this.findOrCreateClaudeMd(context.workingDirectory);
      result.claudeMdPath = claudeMdPath;

      // Generate injection content
      const agentSection = this.generateAgentSection(agentContents);
      const skillSection = this.generateSkillSection(skillContents);

      // Inject into CLAUDE.md
      await this.injectIntoClaudeMd(claudeMdPath, agentSection, skillSection);

      // Mark skills as injected
      for (const queued of uniqueSkills) {
        markSkillInjected(queued.id);
      }

      this.emit('injected', result);
      logger.info(`Injection complete: ${result.injectedAgents.length} agents, ${result.injectedSkills.length} skills`);
    } catch (err) {
      const error = err as Error;
      result.success = false;
      result.errors.push(error.message);
      logger.error(`Injection failed: ${error.message}`);
    } finally {
      this.injecting = false;
    }

    return result;
  }

  /**
   * Activate an agent for a session or project
   */
  activateAgentForSession(
    agentId: number,
    sessionId?: string,
    projectPath?: string,
    priority: number = 0
  ): ActiveAgent {
    const result = activateAgent(agentId, sessionId, projectPath, priority);
    this.emit('agentActivated', { agentId, sessionId, projectPath });
    return result;
  }

  /**
   * Deactivate an agent
   */
  deactivateAgentForSession(
    agentId: number,
    sessionId?: string,
    projectPath?: string
  ): void {
    deactivateAgentByAgentId(agentId, sessionId, projectPath);
    this.emit('agentDeactivated', { agentId, sessionId, projectPath });
  }

  /**
   * Queue a skill for injection
   */
  queueSkillForSession(
    skillId: number,
    sessionId?: string,
    projectPath?: string,
    priority: number = 0
  ): QueuedSkill {
    const result = queueSkill(skillId, sessionId, projectPath, priority);
    this.emit('skillQueued', { skillId, sessionId, projectPath });
    return result;
  }

  /**
   * Remove a skill from the queue
   */
  removeSkillFromQueue(id: number): void {
    removeQueuedSkill(id);
    this.emit('skillRemoved', { id });
  }

  /**
   * Clear all queued skills for a session/project
   */
  clearQueue(sessionId?: string, projectPath?: string): void {
    clearSkillQueue(sessionId, projectPath);
    this.emit('queueCleared', { sessionId, projectPath });
  }

  /**
   * Find or create CLAUDE.md in the working directory
   */
  private async findOrCreateClaudeMd(workingDirectory: string): Promise<string> {
    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');

    try {
      await fs.promises.access(claudeMdPath, fs.constants.F_OK);
    } catch {
      // File doesn't exist, create it with section markers
      const initialContent = this.generateInitialClaudeMd();
      await fs.promises.writeFile(claudeMdPath, initialContent, 'utf-8');
      logger.info(`Created CLAUDE.md at ${claudeMdPath}`);
    }

    return claudeMdPath;
  }

  /**
   * Generate initial CLAUDE.md content with section markers
   */
  private generateInitialClaudeMd(): string {
    return `# Project Configuration

This file is managed by GoodVibes.

${SECTION_MARKERS.AGENT_START}
<!-- Active agent configurations will be injected here -->
${SECTION_MARKERS.AGENT_END}

${SECTION_MARKERS.SKILL_START}
<!-- Skill content will be injected here -->
${SECTION_MARKERS.SKILL_END}
`;
  }

  /**
   * Generate agent section content
   */
  private generateAgentSection(agents: Array<{ agent: IndexedAgent; content: string }>): string {
    if (agents.length === 0) {
      return '<!-- No agents currently active -->';
    }

    const sections: string[] = [];
    for (const { agent, content } of agents) {
      sections.push(`
## Agent: ${agent.name}

${agent.description || ''}

${content}
`);
    }

    return sections.join('\n---\n');
  }

  /**
   * Generate skill section content
   */
  private generateSkillSection(skills: Array<{ skill: IndexedSkill; content: string; queuedId: number }>): string {
    if (skills.length === 0) {
      return '<!-- No skills currently injected -->';
    }

    const sections: string[] = [];
    for (const { skill, content } of skills) {
      sections.push(`
## Skill: ${skill.name}

${skill.description || ''}

${content}
`);
    }

    return sections.join('\n---\n');
  }

  /**
   * Inject content into CLAUDE.md
   */
  private async injectIntoClaudeMd(
    claudeMdPath: string,
    agentSection: string,
    skillSection: string
  ): Promise<void> {
    let content = await fs.promises.readFile(claudeMdPath, 'utf-8');

    // Ensure section markers exist
    if (!content.includes(SECTION_MARKERS.AGENT_START)) {
      content += `\n\n${SECTION_MARKERS.AGENT_START}\n${SECTION_MARKERS.AGENT_END}\n`;
    }
    if (!content.includes(SECTION_MARKERS.SKILL_START)) {
      content += `\n\n${SECTION_MARKERS.SKILL_START}\n${SECTION_MARKERS.SKILL_END}\n`;
    }

    // Replace agent section
    content = this.replaceSection(
      content,
      SECTION_MARKERS.AGENT_START,
      SECTION_MARKERS.AGENT_END,
      agentSection
    );

    // Replace skill section
    content = this.replaceSection(
      content,
      SECTION_MARKERS.SKILL_START,
      SECTION_MARKERS.SKILL_END,
      skillSection
    );

    await fs.promises.writeFile(claudeMdPath, content, 'utf-8');
    logger.debug(`Updated CLAUDE.md at ${claudeMdPath}`);
  }

  /**
   * Replace content between section markers
   */
  private replaceSection(
    content: string,
    startMarker: string,
    endMarker: string,
    newContent: string
  ): string {
    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      // Markers not found or in wrong order, append section
      return content + `\n\n${startMarker}\n${newContent}\n${endMarker}\n`;
    }

    const before = content.substring(0, startIndex + startMarker.length);
    const after = content.substring(endIndex);

    return `${before}\n${newContent}\n${after}`;
  }

  /**
   * Remove duplicate agents (keep highest priority)
   */
  private deduplicateAgents(agents: ActiveAgent[]): ActiveAgent[] {
    const seen = new Map<number, ActiveAgent>();
    for (const agent of agents) {
      const existing = seen.get(agent.agentId);
      if (!existing || agent.priority > existing.priority) {
        seen.set(agent.agentId, agent);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Remove duplicate skills (keep highest priority)
   */
  private deduplicateSkills(skills: QueuedSkill[]): QueuedSkill[] {
    const seen = new Map<number, QueuedSkill>();
    for (const skill of skills) {
      const existing = seen.get(skill.skillId);
      if (!existing || skill.priority > existing.priority) {
        seen.set(skill.skillId, skill);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Read current CLAUDE.md content
   */
  async readClaudeMd(workingDirectory: string): Promise<string | null> {
    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    try {
      return await fs.promises.readFile(claudeMdPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Clear injected sections from CLAUDE.md
   */
  async clearInjectedSections(workingDirectory: string): Promise<boolean> {
    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');

    try {
      let content = await fs.promises.readFile(claudeMdPath, 'utf-8');

      // Clear agent section
      content = this.replaceSection(
        content,
        SECTION_MARKERS.AGENT_START,
        SECTION_MARKERS.AGENT_END,
        '<!-- No agents currently active -->'
      );

      // Clear skill section
      content = this.replaceSection(
        content,
        SECTION_MARKERS.SKILL_START,
        SECTION_MARKERS.SKILL_END,
        '<!-- No skills currently injected -->'
      );

      await fs.promises.writeFile(claudeMdPath, content, 'utf-8');
      return true;
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to clear injected sections: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the section markers for external use
   */
  getSectionMarkers(): typeof SECTION_MARKERS {
    return { ...SECTION_MARKERS };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let serviceInstance: ContextInjectionService | null = null;

/**
 * Get or create the context injection service instance
 */
export function getContextInjectionService(): ContextInjectionService {
  if (!serviceInstance) {
    serviceInstance = new ContextInjectionService();
  }
  return serviceInstance;
}

/**
 * Initialize the context injection service
 */
export function initializeContextInjectionService(): ContextInjectionService {
  serviceInstance = new ContextInjectionService();
  return serviceInstance;
}
