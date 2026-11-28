/**
 * capability-wiring.ts, where the daemon attaches `capabilities.find` and
 * `capabilities.run` (control-plane/routes/capabilities.ts) to its own
 * stores, its method dispatch and its permission gate.
 */
import type { RuntimeServices } from '../runtime/services.js';
import type { GatewayMethodInvocation } from '../control-plane/method-catalog-shared.js';
import { registerCapabilityGatewayMethods } from '../control-plane/routes/capabilities.js';
import type { DaemonControlPlaneHelper } from './control-plane.js';
import { registerHookTraceGatewayMethods } from '../control-plane/routes/hook-trace.js';
import { registerContextWindowLearnedGatewayMethods } from '../control-plane/routes/context-windows-learned.js';
import { registerPolicyAuditGatewayMethods } from '../control-plane/routes/policy-audit.js';
import { attachHandler } from '../control-plane/routes/attach-handler.js';
import { readInvocationParams } from '../control-plane/routes/invocation-params.js';
import { PLACE_COUNTS_METHOD_ID } from '../control-plane/method-catalog-capabilities.js';
import { countPlaces, type CountedPlace } from '../capabilities/place-counts.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { daemonCapabilityCatalog, loadedDaemonCapabilityCatalog } from '../capabilities/daemon-catalog.js';
import { nameCapabilityValuesWith, presentCapabilityRunAsks } from '../capabilities/ask-words.js';
import { movedCapabilityEntries } from '../capabilities/builtin/index.js';
import { createDaemonCapabilityServices } from '../capabilities/daemon-services.js';
import { methodInputOf } from '../capabilities/operator-input.js';
import { createCapabilityOwnerGate, type CallerUsers } from './capability-owner-gate.js';
import { capabilityDecidedMark, runActOf, runCoversOf, takeOwnerApprovalGrant, type OwnerApprovedCallGrant } from '../control-plane/owner-approved-call.js';
import { OWNER_DECIDED_EFFECTS } from '../capabilities/catalog.js';
import { admitEffects } from '../security/effect-authority.js';
import { turnInputParty } from '../security/turn-input-party.js';
import { riskOfDescriptor } from '../control-plane/method-risk.js';
import { conversationExposedNow } from '../security/conversation-exposure.js';
import { ownersYesToThisCall } from '../gate/admitted-decision.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { networkScanGranted, readNetworkScanConsent, startNetworkScan } from '../discovery/network-scan.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { isTerminalProgramRegistration } from '../pairing/terminal-program-registration.js';
import { OUTSIDE_AGENT_ISSUE_METHOD_ID } from '../control-plane/method-catalog-programs.js';
import { issueOutsideAgent, OUTSIDE_AGENT_NAME } from './outside-agent.js';
import { credentialMakerOfInvocation } from '../control-plane/routes/pairing.js';
import { CARRIED_UPLOAD_PURPOSE, CARRIED_UPLOADS_KEPT } from '../capabilities/carried-files.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';

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
    /**
     * A daemon turn on someone else's input: the scopes its caller holds, so the nested call (sent with the daemon's own
     * credential) never reaches past them (the dispatch narrows the credential's scopes to these).
     */
    readonly scopes?: readonly string[] | undefined;
    /** The outer call's project and conversation (method-catalog-shared.ts `CallContext`): the nested call acts in the same project. */
    readonly call?: GatewayMethodInvocation['context']['call'];
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
  /** The owner approved the outer call: this nested call keeps the person's claim the credential cannot make, once. */
  readonly ownerApproved?: OwnerApprovedCallGrant | undefined;
  /**
   * The capability this call is nested in was decided already (owner-approved-call.ts `capabilityDecidedMark`): the
   * dispatch does not decide the method's risk class a second time (method-owner-decision.ts).
   */
  readonly decidedUpstream?: object | undefined;
  /** The query a method call handed to the gate carried (a route's path and query fields), sent again as it came. */
  readonly query?: Record<string, unknown> | undefined;
}) => Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }>;

