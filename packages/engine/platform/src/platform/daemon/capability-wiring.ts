/**
 * capability-wiring.ts, where the daemon attaches `capabilities.find` and
 * `capabilities.run` (control-plane/routes/capabilities.ts) to its own
 * stores, its method dispatch and its permission gate.
 */
import type { RuntimeServices } from '../runtime/services.js';
import type { GatewayMethodInvocation } from '../control-plane/method-catalog-shared.js';
import { registerCapabilityGatewayMethods } from '../control-plane/routes/capabilities.js';
import { registerHookTraceGatewayMethods } from '../control-plane/routes/hook-trace.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { daemonCapabilityCatalog, loadedDaemonCapabilityCatalog } from '../capabilities/daemon-catalog.js';
import { presentCapabilityRunAsks } from '../capabilities/ask-words.js';
import { movedCapabilityEntries } from '../capabilities/builtin/index.js';
import { createDaemonCapabilityServices } from '../capabilities/daemon-services.js';
import { shownValues } from '../capabilities/outcome.js';
import { methodInputOf } from '../capabilities/operator-input.js';
import { OWNER_DECIDED_EFFECTS } from '../capabilities/catalog.js';
import { admitEffects } from '../security/effect-authority.js';
import { networkScanGranted, readNetworkScanConsent, startNetworkScan } from '../discovery/network-scan.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { capabilityRunDefinition, CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import type { ToolDefinition } from '../types/tools.js';

/** One call of another method through the daemon's own dispatch, as the caller of the outer call. */
export type DaemonMethodCall = (input: {
  readonly authToken: string;
  readonly methodId: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly context?: {
    readonly clientKind?: string | undefined;
    readonly explicitUserRequest?: boolean | undefined;
    /**
     * The outer call was an administrative operator's: the nested call keeps that (never more than the credential
     * itself holds; the dispatch checks it against the principal again). Without it a method that needs an admin
     * operator (the trigger supervisor's) refused a capability the same caller may run directly.
     */
    readonly admin?: boolean | undefined;
  };
  /**
   * The outer call arrived as the `local` credential (the operator token straight from the daemon's own machine):
   * the nested call is described the same way, so a method that needs a person's request (`owner-request`) sees the
   * person's claim the outer call carried, as it would on a direct call.
   */
  readonly localOrigin?: boolean | undefined;
  /** How the outer call reached the listener (established by the listener, never by the caller), kept for the nested one. */
  readonly transport?: GatewayMethodInvocation['context']['transport'];
  /**
   * The outer call is one of the daemon's own turns (web chat, a scheduled run), made in process with no credential:
   * the nested call is sent with the daemon's own, after the method's declared effects were admitted for that turn's
   * actor here (daemonTurnAdmission). That turn's gate was the one decision; nothing asks again.
   */
  readonly daemonTurn?: boolean | undefined;
}) => Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }>;

/**
 * Whether a call came from one of the daemon's own turns (tools/capability/daemon-tools.ts): made in process, so it
 * carries the turn's actor and no credential.
 */
function fromDaemonTurn(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken && invocation.context.actor !== undefined;
}

/**
 * A daemon turn's nested method call is admitted for that turn's actor (the owner's model) by what the method
 * declares, as a terminal program's turn is when its nested call arrives with the Agent's credential: a method a
 * model never causes is refused here too, and a credential write the owner decided for the capability is his.
 */
function daemonTurnAdmission(runtime: Pick<RuntimeServices, 'gatewayMethods'>, methodId: string, invocation: GatewayMethodInvocation): GatewayVerbError | null {
  const actor = invocation.context.actor!;
  const declared = runtime.gatewayMethods.get(methodId)?.effects ?? [];
  const asModel = declared.filter((effect) => !OWNER_DECIDED_EFFECTS.has(effect));
  const asOwner = declared.filter((effect) => OWNER_DECIDED_EFFECTS.has(effect));
  const model = admitEffects(actor, asModel);
  const admission = model.kind !== 'allowed' || asOwner.length === 0 || !actor.agentFor ? model : admitEffects(actor.agentFor, asOwner);
  if (admission.kind === 'allowed') return null;
  if (admission.kind === 'ask-owner') return new GatewayVerbError(`${methodId} is the owner's to decide (${admission.reason}).`, 'OWNER_ONLY', 403);
  return new GatewayVerbError(`${methodId}: ${admission.reason}. ${admission.next}`, admission.code, 403);
}

function refusalOf(methodId: string, status: number, body: unknown): GatewayVerbError {
  const record = body !== null && typeof body === 'object' ? body as { error?: unknown; code?: unknown; next?: unknown } : {};
  const next = Array.isArray(record.next) ? record.next.filter((step): step is string => typeof step === 'string') : [];
  return new GatewayVerbError(typeof record.error === 'string' ? record.error : `${methodId} answered ${status}`,
    typeof record.code === 'string' ? record.code : 'CAPABILITY_REFUSED', status, undefined, { next });
}

