// ============================================================================
// CONTEXT INJECTION TESTS
// ============================================================================
//
// Comprehensive tests for the context injection system.
// Tests cover:
// - CLAUDE.md file handling and manipulation
// - Agent activation/deactivation
// - Skill queuing and injection
// - Section marker management
// - Error handling and edge cases
//
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { EventEmitter } from 'events';

// ============================================================================
// MOCKS - Must be defined before imports
// ============================================================================

const { mockAgencyIndex } = vi.hoisted(() => {
  const mockAgencyIndex = {
    getIndexedAgent: vi.fn(),
    getIndexedSkill: vi.fn(),
    getActiveAgentsForSession: vi.fn(() => []),
    getActiveAgentsForProject: vi.fn(() => []),
    getPendingSkillsForSession: vi.fn(() => []),
    getPendingSkillsForProject: vi.fn(() => []),
    activateAgent: vi.fn(),
    deactivateAgentByAgentId: vi.fn(),
    queueSkill: vi.fn(),
    markSkillInjected: vi.fn(),
    removeQueuedSkill: vi.fn(),
    clearSkillQueue: vi.fn(),
    recordAgentUsage: vi.fn(),
    recordSkillUsage: vi.fn(),
  };
  return { mockAgencyIndex };
});

vi.mock('../../database/agencyIndex.js', () => mockAgencyIndex);

vi.mock('../logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// ============================================================================
// IMPORTS - After mocks
// ============================================================================

import {
  ContextInjectionService,
  getContextInjectionService,
  initializeContextInjectionService,
  type SessionContext,
  type InjectionResult,
} from '../contextInjection.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'test-session-123',
    projectPath: '/test/project',
    workingDirectory: '/tmp/test-working-dir',
    ...overrides,
  };
}