/**
 * Whether a call came from one of the daemon's own turns (tools/capability/daemon-tools.ts): made in process, so it
 * carries the turn's actor and no credential.
 */
/** The owner's Work methods: their work, its runs and its plans (control-plane/routes/work.ts, native-work-execution.ts). */
import { OWNER_WORK_METHOD } from '../control-plane/owner-work-method.js';

function fromDaemonTurn(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken && invocation.context.actor !== undefined;
}

/**
 * A daemon turn's nested method call is admitted for that turn's actor (the owner's model) by what the method
 * declares, as a terminal program's turn is when its nested call arrives with the Agent's credential: a method a
 * model never causes is refused here too, and a credential write the owner decided for the capability is the owner's.
 */
function daemonTurnAdmission(runtime: Pick<RuntimeServices, 'gatewayMethods'>, methodId: string, invocation: GatewayMethodInvocation): GatewayVerbError | null {
  const actor = invocation.context.actor!;
  const declared = runtime.gatewayMethods.get(methodId)?.effects ?? [];
  // Of what the table refuses a model, the owner's own turn makes only what it makes under their mode (a credential they gave it,
  // a purchase allowed within their limits: effect-authority.ts `MODEL_UNDER_MODE`); everything else no model makes
  // (granting access, a sign-in, a credential, a pairing, the permission rules) stays refused here, in every mode.
  const hisOwn = (effect: (typeof declared)[number]): boolean => OWNER_DECIDED_EFFECTS.has(effect);
  const asModel = declared.filter((effect) => !hisOwn(effect));
  const asOwner = declared.filter(hisOwn);
  const model = admitEffects(actor, asModel);
  const admission = model.kind !== 'allowed' || asOwner.length === 0 || !actor.agentFor ? model : admitEffects(actor.agentFor, asOwner);
  if (admission.kind === 'allowed') return null;
  if (admission.kind === 'ask-owner') return new GatewayVerbError(`${methodId} is the owner's to decide (${admission.reason}).`, 'OWNER_ONLY', 403);
  return new GatewayVerbError(`${methodId}: ${admission.reason}. ${admission.next}`, admission.code, 403);
}

/**
 * The scopes a daemon turn's caller holds (the model's actor, never more than the person it acts for): every scope for
 * an actor that holds all (the owner, an admin), else its own list; an empty list when nothing is known.
 */
