/**
 * capability-wiring.ts, where the daemon attaches `capabilities.find` and
 * `capabilities.run` (control-plane/routes/capabilities.ts) to its own
 * stores, its method dispatch and its permission gate.
 */
import type { RuntimeServices } from '../runtime/services.js';
import type { GatewayMethodInvocation } from '../control-plane/method-catalog-shared.js';
import { registerCapabilityGatewayMethods } from '../control-plane/routes/capabilities.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { daemonCapabilityCatalog } from '../capabilities/daemon-catalog.js';
import { createDaemonCapabilityServices } from '../capabilities/daemon-services.js';
import { shownValues } from '../capabilities/outcome.js';
import { capabilityRunDefinition, CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import type { ToolDefinition } from '../types/tools.js';

/** One call of another method through the daemon's own dispatch, as the caller of the outer call. */
export type DaemonMethodCall = (input: {
  readonly authToken: string;
  readonly methodId: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly context?: { readonly clientKind?: string | undefined; readonly explicitUserRequest?: boolean | undefined };
}) => Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }>;

function refusalOf(methodId: string, status: number, body: unknown): GatewayVerbError {
  const record = body !== null && typeof body === 'object' ? body as { error?: unknown; code?: unknown; next?: unknown } : {};
  const next = Array.isArray(record.next) ? record.next.filter((step): step is string => typeof step === 'string') : [];
  return new GatewayVerbError(typeof record.error === 'string' ? record.error : `${methodId} answered ${status}`,
    typeof record.code === 'string' ? record.code : 'CAPABILITY_REFUSED', status, undefined, { next });
}

export function registerDaemonCapabilities(runtime: Pick<RuntimeServices, 'gatewayMethods' | 'configManager' | 'hookDispatcher' | 'hookWorkbench' | 'secretsManager' | 'memoryRegistry' | 'permissionManager'>, call: DaemonMethodCall): void {
  let runDefinition: Promise<ToolDefinition> | undefined;
  registerCapabilityGatewayMethods(runtime.gatewayMethods, {
    catalog: daemonCapabilityCatalog,
    services: createDaemonCapabilityServices(runtime),
    async invokeMethod(methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) {
      const answer = await call({
        authToken: invocation.context.authToken ?? '', methodId, body,
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        context: {
          ...(invocation.context.clientKind ? { clientKind: invocation.context.clientKind } : {}),
          // The person's claim travels to the method only as the daemon kept it for this caller.
          ...(invocation.context.metadata?.['explicitUserRequest'] === true ? { explicitUserRequest: true } : {}),
        },
      });
      if (!answer.ok) throw refusalOf(methodId, answer.status, answer.body);
      return answer.body;
    },
    async gate({ entry, values, signal }) {
      const manager = runtime.permissionManager;
      if (!manager) return { approved: false, reason: 'no permission gate runs in this daemon to ask the owner' };
      runDefinition ??= daemonCapabilityCatalog().then((catalog) => capabilityRunDefinition(catalog.list()));
      const definition = await runDefinition;
      // The owner's card names the capability and its inputs, never a secret value.
      const result = await manager.checkDetailed(CAPABILITY_RUN_TOOL, { id: entry.id, inputs: { ...shownValues(entry, values) } }, undefined, { definition, ...(signal ? { signal } : {}) });
      return { approved: result.approved, ...(result.approved ? {} : { reason: result.detail ?? result.userReason ?? 'the owner did not approve it' }) };
    },
  });
}
