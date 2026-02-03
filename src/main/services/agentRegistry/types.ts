// ============================================================================
// AGENT REGISTRY - Types and interfaces
// ============================================================================

import type { AgentRecord, AgentStatus } from '../../database/primitives.js';

// Re-export database types for convenience
export type { AgentRecord, AgentStatus };

// ============================================================================
// SPAWN OPTIONS
// ============================================================================

export interface AgentSpawnOptions {
  name: string;
  cwd: string;
  parentId?: string;
  templateId?: string;
  initialPrompt?: string;
  sessionPath?: string;
}

// ============================================================================
// TREE STRUCTURES
// ============================================================================

export interface AgentTreeNode {
  agent: AgentRecord;
  children: AgentTreeNode[];
}

// ============================================================================
// EVENT TYPES
// ============================================================================

export interface AgentRegistryEvents {
  'agent:spawned': (agent: AgentRecord) => void;
  'agent:ready': (agent: AgentRecord) => void;
  'agent:active': (agent: AgentRecord) => void;
  'agent:idle': (agent: AgentRecord) => void;
  'agent:completed': (agent: AgentRecord) => void;
  'agent:error': (agent: AgentRecord, error: string) => void;
  'agent:terminated': (agent: AgentRecord) => void;
  'agent:activity': (agent: AgentRecord) => void;
}

// ============================================================================
// STATISTICS
// ============================================================================

export interface AgentStats {
  total: number;
  active: number;
  idle: number;
  completed: number;
  error: number;
  byStatus: Record<AgentStatus, number>;
}

// ============================================================================
// HOOK SERVER LISTENER TRACKING
// ============================================================================

export interface HookServerListenerRef {
  event: string;
  listener: (...args: unknown[]) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const ACTIVITY_CHECK_INTERVAL_MS = 10 * 1000; // 10 seconds
export const IDLE_THRESHOLD_MS = 30 * 1000; // 30 seconds without activity = idle
export const STALE_CHECK_INTERVAL_MS = 60 * 1000; // Check for stale agents every minute
export const STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes idle = auto-terminate
export const GARBAGE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const SESSION_MAP_VALIDATION_INTERVAL_MS = 60 * 1000; // Validate session map every 60 seconds