export function registerDaemonCapabilities(runtime: Pick<RuntimeServices, 'gatewayMethods' | 'configManager' | 'hookDispatcher' | 'hookWorkbench' | 'secretsManager' | 'memoryRegistry' | 'permissionManager'
  // The hook trace: the daemon's own runs, and where its file is kept.
  | 'hookActivityTracker' | 'shellPaths'
  // Tools and extensions (capabilities/builtin/tools.ts, mcp.ts): the daemon's web search service and its MCP registry.
  | 'webSearchService' | 'mcpRegistry' | 'pluginManager'
  // The remote runners the daemon holds (capabilities/builtin/remote.ts).
  | 'remoteRunnerRegistry' | 'remoteSupervisor' | 'runtimeStore' | 'runtimeBus' | 'agentManager' | 'judgment'
  // The Agent's own stores (capabilities/builtin/agent-stores.ts).
  | 'agentStores'
  // The daemon's one owner inbox (capabilities/builtin/waiting.ts).
  | 'ownerInbox'
  // Permissions and safety (capabilities/builtin/permissions.ts, security.ts): the rule store, the token audit, the daemon's folder trust.
  | 'userPermissionRuleStore' | 'tokenAuditor' | 'workspaceTrustManager'
  // Memory and knowledge (capabilities/builtin/knowledge.ts): the daemon's one knowledge store.
  | 'knowledgeService'
  // Models and providers (capabilities/builtin/models.ts, services.ts): the provider stack, sign-ins and services file.
  | 'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore' | 'subscriptionManager' | 'serviceRegistry' | 'mediaProviders'>, call: DaemonMethodCall,
  // The daemon's machine-group verbs (capabilities/builtin/cluster.ts), composed by the host after the router.
  composed: { readonly clusterVerbs?: (() => import('./http/cluster-group-routes.js').ClusterGroupVerbs | null) | undefined } = {}): void {
  let runDefinition: Promise<ToolDefinition> | undefined;
  // An ask for a capability_run call, here or raised by a program into this daemon's approvals, reads as the capability's own words.
  const moved = new Map(movedCapabilityEntries().map((entry) => [entry.id, entry] as const));
  presentCapabilityRunAsks((id) => loadedDaemonCapabilityCatalog()?.get(id) ?? moved.get(id));
  const services = createDaemonCapabilityServices({ ...runtime, ...composed });
  // The one network-scan decision is the daemon's (a 3.5.0 Agent's is carried once on this first read); with it given,
  // the daemon scans your network at each start, off the start path (discovery/network-scan.ts).
  try {
    const scanHost = services.networkScan.host();
    if (networkScanGranted(readNetworkScanConsent(scanHost.homeDirectory))) startNetworkScan(scanHost);
  } catch (error) {
    logger.warn('[NetworkScan] the network-scan decision could not be read or carried at start; nothing on the network is scanned', { error: summarizeError(error) });
  }
  // Each terminal program posts the hooks it ran to the daemon's one trace.
  registerHookTraceGatewayMethods(runtime.gatewayMethods, services);
  registerCapabilityGatewayMethods(runtime.gatewayMethods, {
    catalog: daemonCapabilityCatalog,
    services,
    async invokeMethod(methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) {
      // One of the daemon's own turns: admitted here for its actor, then sent with the daemon's own credential.
      const daemonTurn = fromDaemonTurn(invocation);
      if (daemonTurn) {
        const refused = daemonTurnAdmission(runtime, methodId, invocation);
        if (refused) throw refused;
      }
      // A field written `body.<name>` reaches the method's input at `<name>`, as the invoke endpoint reads a request
      // (capabilities/operator-input.ts methodInputOf): for an action's fields, its preview, and a handler's own call.
      const input = methodInputOf(body, runtime.gatewayMethods.get(methodId)?.inputSchema);
      const answer = await call({
        authToken: invocation.context.authToken ?? '', methodId, body: input, ...(daemonTurn ? { daemonTurn: true } : {}),
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        ...(invocation.context.credentialKind === 'local' ? { localOrigin: true } : {}),
        ...(invocation.context.transport ? { transport: invocation.context.transport } : {}),
        context: {
          ...(invocation.context.clientKind ? { clientKind: invocation.context.clientKind } : {}),
          // The person's claim travels to the method only as the daemon kept it for this caller.
          ...(invocation.context.metadata?.['explicitUserRequest'] === true ? { explicitUserRequest: true } : {}),
          ...(invocation.context.admin === true ? { admin: true } : {}),
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
