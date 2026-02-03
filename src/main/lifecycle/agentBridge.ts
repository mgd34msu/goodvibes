// ============================================================================
// AGENT BRIDGE - PTY Stream Analyzer to Agent Registry Wiring
// ============================================================================
//
// Connects the PTY stream analyzer (which detects agents from terminal output)
// to the agent registry (which tracks agent state and lifecycle).
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../services/logger.js';
import { getMainWindow } from '../window.js';
import { getPTYStreamAnalyzer } from '../services/ptyStreamAnalyzer.js';
import { getAgentRegistry } from '../services/agentRegistry.js';
import { getHookServer } from '../services/hookServer.js';
import { registeredListeners } from './listenerRegistry.js';
import { AGENT_DEDUP_WINDOW_MS } from '../../shared/constants.js';
import type {
  AgentSpawnData,
  AgentCompleteData,
  AgentActivityData,
  SessionStartData,
  AgentHookData,
  SessionEndData,
  TerminalExitedData,
} from './types.js';

const logger = new Logger('AgentBridge');

// Track detected agents: key is a composite of terminalId + timestamp to ensure uniqueness
// Also track agent instance counts per name for display purposes
const agentInstanceCounts = new Map<string, number>(); // agentName -> count
const terminalToAgents = new Map<number, Set<string>>(); // terminalId -> Set of agentIds

// Deduplication: Track recently seen agent names per terminal to avoid duplicate registrations
// Key: "terminalId:agentName", Value: timestamp of last detection
const recentAgentDetections = new Map<string, number>();

/**
 * Handles agent:spawn events from the PTY stream analyzer.
 * Creates new agents in the registry and notifies the renderer.
 */
