import { realpathSync } from 'node:fs';
import type { OperatorRemoteClient } from '@goodvibes/engine/operator-client';

/**
 * Every Work and work-ledger call a program makes names the project it works in: the daemon keeps a ledger, plans and
 * native work per project and serves the call from the one this folder is (whatever folder the daemon itself runs in).
 * The daemon takes the folder off the body before the method reads it; other calls (who the caller is) are sent as they are.
 */
export function inProjectFolder(invoke: OperatorRemoteClient['invoke'], workspace: string): OperatorRemoteClient['invoke'] {
  const folder = (): string => { try { return realpathSync(workspace); } catch { return workspace; } };
  return (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
    const [method, params, ...rest] = args;
    const routed = typeof method === 'string' && (method.startsWith('workLedger.') || method.startsWith('work.'));
    if (!routed || (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params)))) return invoke(...args);
    return invoke(method, { ...(params as Record<string, unknown> | undefined), workingDirectory: folder() }, ...rest);
  }) as OperatorRemoteClient['invoke'];
}
