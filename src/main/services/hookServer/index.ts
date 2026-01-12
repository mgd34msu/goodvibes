// ============================================================================
// HOOK SERVER - Main exports
// ============================================================================

import { HookServerService } from './service.js';

// Re-export types
export type { HookPayload, HookResponse, HookHandler } from './types.js';
export { HOOK_SERVER_PORT, getPayloadValue } from './types.js';

// Import for local use
import { HOOK_SERVER_PORT as DEFAULT_PORT } from './types.js';

// Re-export the service class
export { HookServerService };

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let hookServer: HookServerService | null = null;

export function getHookServer(): HookServerService {
  if (!hookServer) {
    hookServer = new HookServerService();
  }
  return hookServer;
}

export async function startHookServer(): Promise<void> {
  const server = getHookServer();
  await server.start();
}

export async function stopHookServer(): Promise<void> {
  if (hookServer) {
    await hookServer.stop();
  }
}

export function getHookServerStatus(): { running: boolean; port: number } {
  return hookServer?.getStatus() ?? { running: false, port: DEFAULT_PORT };
}
