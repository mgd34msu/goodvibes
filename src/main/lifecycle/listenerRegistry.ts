// ============================================================================
// LISTENER REGISTRY - Event Listener Tracking and Cleanup
// ============================================================================
//
// Manages registration and cleanup of event listeners to prevent memory leaks
// during hot reload and shutdown sequences.
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../services/logger.js';
import { getPTYStreamAnalyzer } from '../services/ptyStreamAnalyzer.js';
import { getHookServer } from '../services/hookServer.js';
import type { MainProcessListeners } from './types.js';

const logger = new Logger('ListenerRegistry');

/**
 * Storage for registered listeners to enable proper cleanup
 */
export const registeredListeners: MainProcessListeners = {
  streamAnalyzer: {
    agentSpawn: null,
    agentComplete: null,
    agentActivity: null,
  },
  hookServer: {
    sessionStart: null,
    agentStart: null,
    agentStop: null,
    sessionEnd: null,
  },
  ipcMain: {
    terminalExited: null,
  },
};

/**
 * Removes all registered listeners from their respective emitters.
 * Should be called during shutdown sequence before shutting down services.
 */
export function removeAllListeners(): void {
  // Remove PTY stream analyzer listeners
  const streamAnalyzer = getPTYStreamAnalyzer();
  if (registeredListeners.streamAnalyzer.agentSpawn) {
    streamAnalyzer.off('agent:spawn', registeredListeners.streamAnalyzer.agentSpawn);
    registeredListeners.streamAnalyzer.agentSpawn = null;
  }
  if (registeredListeners.streamAnalyzer.agentComplete) {
    streamAnalyzer.off('agent:complete', registeredListeners.streamAnalyzer.agentComplete);
    registeredListeners.streamAnalyzer.agentComplete = null;
  }
  if (registeredListeners.streamAnalyzer.agentActivity) {
    streamAnalyzer.off('agent:activity', registeredListeners.streamAnalyzer.agentActivity);
    registeredListeners.streamAnalyzer.agentActivity = null;
  }

  // Remove hook server listeners
  const hookServer = getHookServer();
  if (registeredListeners.hookServer.sessionStart) {
    hookServer.off('session:start', registeredListeners.hookServer.sessionStart);
    registeredListeners.hookServer.sessionStart = null;
  }
  if (registeredListeners.hookServer.agentStart) {
    hookServer.off('agent:start', registeredListeners.hookServer.agentStart);
    registeredListeners.hookServer.agentStart = null;
  }
  if (registeredListeners.hookServer.agentStop) {
    hookServer.off('agent:stop', registeredListeners.hookServer.agentStop);
    registeredListeners.hookServer.agentStop = null;
  }
  if (registeredListeners.hookServer.sessionEnd) {
    hookServer.off('session:end', registeredListeners.hookServer.sessionEnd);
    registeredListeners.hookServer.sessionEnd = null;
  }

  // Remove IPC listeners
  if (registeredListeners.ipcMain.terminalExited) {
    ipcMain.removeListener('terminal-exited', registeredListeners.ipcMain.terminalExited);
    registeredListeners.ipcMain.terminalExited = null;
  }

  logger.info('All main process listeners removed');
}
