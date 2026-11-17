/**
 * routes/runtime-state.ts, the handler for `runtime.state.get`: the daemon's
 * runtime store read through the one snapshot reader (runtime/state-snapshot.ts)
 * the terminal apps' `/state` view also uses.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { readInvocationParams } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { snapshotRuntimeState } from '../../runtime/state-snapshot.js';

/** The domains asked for: a comma-separated string (a GET query) or a list. */
function readDomains(value: unknown): readonly string[] | undefined {
  const names = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const trimmed = names.map((name) => name.trim()).filter((name) => name.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

export function registerRuntimeStateGatewayMethods(catalog: GatewayMethodCatalog, store: { getState(): object }): void {
  attachHandler(catalog, 'runtime.state.get', (invocation) => {
    const domains = readDomains(readInvocationParams(invocation)['domains']);
    return snapshotRuntimeState(store, domains ? { domains } : {});
  });
}
