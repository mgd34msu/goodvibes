// ============================================================================
// HOOK SERVER DEFAULT HANDLERS
// ============================================================================

import { Logger } from '../logger.js';
import { getMainWindow } from '../../window.js';
import {
  findAgentBySession,
  upsertAgent,
  updateAgentStatus,
  getAgent,
  getAllAgents,
  type AgentStatus,
} from '../../database/primitives.js';
import {
  getActiveAgentsForProject,
  getPendingSkillsForProject,
  getIndexedAgent,
  getIndexedSkill,
  markSkillInjected,
  recordAgentUsage,
  recordSkillUsage,
} from '../../database/agencyIndex.js';
import type { HookPayload, HookResponse, HookHandler } from './types.js';
import { getPayloadValue } from './types.js';

const logger = new Logger('HookHandlers');

// ============================================================================
// HANDLER FACTORY
// ============================================================================

export interface HandlerContext {
  pushSession: (workingDirectory: string | undefined, sessionId: string) => void;
  popSession: (workingDirectory: string | undefined, sessionId: string) => void;
  getCurrentParentSession: (workingDirectory: string | undefined) => string | null;
  cleanupSession: (sessionId: string) => void;
  emit: (event: string, data: unknown) => void;
}

/**
 * Create default handlers with access to session tracking context
 */
