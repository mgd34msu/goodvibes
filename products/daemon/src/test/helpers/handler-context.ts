/** A real selected workspace for surface fixtures; no account or provider authority. */
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/platform/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import { makeOwnedTempDir } from './owned-temp.js';

export function createHandlerContext(workingDirectory = makeOwnedTempDir('daemon-handler-context')): HandlerContext {
  return { workingDirectory, homeDirectory: workingDirectory, catalog: new GatewayMethodCatalog(),
    configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: workingDirectory, surfaceRoot: 'tui' }),
    credentials: createDaemonCredentialStore({ async get() { return null; }, async set() {} }),
    logger: { info() {}, warn() {}, error() {} } };
}