function handleAgentSpawn(data: AgentSpawnData): void {
  logger.debug('agent:spawn event received', data);

  const agentRegistry = getAgentRegistry();
  if (!agentRegistry) {
    logger.warn('Agent registry not available for spawn event');
    return;
  }

  const { terminalId, agentName, description, timestamp, isRealAgent } = data;

  // Deduplication: Check if we recently detected this same agent in this terminal
  const dedupKey = `${terminalId}:${agentName}`;
  const lastDetection = recentAgentDetections.get(dedupKey);
  if (lastDetection && (timestamp - lastDetection) < AGENT_DEDUP_WINDOW_MS) {
    logger.debug(`Skipping duplicate agent detection: ${agentName} (detected ${timestamp - lastDetection}ms ago)`);
    return;
  }
  recentAgentDetections.set(dedupKey, timestamp);

  // Clean up old dedup entries periodically (every 10 detections)
  if (recentAgentDetections.size > 50) {
    const cutoff = Date.now() - AGENT_DEDUP_WINDOW_MS * 2;
    for (const [key, ts] of recentAgentDetections) {
      if (ts < cutoff) {
        recentAgentDetections.delete(key);
      }
    }
  }

  // Track instance count for this agent name
  const currentCount = agentInstanceCounts.get(agentName) || 0;
  const instanceNumber = currentCount + 1;
  agentInstanceCounts.set(agentName, instanceNumber);

  // Create a display name with instance number if > 1
  const displayName = instanceNumber > 1 ? `${agentName} #${instanceNumber}` : agentName;

  // Register the new agent (always create a new one for each spawn)
  logger.debug(`Spawning new agent in registry: ${displayName} (isRealAgent: ${isRealAgent})`);
  const agent = agentRegistry.spawn({
    name: displayName,
    cwd: process.cwd(), // Will be updated if we can determine it
    initialPrompt: description,
  });

  logger.debug(`Agent spawned successfully: ${displayName} (${agent.id})`);

  // Track which agents belong to which terminal for cleanup
  if (!terminalToAgents.has(terminalId)) {
    terminalToAgents.set(terminalId, new Set());
  }
  const terminalAgents = terminalToAgents.get(terminalId);
  if (terminalAgents) {
    terminalAgents.add(agent.id);
  }

  // Mark as active since we detected it running
  agentRegistry.markActive(agent.id);

  logger.info(`Registered detected agent: ${displayName} (${agent.id})`);

  // Notify renderer of new agent
  const mainWindow = getMainWindow();
  logger.debug(`Notifying renderer, mainWindow exists: ${!!mainWindow}, isDestroyed: ${mainWindow?.isDestroyed()}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:detected', {
      id: agent.id,
      name: displayName,
      description,
      terminalId,
    });
    logger.debug('Sent agent:detected event to renderer');
  }
}

/**
 * Handles terminal-exited IPC events to clean up associated agents.
 */
function handleTerminalExited(_: Electron.IpcMainEvent, data: TerminalExitedData): void {
  const agentRegistry = getAgentRegistry();
  if (!agentRegistry) return;

  const { terminalId } = data;
  const agentIds = terminalToAgents.get(terminalId);
  if (agentIds) {
    for (const agentId of agentIds) {
      const agent = agentRegistry.getAgent(agentId);
      // Only terminate if still in an active state
      if (agent && ['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
        logger.info(`Terminating agent ${agentId} due to terminal ${terminalId} exit`);
        agentRegistry.terminateAgent(agentId);
      }
    }
    terminalToAgents.delete(terminalId);
  }
}

/**
 * Handles agent:complete events from the PTY stream analyzer.
 */
function handleAgentComplete(data: AgentCompleteData): void {
  const agentRegistry = getAgentRegistry();
  if (!agentRegistry) return;

  const { agentId, agentName, reason, terminalId } = data;

  // Find agent by partial ID match or name match within the terminal's agents
  const agentIds = terminalToAgents.get(terminalId);
  if (agentIds) {
    for (const id of agentIds) {
      const agent = agentRegistry.getAgent(id);
      if (!agent) continue;

      // Match by ID or by name (considering numbered instances like "orchestrator #2")
      const matchesById = agentId && (id.startsWith(agentId) || agentId.startsWith(id.substring(0, 7)));
      const matchesByName = agentName && (
        agent.name === agentName ||
        agent.name.startsWith(agentName + ' #') ||
        agent.name.toLowerCase() === agentName.toLowerCase()
      );

      if (matchesById || matchesByName) {
        // Only complete if still in an active state
        if (['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
          agentRegistry.complete(id, reason === 'error' ? 1 : 0);
          logger.info(`Agent completed: ${agent.name} (${id})`, { reason });
        }
        break;
      }
    }
  }
}

/**
 * Handles agent:activity events from the PTY stream analyzer.
 */
function handleAgentActivity(data: AgentActivityData): void {
  const agentRegistry = getAgentRegistry();
  if (!agentRegistry) return;

  const { terminalId } = data;
  // Update activity for all agents in this terminal
  const agentIds = terminalToAgents.get(terminalId);
  if (agentIds) {
    for (const agentId of agentIds) {
      const agent = agentRegistry.getAgent(agentId);
      if (agent && ['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
        agentRegistry.recordActivity(agentId);
      }
    }
  }
}

/**
 * Wires up the PTY stream analyzer events to the agent registry.
 * Should be called after both services are initialized.
 */
export function wireAgentBridge(): void {
  const agentRegistry = getAgentRegistry();
  if (!agentRegistry) {
    logger.warn('Agent registry not available, skipping agent bridge wiring');
    return;
  }

  const streamAnalyzer = getPTYStreamAnalyzer();

  logger.debug('Setting up agent:spawn event listener on streamAnalyzer');

  // Define and store listener for agent:spawn
  registeredListeners.streamAnalyzer.agentSpawn = handleAgentSpawn;
  streamAnalyzer.on('agent:spawn', registeredListeners.streamAnalyzer.agentSpawn);

  // Define and store listener for terminal-exited IPC event
  registeredListeners.ipcMain.terminalExited = handleTerminalExited;
  ipcMain.on('terminal-exited', registeredListeners.ipcMain.terminalExited);

  // Define and store listener for agent:complete
  registeredListeners.streamAnalyzer.agentComplete = handleAgentComplete;
  streamAnalyzer.on('agent:complete', registeredListeners.streamAnalyzer.agentComplete);

  // Define and store listener for agent:activity
  registeredListeners.streamAnalyzer.agentActivity = handleAgentActivity;
  streamAnalyzer.on('agent:activity', registeredListeners.streamAnalyzer.agentActivity);

  logger.info('PTY stream analyzer wired to agent registry');
}

/**
 * Sets up hook server event listeners for debug logging.
 * NOTE: The actual agent creation and hierarchy tracking is done in hookServer.ts handlers.
 * These listeners are for debug logging only.
 */
export function wireHookServerEvents(): void {
  const hookServer = getHookServer();

  // Define and store hook server listeners for cleanup
  registeredListeners.hookServer.sessionStart = (data: SessionStartData) => {
    logger.debug('[MAIN] session:start event received', data);
  };
  hookServer.on('session:start', registeredListeners.hookServer.sessionStart);

  registeredListeners.hookServer.agentStart = (data: AgentHookData) => {
    logger.debug('[MAIN] agent:start event received', data);
  };
  hookServer.on('agent:start', registeredListeners.hookServer.agentStart);

  registeredListeners.hookServer.agentStop = (data: AgentHookData) => {
    logger.debug('[MAIN] agent:stop event received', data);
  };
  hookServer.on('agent:stop', registeredListeners.hookServer.agentStop);

  registeredListeners.hookServer.sessionEnd = (data: SessionEndData) => {
    logger.debug('[MAIN] session:end event received', data);
  };
  hookServer.on('session:end', registeredListeners.hookServer.sessionEnd);

  logger.info('Hook server events connected for debug logging');
}
