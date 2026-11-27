/**
 * routes/policy-audit.ts, the handler of `permissions.audit.post` (method-catalog-policy-audit.ts): the calls a
 * terminal program's gate decided, kept in the daemon's permission audit beside its own (policy-runtime.ts), where a
 * candidate policy is reviewed against them. Each call is read defensively (it came from another process); one that
 * does not read as a decided call is counted as refused and left out. A call's id is prefixed with its program, so
 * two programs' ids never meet.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { POLICY_AUDIT_POST_METHOD_ID } from '../method-catalog-policy-audit.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { PermissionAuditEntry, PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.js';

/** The most calls one post may carry. */
const MAX_CALLS = 100;
/** The longest text kept from a field. */
const MAX_TEXT = 2000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

function when(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One posted call as an audit entry, or undefined when it does not read as one. */
function decidedCallOf(program: 'tui' | 'agent', value: unknown, project: string | undefined): PermissionAuditEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const call = value as Record<string, unknown>;
  const callId = text(call['callId']);
  const tool = text(call['tool']);
  const category = text(call['category']);
  const requestedAt = when(call['requestedAt']);
  if (!callId || !tool || !category || requestedAt === undefined) return undefined;
  const reasons = Array.isArray(call['reasons']) ? call['reasons'].filter((reason): reason is string => typeof reason === 'string').slice(0, 20).map((reason) => reason.slice(0, MAX_TEXT)) : [];
  const decidedAt = when(call['decidedAt']);
  return {
    callId: `${program}:${callId}`,
    tool,
    category,
    ...(typeof call['approved'] === 'boolean' ? { approved: call['approved'] } : {}),
    ...(text(call['sourceLayer']) ? { sourceLayer: text(call['sourceLayer']) } : {}),
    ...(text(call['reasonCode']) ? { reasonCode: text(call['reasonCode']) } : {}),
    riskLevel: text(call['riskLevel']) ?? 'low',
    classification: text(call['classification']) ?? 'unknown',
    summary: text(call['summary']) ?? tool,
    reasons,
    ...(text(call['target']) ? { target: text(call['target']) } : {}),
    ...(text(call['host']) ? { host: text(call['host']) } : {}),
    requestedAt,
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    // The posting program's project, as the dispatch checked it for this caller (never a field of the call itself).
    ...(project ? { project } : {}),
  };
}

export function registerPolicyAuditGatewayMethods(catalog: GatewayMethodCatalog, state: Pick<PolicyRuntimeState, 'recordReportedDecisions'>): void {
  attachHandler(catalog, POLICY_AUDIT_POST_METHOD_ID, async (invocation) => {
    const params = readInvocationParams(invocation);
    const program = params['program'] === 'tui' || params['program'] === 'agent' ? params['program'] : undefined;
    if (!program) throw new GatewayVerbError('program is tui or agent.', 'INVALID_ARGUMENT', 400, 'program');
    const calls = Array.isArray(params['calls']) ? params['calls'] : undefined;
    if (!calls) throw new GatewayVerbError('calls is a list of decided calls.', 'INVALID_ARGUMENT', 400, 'calls');
    if (calls.length > MAX_CALLS) throw new GatewayVerbError(`At most ${MAX_CALLS} calls in one post; this one had ${calls.length}.`, 'INVALID_ARGUMENT', 400, 'calls');
    const kept: PermissionAuditEntry[] = [];
    let refused = 0;
    const project = typeof invocation.context.call?.project === 'string' && invocation.context.call.project.trim() ? invocation.context.call.project.trim() : undefined;
    for (const call of calls) {
      const entry = decidedCallOf(program, call, project);
      if (entry) kept.push(entry);
      else refused += 1;
    }
    return { recorded: state.recordReportedDecisions(kept), refused };
  });
}