function createMockAgent(id: number, name: string, content: string = `# ${name} Agent\nAgent content`) {
  return {
    id,
    name,
    content,
    description: `Description for ${name}`,
    filePath: `/agents/${name.toLowerCase()}.md`,
    packageId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockSkill(id: number, name: string, content: string = `# ${name} Skill\nSkill content`) {
  return {
    id,
    name,
    content,
    description: `Description for ${name}`,
    filePath: `/skills/${name.toLowerCase()}.md`,
    packageId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createActiveAgent(agentId: number, sessionId?: string, projectPath?: string) {
  return {
    id: agentId + 1000,
    agentId,
    sessionId: sessionId || null,
    projectPath: projectPath || null,
    priority: 0,
    activatedAt: new Date().toISOString(),
  };
}

function createQueuedSkill(skillId: number, sessionId?: string, projectPath?: string) {
  return {
    id: skillId + 2000,
    skillId,
    sessionId: sessionId || null,
    projectPath: projectPath || null,
    priority: 0,
    status: 'pending' as const,
    queuedAt: new Date().toISOString(),
    injectedAt: null,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('ContextInjectionService', () => {
  let service: ContextInjectionService;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new ContextInjectionService();

    // Create temporary directory for tests
    tempDir = await fs.promises.mkdtemp('/tmp/context-injection-test-');
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  // ==========================================================================
  // SINGLETON FUNCTIONS
  // ==========================================================================

  describe('getContextInjectionService', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = getContextInjectionService();
      const instance2 = getContextInjectionService();

      expect(instance1).toBe(instance2);
    });

    it('should return an instance of ContextInjectionService', () => {
      const instance = getContextInjectionService();

      expect(instance).toBeInstanceOf(ContextInjectionService);
    });
  });

  describe('initializeContextInjectionService', () => {
    it('should create a new instance', () => {
      const instance1 = initializeContextInjectionService();
      const instance2 = initializeContextInjectionService();

      // Each call should create a new instance
      expect(instance1).not.toBe(instance2);
      expect(instance1).toBeInstanceOf(ContextInjectionService);
      expect(instance2).toBeInstanceOf(ContextInjectionService);
    });
  });

  // ==========================================================================
  // INJECT FOR SESSION
  // ==========================================================================

  describe('injectForSession', () => {
    it('should inject agents and skills into CLAUDE.md', async () => {
      const mockAgent = createMockAgent(1, 'TestAgent');
      const mockSkill = createMockSkill(2, 'TestSkill');

      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([
        createActiveAgent(1, 'test-session-123'),
      ]);
      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([
        createQueuedSkill(2, 'test-session-123'),
      ]);
      mockAgencyIndex.getIndexedAgent.mockReturnValue(mockAgent);
      mockAgencyIndex.getIndexedSkill.mockReturnValue(mockSkill);

      const context = createSessionContext({ workingDirectory: tempDir });
      const result = await service.injectForSession(context);

      expect(result.success).toBe(true);
      expect(result.injectedAgents).toEqual(['TestAgent']);
      expect(result.injectedSkills).toEqual(['TestSkill']);
      expect(result.claudeMdPath).toBe(path.join(tempDir, 'CLAUDE.md'));
      expect(result.errors).toEqual([]);

      // Verify CLAUDE.md was created and contains content
      const claudeMdContent = await fs.promises.readFile(
        path.join(tempDir, 'CLAUDE.md'),
        'utf-8'
      );
      expect(claudeMdContent).toContain('TestAgent');
      expect(claudeMdContent).toContain('TestSkill');
    });

    it('should prevent concurrent injection', async () => {
      const context = createSessionContext({ workingDirectory: tempDir });

      // Start first injection
      const promise1 = service.injectForSession(context);

      // Try to start second injection immediately
      const result2 = await service.injectForSession(context);

      expect(result2.success).toBe(false);
      expect(result2.errors).toContain('Injection already in progress');

      // Wait for first injection to complete
      await promise1;
    });

    it('should handle empty agents and skills', async () => {
      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([]);
      mockAgencyIndex.getActiveAgentsForProject.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForProject.mockReturnValue([]);

      const context = createSessionContext({ workingDirectory: tempDir });
      const result = await service.injectForSession(context);

      expect(result.success).toBe(true);
      expect(result.injectedAgents).toEqual([]);
      expect(result.injectedSkills).toEqual([]);

      // Verify CLAUDE.md contains placeholder comments
      const claudeMdContent = await fs.promises.readFile(
        path.join(tempDir, 'CLAUDE.md'),
        'utf-8'
      );
      expect(claudeMdContent).toContain('No agents currently active');
      expect(claudeMdContent).toContain('No skills currently injected');
    });

    it('should deduplicate agents and skills', async () => {
      const mockAgent = createMockAgent(1, 'TestAgent');

      // Return the same agent from both session and project
      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([
        createActiveAgent(1, 'test-session-123'),
      ]);
      mockAgencyIndex.getActiveAgentsForProject.mockReturnValue([
        createActiveAgent(1, undefined, '/test/project'),
      ]);
      mockAgencyIndex.getIndexedAgent.mockReturnValue(mockAgent);

      const context = createSessionContext({ workingDirectory: tempDir });
      const result = await service.injectForSession(context);

      expect(result.injectedAgents).toEqual(['TestAgent']);
      expect(mockAgencyIndex.recordAgentUsage).toHaveBeenCalledTimes(1);
    });

    it('should keep highest priority on duplicate', async () => {
      const mockAgent = createMockAgent(1, 'TestAgent');

      const lowPriority = createActiveAgent(1, 'test-session-123');
      lowPriority.priority = 1;

      const highPriority = createActiveAgent(1, undefined, '/test/project');
      highPriority.priority = 10;

      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([lowPriority]);
      mockAgencyIndex.getActiveAgentsForProject.mockReturnValue([highPriority]);
      mockAgencyIndex.getIndexedAgent.mockReturnValue(mockAgent);

      const context = createSessionContext({ workingDirectory: tempDir });
      const result = await service.injectForSession(context);

      expect(result.success).toBe(true);
      expect(result.injectedAgents.length).toBe(1);
    });

    it('should mark skills as injected', async () => {
      const mockSkill = createMockSkill(2, 'TestSkill');
      const queuedSkill = createQueuedSkill(2, 'test-session-123');

      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([queuedSkill]);
      mockAgencyIndex.getIndexedSkill.mockReturnValue(mockSkill);

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      expect(mockAgencyIndex.markSkillInjected).toHaveBeenCalledWith(queuedSkill.id);
    });

    it('should emit injected event', async () => {
      const emitSpy = vi.fn();
      service.on('injected', emitSpy);

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should handle errors gracefully', async () => {
      mockAgencyIndex.getActiveAgentsForSession.mockImplementation(() => {
        throw new Error('Database error');
      });

      const context = createSessionContext({ workingDirectory: tempDir });
      const result = await service.injectForSession(context);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Database error');
    });
  });

  // ==========================================================================
  // AGENT ACTIVATION/DEACTIVATION
  // ==========================================================================

  describe('activateAgentForSession', () => {
    it('should activate agent and emit event', () => {
      const mockActiveAgent = createActiveAgent(1, 'test-session-123');
      mockAgencyIndex.activateAgent.mockReturnValue(mockActiveAgent);

      const emitSpy = vi.fn();
      service.on('agentActivated', emitSpy);

      const result = service.activateAgentForSession(1, 'test-session-123', undefined, 5);

      expect(mockAgencyIndex.activateAgent).toHaveBeenCalledWith(
        1,
        'test-session-123',
        undefined,
        5
      );
      expect(result).toEqual(mockActiveAgent);
      expect(emitSpy).toHaveBeenCalledWith({
        agentId: 1,
        sessionId: 'test-session-123',
        projectPath: undefined,
      });
    });

    it('should activate for project', () => {
      const mockActiveAgent = createActiveAgent(1, undefined, '/test/project');
      mockAgencyIndex.activateAgent.mockReturnValue(mockActiveAgent);

      const result = service.activateAgentForSession(1, undefined, '/test/project');

      expect(mockAgencyIndex.activateAgent).toHaveBeenCalledWith(
        1,
        undefined,
        '/test/project',
        0
      );
      expect(result).toEqual(mockActiveAgent);
    });
  });

  describe('deactivateAgentForSession', () => {
    it('should deactivate agent and emit event', () => {
      const emitSpy = vi.fn();
      service.on('agentDeactivated', emitSpy);

      service.deactivateAgentForSession(1, 'test-session-123');

      expect(mockAgencyIndex.deactivateAgentByAgentId).toHaveBeenCalledWith(
        1,
        'test-session-123',
        undefined
      );
      expect(emitSpy).toHaveBeenCalledWith({
        agentId: 1,
        sessionId: 'test-session-123',
        projectPath: undefined,
      });
    });
  });

  // ==========================================================================
  // SKILL QUEUING
  // ==========================================================================

  describe('queueSkillForSession', () => {
    it('should queue skill and emit event', () => {
      const mockQueuedSkill = createQueuedSkill(2, 'test-session-123');
      mockAgencyIndex.queueSkill.mockReturnValue(mockQueuedSkill);

      const emitSpy = vi.fn();
      service.on('skillQueued', emitSpy);

      const result = service.queueSkillForSession(2, 'test-session-123', undefined, 3);

      expect(mockAgencyIndex.queueSkill).toHaveBeenCalledWith(
        2,
        'test-session-123',
        undefined,
        3
      );
      expect(result).toEqual(mockQueuedSkill);
      expect(emitSpy).toHaveBeenCalledWith({
        skillId: 2,
        sessionId: 'test-session-123',
        projectPath: undefined,
      });
    });
  });

  describe('removeSkillFromQueue', () => {
    it('should remove skill and emit event', () => {
      const emitSpy = vi.fn();
      service.on('skillRemoved', emitSpy);

      service.removeSkillFromQueue(2000);

      expect(mockAgencyIndex.removeQueuedSkill).toHaveBeenCalledWith(2000);
      expect(emitSpy).toHaveBeenCalledWith({ id: 2000 });
    });
  });

  describe('clearQueue', () => {
    it('should clear queue and emit event', () => {
      const emitSpy = vi.fn();
      service.on('queueCleared', emitSpy);

      service.clearQueue('test-session-123', '/test/project');

      expect(mockAgencyIndex.clearSkillQueue).toHaveBeenCalledWith(
        'test-session-123',
        '/test/project'
      );
      expect(emitSpy).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        projectPath: '/test/project',
      });
    });
  });

  // ==========================================================================
  // CLAUDE.MD OPERATIONS
  // ==========================================================================

  describe('CLAUDE.md file handling', () => {
    it('should create CLAUDE.md if it does not exist', async () => {
      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([]);
      mockAgencyIndex.getActiveAgentsForProject.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForProject.mockReturnValue([]);

      const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
      expect(fs.existsSync(claudeMdPath)).toBe(false);

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      expect(fs.existsSync(claudeMdPath)).toBe(true);
    });

    it('should preserve existing CLAUDE.md content outside markers', async () => {
      const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
      const existingContent = `# My Project\n\nThis is my custom content.\n`;
      await fs.promises.writeFile(claudeMdPath, existingContent, 'utf-8');

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      const updatedContent = await fs.promises.readFile(claudeMdPath, 'utf-8');
      expect(updatedContent).toContain('My Project');
      expect(updatedContent).toContain('my custom content');
    });

    it('should add section markers if missing', async () => {
      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([]);
      mockAgencyIndex.getActiveAgentsForProject.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([]);
      mockAgencyIndex.getPendingSkillsForProject.mockReturnValue([]);

      const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
      const existingContent = `# My Project\n\nNo markers here.\n`;
      await fs.promises.writeFile(claudeMdPath, existingContent, 'utf-8');

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      const updatedContent = await fs.promises.readFile(claudeMdPath, 'utf-8');
      expect(updatedContent).toContain('<!-- GOODVIBES:AGENTS:START -->');
      expect(updatedContent).toContain('<!-- GOODVIBES:AGENTS:END -->');
      expect(updatedContent).toContain('<!-- GOODVIBES:SKILLS:START -->');
      expect(updatedContent).toContain('<!-- GOODVIBES:SKILLS:END -->');
    });
  });

  describe('readClaudeMd', () => {
    it('should read CLAUDE.md content', async () => {
      const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
      const content = '# Test Content';
      await fs.promises.writeFile(claudeMdPath, content, 'utf-8');

      const result = await service.readClaudeMd(tempDir);

      expect(result).toBe(content);
    });

    it('should return null if file does not exist', async () => {
      const result = await service.readClaudeMd(tempDir);

      expect(result).toBeNull();
    });
  });

  describe('clearInjectedSections', () => {
    it('should clear agent and skill sections', async () => {
      const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
      const content = `# Project

<!-- GOODVIBES:AGENTS:START -->
## Agent: TestAgent
Agent content
<!-- GOODVIBES:AGENTS:END -->

<!-- GOODVIBES:SKILLS:START -->
## Skill: TestSkill
Skill content
<!-- GOODVIBES:SKILLS:END -->
`;
      await fs.promises.writeFile(claudeMdPath, content, 'utf-8');

      const result = await service.clearInjectedSections(tempDir);

      expect(result).toBe(true);

      const updatedContent = await fs.promises.readFile(claudeMdPath, 'utf-8');
      expect(updatedContent).toContain('No agents currently active');
      expect(updatedContent).toContain('No skills currently injected');
      expect(updatedContent).not.toContain('TestAgent');
      expect(updatedContent).not.toContain('TestSkill');
    });

    it('should return false on error', async () => {
      const result = await service.clearInjectedSections('/nonexistent/directory');

      expect(result).toBe(false);
    });
  });

  describe('getSectionMarkers', () => {
    it('should return section markers', () => {
      const markers = service.getSectionMarkers();

      expect(markers).toHaveProperty('AGENT_START');
      expect(markers).toHaveProperty('AGENT_END');
      expect(markers).toHaveProperty('SKILL_START');
      expect(markers).toHaveProperty('SKILL_END');
      expect(markers.AGENT_START).toBe('<!-- GOODVIBES:AGENTS:START -->');
      expect(markers.AGENT_END).toBe('<!-- GOODVIBES:AGENTS:END -->');
    });

    it('should return a copy of markers', () => {
      const markers1 = service.getSectionMarkers();
      const markers2 = service.getSectionMarkers();

      expect(markers1).not.toBe(markers2);
      expect(markers1).toEqual(markers2);
    });
  });

  // ==========================================================================
  // SECTION GENERATION
  // ==========================================================================

  describe('section generation', () => {
    it('should generate agent section with multiple agents', async () => {
      const agent1 = createMockAgent(1, 'Agent1', '# Agent 1 Content');
      const agent2 = createMockAgent(2, 'Agent2', '# Agent 2 Content');

      mockAgencyIndex.getActiveAgentsForSession.mockReturnValue([
        createActiveAgent(1),
        createActiveAgent(2),
      ]);
      mockAgencyIndex.getIndexedAgent
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      const claudeMdContent = await fs.promises.readFile(
        path.join(tempDir, 'CLAUDE.md'),
        'utf-8'
      );

      expect(claudeMdContent).toContain('Agent: Agent1');
      expect(claudeMdContent).toContain('Agent: Agent2');
      expect(claudeMdContent).toContain('# Agent 1 Content');
      expect(claudeMdContent).toContain('# Agent 2 Content');
    });

    it('should generate skill section with multiple skills', async () => {
      const skill1 = createMockSkill(1, 'Skill1', '# Skill 1 Content');
      const skill2 = createMockSkill(2, 'Skill2', '# Skill 2 Content');

      mockAgencyIndex.getPendingSkillsForSession.mockReturnValue([
        createQueuedSkill(1),
        createQueuedSkill(2),
      ]);
      mockAgencyIndex.getIndexedSkill
        .mockReturnValueOnce(skill1)
        .mockReturnValueOnce(skill2);

      const context = createSessionContext({ workingDirectory: tempDir });
      await service.injectForSession(context);

      const claudeMdContent = await fs.promises.readFile(
        path.join(tempDir, 'CLAUDE.md'),
        'utf-8'
      );

      expect(claudeMdContent).toContain('Skill: Skill1');
      expect(claudeMdContent).toContain('Skill: Skill2');
      expect(claudeMdContent).toContain('# Skill 1 Content');
      expect(claudeMdContent).toContain('# Skill 2 Content');
    });
  });
});
