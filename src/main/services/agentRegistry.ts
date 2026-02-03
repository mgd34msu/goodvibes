// ============================================================================
// AGENT REGISTRY SERVICE - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular agentRegistry/ directory.
//
// The service has been split into:
// - types.ts: Type definitions and constants
// - lifecycle.ts: Agent spawn, terminate, status operations
// - queries.ts: Get, list, filter, tree operations
// - events.ts: Event handling and background tasks
// - index.ts: Main service class and singleton
//
// ============================================================================

export {
  // Singleton functions
  initAgentRegistry,
  getAgentRegistry,
  shutdownAgentRegistry,
  // Service class
  AgentRegistryService,
  // Types
  type AgentRecord,
  type AgentStatus,
  type AgentSpawnOptions,
  type AgentTreeNode,
  type AgentRegistryEvents,
  type AgentStats,
} from './agentRegistry/index.js';