export function createDefaultHandlers(context: HandlerContext): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();

  // PreToolUse - Check policies before tool execution AND track Task tool for hierarchy
  handlers.set('PreToolUse', async (payload: HookPayload): Promise<HookResponse> => {
    const toolName = getPayloadValue<string>(payload, 'tool_name', 'toolName');
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

    // CRITICAL: Track Task tool invocations to infer parent-child relationships
    if (toolName === 'Task' && sessionId) {
      logger.info(`[HIERARCHY] Task tool detected in session ${sessionId} - marking as pending parent`);
      if (workingDirectory) {
        context.pushSession(workingDirectory, sessionId);
      }
    }

    return { decision: 'allow' };
  });

  // PostToolUse - Track tool usage after execution
  handlers.set('PostToolUse', async (payload: HookPayload): Promise<HookResponse> => {
    const toolName = getPayloadValue<string>(payload, 'tool_name', 'toolName');
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const toolResponse = getPayloadValue<{ success: boolean; content: string }>(payload, 'tool_response', 'toolResponse');

    if (toolName) {
      context.emit('tool:used', {
        toolName,
        sessionId,
        success: toolResponse?.success ?? true,
      });
    }
    return { decision: 'allow' };
  });

  // SessionStart - Inject context when session starts AND create/update root agent
  handlers.set('SessionStart', async (payload: HookPayload): Promise<HookResponse> => {
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

    logger.info(`[HOOKS] SessionStart received - FULL DEBUG`, {
      sessionId,
      workingDirectory,
      fullPayload: JSON.stringify(payload),
    });

    // Track this session in our stack for hierarchy tracking
    if (sessionId && workingDirectory) {
      context.pushSession(workingDirectory, sessionId);
      logger.info(`[HIERARCHY] Session ${sessionId} pushed to stack for ${workingDirectory}`);
    }

    // Create or update the ROOT agent for this session
    if (sessionId && workingDirectory) {
      try {
        const agent = upsertAgent({
          id: sessionId,
          name: 'Main Session',
          pid: null,
          cwd: workingDirectory,
          parentId: null,
          templateId: null,
          status: 'active' as AgentStatus,
          sessionPath: sessionId,
          initialPrompt: null,
        });
        logger.info(`[HIERARCHY] Root agent created/updated:`, {
          agentId: agent.id,
          name: agent.name,
          sessionPath: agent.sessionPath,
          parentId: agent.parentId,
        });

        // Verify it can be found
        const verifyLookup = findAgentBySession(sessionId);
        if (verifyLookup) {
          logger.info(`[HIERARCHY] Verified: Agent ${sessionId} can be found by session lookup`);
        } else {
          logger.error(`[HIERARCHY] ERROR: Agent ${sessionId} was just created but cannot be found by session lookup!`);
        }
      } catch (error) {
        logger.error('Failed to create root agent for session:', error);
      }
    }

    context.emit('session:start', {
      sessionId,
      projectPath: workingDirectory,
    });

    // Inject active agents and pending skills for this project
    let injectContext = '';

    if (workingDirectory) {
      try {
        // Get active agents for this project
        const activeAgents = getActiveAgentsForProject(workingDirectory);
        for (const activeAgent of activeAgents) {
          const agent = getIndexedAgent(activeAgent.agentId);
          if (agent) {
            injectContext += `\n\n<!-- GOODVIBES:AGENT:${agent.slug} -->\n`;
            injectContext += `## Agent: ${agent.name}\n\n`;
            if (agent.description) {
              injectContext += `${agent.description}\n\n`;
            }
            injectContext += agent.content;
            injectContext += `\n<!-- /GOODVIBES:AGENT:${agent.slug} -->\n`;
            recordAgentUsage(agent.id);
          }
        }

        // Get pending skills for this project
        const pendingSkills = getPendingSkillsForProject(workingDirectory);
        for (const queuedSkill of pendingSkills) {
          const skill = getIndexedSkill(queuedSkill.skillId);
          if (skill) {
            injectContext += `\n\n<!-- GOODVIBES:SKILL:${skill.slug} -->\n`;
            injectContext += `## Skill: ${skill.name}\n\n`;
            if (skill.description) {
              injectContext += `${skill.description}\n\n`;
            }
            injectContext += skill.content;
            injectContext += `\n<!-- /GOODVIBES:SKILL:${skill.slug} -->\n`;
            markSkillInjected(queuedSkill.id);
            recordSkillUsage(skill.id);
          }
        }

        if (injectContext) {
          logger.info(`Injecting context for session: ${activeAgents.length} agents, ${pendingSkills.length} skills`);
        }
      } catch (error) {
        logger.error('Failed to prepare context injection:', error);
      }
    }

    return {
      decision: 'allow',
      inject_context: injectContext || undefined,
    };
  });

  // SessionEnd - Record session completion AND mark agent as completed
  handlers.set('SessionEnd', async (payload: HookPayload): Promise<HookResponse> => {
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

    logger.info(`[HOOKS] SessionEnd received`, { sessionId, workingDirectory });

    // Remove this session from our hierarchy stack
    if (sessionId && workingDirectory) {
      context.popSession(workingDirectory, sessionId);
    }

    // Clean up all Map entries for this session to prevent unbounded growth
    if (sessionId) {
      context.cleanupSession(sessionId);
    }

    // Mark the agent as completed
    if (sessionId) {
      try {
        const agent = findAgentBySession(sessionId);
        if (agent) {
          updateAgentStatus(agent.id, 'completed');
          logger.info(`Agent marked as completed: ${agent.id}`);
        }
      } catch (error) {
        logger.error('Failed to mark agent as completed:', error);
      }
    }

    context.emit('session:end', {
      sessionId,
      projectPath: workingDirectory,
    });
    return { decision: 'allow' };
  });

  // SubagentStart - Track agent hierarchy
  handlers.set('SubagentStart', async (payload: HookPayload): Promise<HookResponse> => {
    const subagentId = getPayloadValue<string>(payload, 'agent_id', 'agentId');
    const subagentType = getPayloadValue<string>(payload, 'agent_type', 'agentType');
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const explicitParentSessionId = getPayloadValue<string>(payload, 'parent_session_id', 'parentSessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');
    const agentName = getPayloadValue<string>(payload, 'agent_name', 'agentName');

    logger.info(`[HOOKS] SubagentStart received - FULL DEBUG`, {
      subagentId,
      subagentType,
      sessionId,
      explicitParentSessionId,
      workingDirectory,
      agentName,
      fullPayload: JSON.stringify(payload),
    });

    if (subagentId) {
      try {
        let parentId: string | null = null;
        let parentLookupMethod: string = 'none';

        // Strategy 1: Use explicit parent_session_id if provided
        if (!parentId && explicitParentSessionId) {
          const parentAgent = findAgentBySession(explicitParentSessionId);
          if (parentAgent) {
            parentId = parentAgent.id;
            parentLookupMethod = 'explicit_parent_session_id';
            logger.info(`[HIERARCHY] Found parent via parent_session_id: ${explicitParentSessionId} -> agent ${parentId}`);
          }
        }

        // Strategy 2: Use session stack
        if (!parentId && workingDirectory) {
          const stackParentSession = context.getCurrentParentSession(workingDirectory);
          if (stackParentSession) {
            const parentAgent = findAgentBySession(stackParentSession);
            if (parentAgent) {
              parentId = parentAgent.id;
              parentLookupMethod = 'session_stack';
              logger.info(`[HIERARCHY] Found parent via session stack: ${stackParentSession} -> agent ${parentId}`);
            } else {
              const directAgent = getAgent(stackParentSession);
              if (directAgent) {
                parentId = directAgent.id;
                parentLookupMethod = 'session_stack_direct_id';
                logger.info(`[HIERARCHY] Found parent via session stack (direct ID): ${stackParentSession}`);
              }
            }
          }
        }

        // Strategy 3: Use session_id if it matches a known parent
        if (!parentId && sessionId) {
          const parentAgent = findAgentBySession(sessionId);
          if (parentAgent) {
            parentId = parentAgent.id;
            parentLookupMethod = 'session_id_as_parent';
            logger.info(`[HIERARCHY] Found parent via session_id: ${sessionId} -> agent ${parentId}`);
          } else {
            const directAgent = getAgent(sessionId);
            if (directAgent) {
              parentId = directAgent.id;
              parentLookupMethod = 'session_id_direct_lookup';
              logger.info(`[HIERARCHY] Found parent via session_id (direct ID): ${sessionId}`);
            }
          }
        }

        // Strategy 4: ID parsing heuristic
        if (!parentId && subagentId && subagentId.includes('-')) {
          const possibleParentId = subagentId.split('-')[0];
          const parentAgent = getAgent(possibleParentId);
          if (parentAgent) {
            parentId = parentAgent.id;
            parentLookupMethod = 'id_parsing_heuristic';
            logger.info(`[HIERARCHY] Found parent via ID parsing: ${possibleParentId}`);
          }
        }

        if (parentId) {
          logger.info(`[HIERARCHY] SUCCESS - Subagent ${subagentId} linked to parent ${parentId} via ${parentLookupMethod}`);
        } else {
          logger.warn(`[HIERARCHY] FAILED - Could not find parent for subagent ${subagentId}`);
          const allAgents = getAllAgents();
          logger.warn(`[HIERARCHY DEBUG] Known agents in registry (${allAgents.length}):`,
            allAgents.map(a => ({ id: a.id, name: a.name, sessionPath: a.sessionPath }))
          );
        }

        const effectiveName = agentName || subagentType || `Subagent-${subagentId}`;

        const agent = upsertAgent({
          id: subagentId,
          name: effectiveName,
          pid: null,
          cwd: workingDirectory || process.cwd(),
          parentId,
          templateId: null,
          status: 'active' as AgentStatus,
          sessionPath: subagentId,
          initialPrompt: null,
        });

        logger.info(`[HIERARCHY] Subagent created in database:`, {
          agentId: agent.id,
          agentName: agent.name,
          parentId: agent.parentId,
          sessionPath: agent.sessionPath,
          lookupMethod: parentLookupMethod,
        });

        // Notify renderer
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:detected', {
            id: agent.id,
            name: effectiveName,
            parentId: agent.parentId,
            sessionId: subagentId,
          });
        }
      } catch (error) {
        logger.error('Failed to create subagent:', error);
      }
    } else {
      logger.warn('[HOOKS] SubagentStart missing agent_id - cannot create agent');
    }

    context.emit('agent:start', {
      agentName: agentName || subagentType || null,
      sessionId: subagentId,
    });
    return { decision: 'allow' };
  });

  // SubagentStop - Track agent completion
  handlers.set('SubagentStop', async (payload: HookPayload): Promise<HookResponse> => {
    const subagentId = getPayloadValue<string>(payload, 'agent_id', 'agentId');
    const agentName = getPayloadValue<string>(payload, 'agent_name', 'agentName');
    const parentSessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

    logger.info(`[HOOKS] SubagentStop received`, { subagentId, agentName, parentSessionId, workingDirectory });

    if (subagentId) {
      try {
        let agent = getAgent(subagentId);
        if (!agent) {
          agent = findAgentBySession(subagentId);
        }

        if (agent) {
          updateAgentStatus(agent.id, 'completed');
          logger.info(`Subagent marked as completed: ${agent.id} (${agentName || agent.name})`);
        } else {
          logger.warn(`[HOOKS] SubagentStop: Could not find agent with ID ${subagentId}`);
        }
      } catch (error) {
        logger.error('Failed to mark subagent as completed:', error);
      }
    } else {
      logger.warn('[HOOKS] SubagentStop missing agent_id');
    }

    context.emit('agent:stop', {
      agentName,
      sessionId: subagentId,
    });
    return { decision: 'allow' };
  });

  // PermissionRequest - Route to approval queue
  handlers.set('PermissionRequest', async (payload: HookPayload): Promise<HookResponse> => {
    const permissionType = getPayloadValue<string>(payload, 'permission_type', 'permissionType');
    const permissionDetails = getPayloadValue<string>(payload, 'permission_details', 'permissionDetails');
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');

    context.emit('permission:requested', {
      type: permissionType,
      details: permissionDetails,
      sessionId,
    });
    return { decision: 'allow' };
  });

  // Notification - Route to GoodVibes notifications
  handlers.set('Notification', async (payload: HookPayload): Promise<HookResponse> => {
    const notificationType = getPayloadValue<string>(payload, 'notification_type', 'notificationType');
    const notificationMessage = getPayloadValue<string>(payload, 'notification_message', 'notificationMessage');
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hook:notification', {
        type: notificationType,
        message: notificationMessage,
        sessionId,
      });
    }
    return { decision: 'allow' };
  });

  return handlers;
}
