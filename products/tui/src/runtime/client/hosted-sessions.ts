import { hostname } from 'node:os';
import { createHostedSessionsClient as create } from '@goodvibes-jev/engine/terminal-shell/hosted-sessions-client';
export * from '@goodvibes-jev/engine/terminal-shell/hosted-sessions-client';
let cachedClientId: string | null = null;
export function terminalHostedClientId(): string { return cachedClientId ??= `tui-${hostname()}-${process.pid}`; }
export function createHostedSessionsClient(verbs: Parameters<typeof create>[0]) { return create(verbs, { clientId: terminalHostedClientId(), surfaceKind: 'tui' }); }
