// ============================================================================
// LIFECYCLE MODULE - Main Exports
// ============================================================================
//
// This module manages the application lifecycle including:
// - Single instance lock and protocol handling
// - Initialization of all services
// - Graceful shutdown
// - Event listener tracking and cleanup
// ============================================================================

// Re-export initialization
export { initializeApp } from './initialization.js';

// Re-export shutdown
export {
  performGracefulShutdown,
  getIsShuttingDown,
  setupShutdownHandlers,
} from './shutdown.js';

// Re-export protocol handling
export {
  PROTOCOL_NAME,
  registerProtocol,
  handleProtocolUrl,
  setupSingleInstance,
  setupActivationHandlers,
} from './protocol.js';

// Re-export listener registry
export {
  registeredListeners,
  removeAllListeners,
} from './listenerRegistry.js';

// Re-export agent bridge
export {
  wireAgentBridge,
  wireHookServerEvents,
} from './agentBridge.js';

// Re-export types
export type {
  MainProcessListeners,
  AgentSpawnData,
  AgentCompleteData,
  AgentActivityData,
  SessionStartData,
  AgentHookData,
  SessionEndData,
  TerminalExitedData,
} from './types.js';
