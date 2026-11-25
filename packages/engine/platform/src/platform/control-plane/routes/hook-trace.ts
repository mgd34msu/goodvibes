/**
 * routes/hook-trace.ts, the handler of `hooks.trace.post`
 * (method-catalog-hooks.ts): a terminal program's hook runs, added to the
 * daemon's one hook trace (hooks/trace.ts). Each run is read defensively (it
 * came from another process); one that does not read as a run is counted as
 * refused and left out, the rest are kept.
 */
import { resolve } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { HOOK_TRACE_POST_METHOD_ID } from '../method-catalog-hooks.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { readHookTraceRecord, type HookTraceRecord } from '../../hooks/trace.js';
import type { HooksCapabilityServices } from '../../capabilities/builtin/hooks.js';

/** The most runs one post may carry. */
const MAX_RUNS = 100;

export function registerHookTraceGatewayMethods(catalog: GatewayMethodCatalog, services: HooksCapabilityServices): void {
  attachHandler(catalog, HOOK_TRACE_POST_METHOD_ID, async (invocation) => {
    const params = readInvocationParams(invocation);
    const program = params['program'] === 'tui' || params['program'] === 'agent' ? params['program'] : undefined;
    if (!program) throw new GatewayVerbError('program is tui or agent.', 'INVALID_ARGUMENT', 400, 'program');
    const runs = Array.isArray(params['runs']) ? params['runs'] : undefined;
    if (!runs) throw new GatewayVerbError('runs is a list of hook runs.', 'INVALID_ARGUMENT', 400, 'runs');
    if (runs.length > MAX_RUNS) throw new GatewayVerbError(`At most ${MAX_RUNS} runs in one post; this one had ${runs.length}.`, 'INVALID_ARGUMENT', 400, 'runs');
    const project = typeof params['project'] === 'string' && params['project'].trim() ? resolve(params['project'].trim()) : undefined;
    const kept: HookTraceRecord[] = [];
    let refused = 0;
    for (const run of runs) {
      // The program and the project are the post's, never a run's own claim.
      const record = readHookTraceRecord({ ...(run && typeof run === 'object' ? run : {}), program, project });
      if (record) kept.push(record);
      else refused += 1;
    }
    return { recorded: kept.length > 0 ? services.hooks.record(kept) : 0, refused };
  });
}
