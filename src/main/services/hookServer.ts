// ============================================================================
// HOOK SERVER - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular hookServer/ directory.
//
// ============================================================================

export {
  getHookServer,
  startHookServer,
  stopHookServer,
  getHookServerStatus,
  HookServerService,
  HOOK_SERVER_PORT,
  getPayloadValue,
  type HookPayload,
  type HookResponse,
  type HookHandler,
} from './hookServer/index.js';