function turnCallerScopes(invocation: GatewayMethodInvocation): readonly string[] {
  const actor = invocation.context.actor;
  const held = actor?.scopes;
  const person = actor?.agentFor?.scopes;
  if (held === 'all' && (person === undefined || person === 'all')) return ['*'];
  const own = held === undefined ? [] : held === 'all' ? [...(person as ReadonlySet<string>)] : [...held];
  return person === undefined || person === 'all' ? own : own.filter((scope) => person.has(scope));
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
  // Work (capabilities/builtin/work.ts): the plans before they run, where a proposed piece of work waits.
  | 'workPlans'
  // Work and agents (capabilities/builtin/media-collect.ts): a collected image or video read from the daemon's artifacts.
  | 'artifactStore'
  // The daemon's webhook notifier (capabilities/builtin/notify.ts).
  | 'webhookNotifier'
  // The daemon's channel router and the sends it keeps (capabilities/builtin/channel-send.ts).
  | 'channelSends'
  // The daemon's one owner inbox (capabilities/builtin/waiting.ts).
  | 'ownerInbox'
  // Permissions and safety (capabilities/builtin/permissions.ts, security.ts): the rule store, the token audit, the daemon's folder trust.
  | 'userPermissionRuleStore' | 'tokenAuditor' | 'workspaceTrustManager'
  // Permissions and safety (capabilities/builtin/security-review.ts): the policy state that writes the one activation record.
  | 'policyRuntimeState'
  // Memory and knowledge (capabilities/builtin/knowledge.ts): the daemon's one knowledge store.
  | 'knowledgeService'
  // Models and providers (capabilities/builtin/models.ts, services.ts): the provider stack, sign-ins and services file.
  | 'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore' | 'subscriptionManager' | 'serviceRegistry' | 'mediaProviders'
  // Models and providers (capabilities/builtin/compare.ts): blind model comparisons.
  | 'modelComparisons'
  // An outside caller's call decided under the owner's mode (capability-owner-gate.ts): the owner's approvals and the gate's own parts.
  | 'approvalBroker' | 'policyRuntimeState' | 'featureFlags'
  // Who asks, by name, on the card and to Jev.
  | 'pairingTokens'>, call: DaemonMethodCall,
  // The daemon's machine-group verbs (capabilities/builtin/cluster.ts), composed by the host after the router.
  composed: {
    readonly clusterVerbs?: (() => import('./http/cluster-group-routes.js').ClusterGroupVerbs | null) | undefined;
    /** The places as declared (terminal-shell places/browser.ts, given by the host): `places.counts` counts each. */
    readonly places?: readonly CountedPlace[] | undefined;
    /** The daemon's sign-in users (given by the host): a sign-in that asks is named by its user. */
    readonly users?: CallerUsers | undefined;
  } = {}): void {
  // An ask for a capability_run call, here or raised by a program into this daemon's approvals, reads as the capability's own words.
  const moved = new Map(movedCapabilityEntries().map((entry) => [entry.id, entry] as const));
  presentCapabilityRunAsks((id) => loadedDaemonCapabilityCatalog()?.get(id) ?? moved.get(id), (method) => runtime.gatewayMethods.get(method)?.title);
  // The things an ask's inputs name are shown by their titles: a session the daemon holds, a schedule, a paired device.
  const held = runtime as Partial<Pick<RuntimeServices, 'sessionBroker' | 'automationManager' | 'pairingTokens'>>;
  nameCapabilityValuesWith((list, value) => {
    if (list.includes('session')) return held.sessionBroker?.getSession(value)?.title;
    if (list.startsWith('schedules')) return held.automationManager?.getJob(value)?.name;
    if (list.startsWith('devices.')) return held.pairingTokens?.list().find((token) => token.id === value)?.name;
    return undefined;
  });
  // Merged by property, not spread: a spread reads every getter of the runtime, and the on-demand code index getter
  // would open an index for the daemon's own folder, which is no project.
  const sources = Object.defineProperties(Object.defineProperties({}, Object.getOwnPropertyDescriptors(runtime)),
    Object.getOwnPropertyDescriptors(composed)) as typeof runtime & typeof composed;
  const services = createDaemonCapabilityServices(sources);
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
  // Each terminal program posts a context limit its own turn learned from a provider to the daemon's one file.
  registerContextWindowLearnedGatewayMethods(runtime.gatewayMethods, services);
  // Each terminal program posts the calls its gate decided to the daemon's permission audit, where a candidate policy is reviewed.
  registerPolicyAuditGatewayMethods(runtime.gatewayMethods, runtime.policyRuntimeState);
  const { invokeMethod, invokeMethodCall, sendNested } = daemonNestedMethods(runtime, call);
  // A daemon turn's method by id (or an action with its own method) goes through this same dispatch as a capability's
  // nested method (tools/capability/daemon-tools.ts): one door, with what the dispatch gives and checks.
  runtime.gatewayMethods.setDaemonTurnMethodCall((methodId, body, invocation) => sendNested(methodId, body, undefined, invocation));
  registerCapabilityGatewayMethods(runtime.gatewayMethods, {
    catalog: daemonCapabilityCatalog,
    services,
    invokeMethod,
    invokeMethodCall,
    // An outside caller's call is decided once, under the owner's mode (no folder trust); under Ask me its request waits
    // on the owner's one answer (capability-owner-gate.ts).
    ...createCapabilityOwnerGate(runtime, composed.users ? { users: composed.users } : {}),
    // Files sent with a call (capabilities/carried-files.ts): put in scratch folders in the daemon's own home, owner-only;
    // content larger than one method body arrives ahead as artifact uploads made for it, read once and removed.
    carried: {
      daemonHome: resolveGoodVibesDaemonHome(runtime.shellPaths.homeDirectory),
      uploads: {
        async read(id) {
          const record = runtime.artifactStore.getRecord(id);
          const purpose = (record?.metadata as Record<string, unknown> | undefined)?.['purpose'];
          if (!record || purpose !== CARRIED_UPLOAD_PURPOSE) throw new Error(`artifact ${id} was not uploaded for a carried call`);
          return (await runtime.artifactStore.readContent(id)).buffer;
        },
        drop(id) {
          const purpose = (runtime.artifactStore.getRecord(id)?.metadata as Record<string, unknown> | undefined)?.['purpose'];
          if (purpose === CARRIED_UPLOAD_PURPOSE) runtime.artifactStore.delete(id);
          // Parts whose call never came (its program ended between sending them and the call): past the bound, the oldest
          // go, never by age; a call reading its parts now holds far fewer than the bound.
          for (const stale of runtime.artifactStore.listByPurpose(CARRIED_UPLOAD_PURPOSE).slice(CARRIED_UPLOADS_KEPT)) runtime.artifactStore.delete(stale.id);
        },
      },
    },
    // What a call says it was delegated from, or which session it came from, is believed only from a terminal
    // program's own key for a session that program registered (pairing/terminal-program-registration.ts).
    terminalProgram: (registration) => isTerminalProgramRegistration(runtime.shellPaths.homeDirectory, registration),
    sessionRegistrant: (sessionId) => held.sessionBroker?.registrantOf(sessionId),
  });
  // The outside agent's one credential (daemon/outside-agent.ts): asked for with the operator token on this machine (the
  // `mcp serve` program, a script to this daemon), once per daemon, nothing asked. It holds full operator authority and
  // names any project, as the operator token does.
  attachHandler(runtime.gatewayMethods, OUTSIDE_AGENT_ISSUE_METHOD_ID, async (invocation) => {
    const actor = invocation.context.actor;
    if (invocation.context.credentialKind !== 'local' || (actor?.class !== 'owner' && actor?.class !== 'script') || actor.agentFor !== undefined) {
      throw new GatewayVerbError('Only the operator token on this computer (goodvibes-daemon mcp serve) has the outside agent\'s credential issued.', 'OWNER_ONLY', 403);
    }
    const issued = issueOutsideAgent(resolveGoodVibesDaemonHome(runtime.shellPaths.homeDirectory), runtime.pairingTokens,
      credentialMakerOfInvocation(invocation).madeBy);
    if (!issued.ok) {
      throw new GatewayVerbError(`The outside agent already has its credential from this daemon (the paired device "${OUTSIDE_AGENT_NAME}", ${issued.issued}); it is not issued twice.`,
        'OUTSIDE_AGENT_ISSUED', 409, undefined, { next: ['Revoke it among the paired devices (Devices and network) to have a new one issued on the next start.'] });
    }
    // The credential holds full authority and names any project: the project the server was started in (`project`) is not
    // given or checked; nothing is asked and nothing is refused for it.
    return { id: issued.id, token: issued.token, name: issued.name };
  });
  // Every place's count in one call, each made from the place's own lists read as the same caller (place-counts.ts).
  const places = composed.places ?? [];
  attachHandler(runtime.gatewayMethods, PLACE_COUNTS_METHOD_ID, async (invocation) => {
    const params = readInvocationParams(invocation);
    const program = typeof params['program'] === 'string' ? params['program'] : undefined;
    // The project from the body (the context given by hand), else the calling program's call context: never the daemon's.
    const named = typeof params['workingDirectory'] === 'string' && params['workingDirectory'].trim() ? params['workingDirectory'].trim() : invocation.context.call?.project;
    const workingDirectory = typeof named === 'string' && named.trim() ? named.trim() : undefined;
    const rows = await countPlaces(places, { ...(program ? { program } : {}), ...(workingDirectory ? { workingDirectory } : {}) },
      (method, input) => invokeMethod(method, { ...input }, invocation));
    return { places: rows };
  });
}

