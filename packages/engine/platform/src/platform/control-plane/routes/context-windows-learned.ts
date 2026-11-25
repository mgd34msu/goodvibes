/**
 * routes/context-windows-learned.ts, the handler of `context.windows.learned.post`
 * (method-catalog-context-windows.ts): a limit a terminal program's turn learned from a provider, kept in the daemon's
 * one context-window file (capabilities/builtin/context-windows.ts keepLearnedContextWindow). Read defensively: it came
 * from another process.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { CONTEXT_WINDOW_LEARNED_POST_METHOD_ID } from '../method-catalog-context-windows.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { keepLearnedContextWindow, type ContextWindowsCapabilityServices } from '../../capabilities/builtin/context-windows.js';

export function registerContextWindowLearnedGatewayMethods(catalog: GatewayMethodCatalog, services: ContextWindowsCapabilityServices): void {
  attachHandler(catalog, CONTEXT_WINDOW_LEARNED_POST_METHOD_ID, async (invocation) => {
    const params = readInvocationParams(invocation);
    if (params['program'] !== 'tui' && params['program'] !== 'agent') throw new GatewayVerbError('program is tui or agent.', 'INVALID_ARGUMENT', 400, 'program');
    const model = typeof params['model'] === 'string' ? params['model'].trim() : '';
    if (!model) throw new GatewayVerbError('model is the model as provider:model.', 'INVALID_ARGUMENT', 400, 'model');
    const tokens = params['tokens'];
    if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) throw new GatewayVerbError('tokens is a whole number above 0.', 'INVALID_ARGUMENT', 400, 'tokens');
    const outcome = params['outcome'];
    if (outcome !== 'refused' && outcome !== 'accepted') throw new GatewayVerbError('outcome is refused or accepted.', 'INVALID_ARGUMENT', 400, 'outcome');
    return { kept: keepLearnedContextWindow(services.models.providerRegistry, { model, tokens, outcome }) };
  });
}