/**
 * How a capability's nested method, and a method call the gate allowed, reach the daemon's one dispatch (`call`: the
 * facade's, daemonMethodCallOf): a capability's method (`invokeMethod`), a decided method call as it came
 * (`invokeMethodCall`), and a daemon turn's method by id (`sendNested`).
 */
export function daemonNestedMethods(runtime: Pick<RuntimeServices, 'gatewayMethods'>, call: DaemonMethodCall): {
  readonly invokeMethod: (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) => Promise<unknown>;
  readonly invokeMethodCall: (methodId: string, body: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation) => Promise<unknown>;
  readonly sendNested: (methodId: string, input: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation) => Promise<unknown>;
} {
  const invokeMethod = (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation): Promise<unknown> =>
    sendNested(methodId, methodInputOf(body, runtime.gatewayMethods.get(methodId)?.inputSchema), undefined, invocation);
  // A method call the dispatch handed to the gate (method-owner-decision.ts), run as it came once allowed: its body
  // and query as sent, never read again as a capability's fields.
  const invokeMethodCall = (methodId: string, body: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation): Promise<unknown> =>
    sendNested(methodId, body, query, invocation);
  const sendNested = async (methodId: string, input: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation): Promise<unknown> => {
      const descriptor = runtime.gatewayMethods.get(methodId);
      // A call the owner approved in Waiting for you: the owner's approval is the person's request for its own nested method
      // that needs one, and when the caller is not the owner and the act was the owner's, every nested method of that one call
      // is made with the owner's authority (control-plane/owner-approved-call.ts).
      const ownerApproved = takeOwnerApprovalGrant(invocation, descriptor);
      // One of the daemon's own turns: admitted here for its actor (the owner's, when their approval carries their
      // authority), then sent with the daemon's own credential.
      const daemonTurn = fromDaemonTurn(invocation);
      // The owner's own daemon turn (their web chat, their schedules: security/turn-input-party.ts) uses their Work as they do
      // at their own machine: a Work method nested in it goes as their local credential, so their work is read, started and
      // answered as theirs (its cause recorded as theirs by capabilities.run). Someone else's turn never gets this.
      // And only the owner's own model's: a member's or a device's chat is their model's turn, whoever sent the message there.
      const actingFor = invocation.context.actor?.agentFor ?? invocation.context.actor;
      const ownersTurn = daemonTurn && turnInputParty().party === 'owner' && (actingFor === undefined || actingFor.class === 'owner' || actingFor.class === 'system');
      const ownersWork = ownersTurn && OWNER_WORK_METHOD.test(methodId);
      // A turn of a conversation that read text from outside (this turn or any earlier one: security/conversation-
      // exposure.ts) never acts with the owner's administrative authority on its own calls: what it asks for may be what it read.
      // The owner's yes to a call it asked carries their authority for that one call: in Waiting for you (`ownerApproved`), or at
      // the turn's own gate (gate/admitted-decision.ts `ownersYesToThisCall`: the exact call their card showed, its
      // arguments unchanged, for as long as it runs; every nested method of it, and nothing else of the turn).
      // A read with no effect (its class `none`, its declared effect a read: the owner's triggers listed, an action's preview read
      // before their card is shown) is no act: their own turn reads with their authority after a read from outside too, or a
      // trigger it asks for is refused at its preview before the owner is ever asked, and the owner could not see their own list. Each act
      // is still the owner's to decide at the turn's gate, by the same rule as a schedule after such a read.
      // The user's own daemon turn (web chat, schedule, Work step) has already been
      // authorized by the active permission mode (YOLO, Jev, or Ask me) at its gate.
      const ownersAdmin = ownersTurn;
      if (daemonTurn) {
        const as = ownerApproved?.owner ? { ...invocation, context: { ...invocation.context, actor: ownerApproved.owner } } : invocation;
        const refused = daemonTurnAdmission(runtime, methodId, as);
        if (refused) throw refused;
      }
      // A field written `body.<name>` reaches the method's input at `<name>`, as the invoke endpoint reads a request
      // (capabilities/operator-input.ts methodInputOf): for an action's fields, its preview, and a handler's own call.
      const answer = await call({
        authToken: invocation.context.authToken ?? '', methodId, body: input, ...(query ? { query } : {}), ...(daemonTurn ? { daemonTurn: true } : {}),
        ...(ownerApproved ? { ownerApproved } : {}),
        // The capability (or the method call handed to the gate) was decided already: the method is not decided again.
        // It carries who made the capability's act and how it was decided (a settings write keeps that record).
        // And which classes its decision covered: a method of a stricter class it calls is decided at the dispatch.
        decidedUpstream: capabilityDecidedMark(runActOf(invocation), runCoversOf(invocation)),
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        ...(invocation.context.credentialKind === 'local' || ownersWork ? { localOrigin: true } : {}),
        ...(invocation.context.transport ? { transport: invocation.context.transport } : {}),
        context: {
          ...(invocation.context.clientKind ? { clientKind: invocation.context.clientKind } : {}),
          // The person's claim travels to the method only as the daemon kept it for this caller.
          ...(invocation.context.metadata?.['explicitUserRequest'] === true || ownerApproved?.personRequest === true ? { explicitUserRequest: true } : {}),
          // The owner's own daemon turn (their web chat, their schedule's run, their Work step) acts with their administrative
          // authority, as their own program does: a schedule, a trigger, a watcher, a task in its project. Its gate was the
          // one decision (asked after the turn read text anyone can write, else under the project's settings). Someone
          // else's turn never gets it.
          ...(invocation.context.admin === true || ownersAdmin ? { admin: true } : {}),
          // Someone else's daemon turn never reaches past what its own caller holds (a member's scopes), though the call is
          // sent with the daemon's own credential.
          ...(daemonTurn && !ownersTurn ? { scopes: turnCallerScopes(invocation) } : {}),
          // The caller's project and conversation reach the method it runs (a method capability acts in the caller's project).
          ...(invocation.context.call ? { call: invocation.context.call } : {}),
        },
      });
      if (!answer.ok) throw refusalOf(methodId, answer.status, answer.body);
      return answer.body;
  };
  return { invokeMethod, invokeMethodCall, sendNested };
}

/**
 * The daemon's one dispatch as a capability's nested method reaches it (facade.ts hands it to registerDaemonCapabilities).
 * A nested call is described as the outer one was: the operator token from this machine stays the `local` credential.
 */
export function daemonMethodCallOf(helper: () => Pick<DaemonControlPlaneHelper, 'invokeGatewayMethodCall' | 'describeRequestPrincipal'>,
  ownToken: () => string | null | undefined): DaemonMethodCall {
  return ({ localOrigin, transport, daemonTurn, ...given }) => {
    // A call nested in one of the daemon's own turns carries no credential: it goes with the daemon's own, its
    // effects already admitted for that turn's actor (daemonNestedMethods).
    const input = daemonTurn === true ? { ...given, authToken: ownToken() ?? '' } : given;
    const described = localOrigin === true || transport !== undefined ? helper().describeRequestPrincipal(input.authToken, localOrigin === true) : null;
    const principal = described && transport !== undefined ? { ...described, transport } : described;
    // A call nested in one of the daemon's own turns names that turn's project only (control-plane.ts `daemonTurn`).
    return helper().invokeGatewayMethodCall({ ...input, ...(principal ? { principal } : {}), ...(daemonTurn === true ? { daemonTurn: true as const } : {}) });
  };
}
