import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';
import { currentTurn } from '@goodvibes/engine/platform/platform/security';
import { programCallHeadersFor } from '@goodvibes/engine/platform/platform/runtime/client';
import { isServiceMethodId, serviceExpectedOutcome, serviceLifecycleDecision, serviceOutcomeCertified, serviceReceiptEvidence } from './service-lifecycle.js';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { logger, redactStructuredDataAsync, type StructuredRedactionOptions } from '@goodvibes/engine/platform/platform/utils';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { runAnswersEveryQuestion, runHoldsForOwner } from '@goodvibes/engine/platform/platform/permissions';
import { connectedHostRequestDeadline, DECIDED_IN_RUN_HEADER, type ConnectedHostConfigReader as AgentConnectedHostConfigReader, type RequestDeadline } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { assertOperatorEffect, captureOperatorConnection } from './operator-connection-owner.js';
import { forgetDelegatedCredential } from './agent-delegation-credential.js';
import { agentCallConnection, agentCallCredential } from './agent-call-credential.js';
import { NATIVELY_ADMITTED_METHOD_IDS } from '@goodvibes/engine/platform/platform/control-plane';
import { movedCapabilityEntries } from '@goodvibes/engine/platform/platform/capabilities';

/**
 * The daemon methods a capability that only tightens a protection runs through (its definition's `tightens: true`,
 * reached by capability_run through this tool): such a call is never refused or asked about, in any folder or mode.
 */
function tighteningMethodIds(): readonly string[] {
  return movedCapabilityEntries().flatMap((entry) => (entry.tightens === true && entry.method ? [entry.method.id] : []));
}
import { publishOperatorMethodReceipt } from './operator-method-receipt.js';
import { appendOperatorQuery, operatorContractMethods, operatorMethodIsReadOnly, operatorOwnerDecisions, ownerOnlyOperatorMethodIds, READ_ONLY_HTTP_METHODS, resolveOperatorContractMethod, substituteOperatorPath } from './operator-contract-routes.js';
import { createOperatorInputProjector, operatorExecutionConnection, operatorExecutionWireInput, operatorExecutionRequestPolicy, operatorMethodIsOutward, operatorMethodIsOwnerOnly } from './operator-input-projector.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { readFlag, readString } from './tool-args.js';
import { declaredMethodRisk, RUNS_LATER_METHOD_IDS, type MethodRisk } from '@goodvibes/engine/platform/platform/control-plane';
import type { ToolDefinition } from '@goodvibes/engine/platform/platform/types';

type ToolOwnerActs = NonNullable<ToolDefinition['ownerActs']>;
type ToolOwnerDecisions = NonNullable<ToolDefinition['ownerDecisions']>;

/** The mark the daemon reads as "the program's gate decided this call" (daemon-api control-routes.ts). */
const CAPABILITY_GATE_DECIDED_HEADER = 'x-goodvibes-decided-by-capability-gate';

type JsonRecord = Record<string, unknown>;
/** The response fields a result declares, as the redaction reads them. */
type DeclaredFields = NonNullable<StructuredRedactionOptions['declaredFields']>;

interface OperatorContractMethod {
  readonly id: string;
  readonly title?: string | undefined;
  readonly category?: string | undefined;
  readonly access?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly http?: {
    readonly method?: string | undefined;
    readonly path?: string | undefined;
  } | undefined;
  readonly invokable?: boolean | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
}

interface OperatorMethodToolArgs {
  readonly methodId?: unknown;
  readonly input?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly dryRun?: unknown;
}

interface PreparedOperatorRoute {
  readonly method: OperatorContractMethod;
  readonly httpMethod: string;
  readonly path: string;
  readonly payload: JsonRecord;
  /** The method has no REST route of its own: sent to the generic invoke endpoint, its input wrapped as `{ body }`. */
  readonly invokeEndpoint?: true | undefined;
}

/** Where a method with no REST route of its own is invoked over HTTP (the same endpoint every client uses). */
function genericInvokePath(methodId: string): string {
  return `/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`;
}

type WatcherMethodId =
  | 'watchers.create'
  | 'watchers.update'
  | 'watchers.run'
  | 'watchers.start'
  | 'watchers.stop'
  | 'watchers.delete';

// Inside the owner's limits the Agent starts and stops purchases itself. The daemon takes these only
// with the owner-request signal; this tool sends it after this call's own admission passed, never
// because an argument asked for it.
const AGENT_PURCHASE_METHOD_IDS = new Set(['payments.checkout.begin', 'payments.purchase.cancel']);

/**
 * A begin carries the session of the turn that makes it (`askedInSession`),
 * so the purchase window names the chat it came from. Only the turn sets it:
 * a value the model wrote is dropped, and a call outside a turn sends none.
 */
function withAskingSession(payload: Record<string, unknown>): Record<string, unknown> {
  const { askedInSession: _modelWritten, ...rest } = payload;
  const sessionId = currentTurn()?.sessionId;
  return sessionId ? { ...rest, askedInSession: sessionId } : rest;
}
// The profile tool owns these reads and its disclosure rules; the generic path has none of them.
const PROFILE_TOOL_ONLY_METHOD_IDS = new Set(['profile.read', 'profile.person', 'profile.get', 'profile.provenance']);
// Profile writes state their provenance (`authority: "autonomous"`, no quote).
// Which credential every call here presents is agent-call-credential.ts's rule.
const AUTONOMOUS_PROFILE_METHOD_IDS = new Set([
  'profile.set', 'profile.append', 'profile.forget', 'profile.undo',
  'occasions.confirm', 'occasions.plans.confirm', 'occasions.remove',
]);
const PROFILE_QUOTE_METHOD_IDS = new Set([
  'profile.set', 'profile.append', 'occasions.confirm', 'occasions.plans.confirm',
]);
const WATCHER_METHOD_IDS = new Set<string>([
  'watchers.create',
  'watchers.update',
  'watchers.run',
  'watchers.start',
  'watchers.stop',
  'watchers.delete',
]);

/** Where the owner does the refused act himself in the Agent app, named for what was refused. */
function ownerActRoute(methodId: string): string {
  if (methodId === 'inbox.answer') return 'he answers it in Waiting for you, in either terminal program or the web UI.';
  if (methodId === 'approvals.approve' || methodId === 'approvals.deny') {
    return 'he answers it at the approval prompt, in Waiting for you, or in the web UI.';
  }
  return 'he grants or withdraws access himself, from his own app\'s settings or the web UI.';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneInput(input: unknown): JsonRecord {
  if (!isRecord(input)) return {};
  // Path substitution consumes only this transport-owned mutable top level.
  return { ...captureStrictJudgmentJson(input) };
}

function prepareOperatorRoute(method: OperatorContractMethod, input: unknown): PreparedOperatorRoute {
  const httpMethod = method.http?.method?.toUpperCase();
  const pathTemplate = method.http?.path;
  const payload = cloneInput(input);
  // A method served only through the gateway (no REST route) is reached at the generic invoke endpoint.
  if (!httpMethod || !pathTemplate) return { method, httpMethod: 'POST', path: genericInvokePath(method.id), payload, invokeEndpoint: true };
  // The one path builder: it also refuses '', '.' and '..' as a path value, which URL parsing
  // would collapse into another route than the one admitted.
  const path = substituteOperatorPath(pathTemplate, payload);
  return { method, httpMethod, path, payload };
}

function isWatcherMethodId(methodId: string): methodId is WatcherMethodId {
  return WATCHER_METHOD_IDS.has(methodId);
}

function watcherSuccessCriteria(methodId: WatcherMethodId): readonly string[] {
  if (methodId === 'watchers.delete') {
    return [
      'The daemon returns ok:true for watchers.delete.',
      'The watcher receipt reports removed:true.',
      'Verify with watchers.list before recreating or assuming no trigger remains.',
    ];
  }
  const action = methodId.split('.')[1] ?? 'watcher';
  return [
    `The daemon returns ok:true for ${methodId}.`,
    'The watcher receipt includes id, label, kind, state, source, and metadata.',
    'The watcher receipt has no lastError.',
    `Verify with watchers.list before retrying ${action} or assuming the trigger is active.`,
  ];
}

function watcherExpectedOutcome(methodId: WatcherMethodId): JsonRecord {
  const target = methodId === 'watchers.create'
    ? 'created-visible-watcher'
    : methodId === 'watchers.update'
      ? 'updated-visible-watcher'
      : methodId === 'watchers.run'
        ? 'triggered-watcher-run'
        : methodId === 'watchers.start'
          ? 'started-watcher'
          : methodId === 'watchers.stop'
            ? 'stopped-watcher'
            : 'deleted-watcher';
  return {
    target,
    successCriteria: watcherSuccessCriteria(methodId),
    evidenceFields: ['id', 'kind', 'label', 'state', 'source.kind', 'source.enabled', 'sourceStatus', 'lastCheckpoint', 'lastError'],
    verificationRoute: 'agent_operator_method methodId:"watchers.list"',
    recoveryRoute: 'autonomy action:"intake" query:"watcher trigger" includeParameters:true',
  };
}

function summarizePreview(route: PreparedOperatorRoute): JsonRecord {
  const readOnly = operatorMethodIsReadOnly(route.method, route.payload) && !operatorMethodIsOutward(route.method.id);
  const preview: JsonRecord = {
    methodId: route.method.id,
    title: route.method.title ?? route.method.id,
    category: route.method.category ?? 'uncategorized',
    access: route.method.access ?? 'authenticated',
    scopes: route.method.scopes ?? [],
    route: `${route.httpMethod} ${route.path}`,
    effect: readOnly
      ? 'read-only-network'
      : route.method.access === 'admin'
        ? 'admitted-admin-connected-host-state'
        : 'admitted-connected-host-state',
    confirmationRequired: false,
    admissionRequired: !readOnly,
    body: READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? undefined : route.payload,
    query: READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? route.payload : undefined,
  };
  if (isServiceMethodId(route.method.id)) preview.expectedOutcome = { ...serviceExpectedOutcome(route.method.id) };
  if (isWatcherMethodId(route.method.id)) preview.expectedOutcome = watcherExpectedOutcome(route.method.id);
  return preview;
}

async function stringifyOutput(value: unknown, options: StructuredRedactionOptions = {}): Promise<string> {
  const protectedOutput = await redactStructuredDataAsync(value, options);
  if (!isRecord(protectedOutput)) throw new Error('Connected operator output could not be projected safely.');
  const text = JSON.stringify(protectedOutput, null, 2);
  return text;
}

/** The admitted native method declares its response structure. Unknown extension
 * fields stay withheld; declared strings still undergo all egress checks. */
function operatorResultFields(method: OperatorContractMethod): DeclaredFields {
  type Declaration = DeclaredFields[number];
  const fields = new Map<string, Declaration>();
  const add = (path: readonly string[], kind: Declaration['kind'] = 'content') => {
    const key = JSON.stringify(path);
    if (fields.get(key)?.kind !== 'secret') fields.set(key, { path, kind });
  };
  for (const name of ['methodId', 'status', 'ok', 'route', 'effect', 'body', 'outcome', 'preview', 'dryRun']) add([name]);
  // These are constructed here, independently of the connected host body.
  const previewFields = ['methodId', 'title', 'category', 'access', 'scopes', 'route', 'effect',
    'confirmationRequired', 'admissionRequired', 'body', 'query', 'expectedOutcome'];
  for (const name of previewFields) add(['preview', name]);
  const outcomeFields = ['kind', 'status', 'certified', 'methodId', 'evidence', 'expectedOutcome', 'lifecycleDecision', 'nextStep'];
  for (const name of outcomeFields) add(['outcome', name]);
  const expectedFields = ['target', 'successCriteria', 'evidenceFields', 'verificationRoute', 'recoveryRoute'];
  for (const path of [['preview', 'expectedOutcome'], ['outcome', 'expectedOutcome']]) {
    for (const name of expectedFields) add([...path, name]);
  }
  const evidenceFields = ['receipt', 'installed', 'autostart', 'running', 'pid', 'lastAction', 'actionError',
    'controlPlaneReady', 'id', 'kind', 'label', 'state', 'sourceKind', 'sourceEnabled',
    'sourceStatus', 'lastCheckpoint', 'lastError'];
  for (const path of [['outcome', 'evidence'], ['outcome', 'lifecycleDecision', 'evidence']]) {
    for (const name of evidenceFields) add([...path, name]);
  }
  for (const name of ['status', 'action', 'reason', 'evidence', 'statusRoute', 'setupRoute', 'modelRoute', 'methodId']) {
    add(['outcome', 'lifecycleDecision', name]);
  }
  const pending = [{ schema: method.outputSchema, path: ['body'] },
    { schema: method.inputSchema, path: ['preview', 'body'] },
    { schema: method.inputSchema, path: ['preview', 'query'] }];
  while (pending.length) {
    const { schema, path } = pending.pop()!;
    if (!isRecord(schema)) continue;
    if (isRecord(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = [...path, name];
      add(childPath, isRecord(child) && child.writeOnly === true ? 'secret' : 'content');
      if (isRecord(child)) pending.push({ schema: child, path: childPath });
    }
    if (isRecord(schema.items)) pending.push({ schema: schema.items, path: [...path, '*'] });
    for (const union of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[union])) {
      for (const child of schema[union]) if (isRecord(child)) pending.push({ schema: child, path });
    }
  }
  // These paths come from the captured native schema. Retain their immutable
  // ownership so egress need not recapture the same declarations per field.
  return captureStrictJudgmentJson([...fields.values()]);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  if (!isServiceMethodId(methodId)) return undefined;
  const certified = serviceOutcomeCertified(methodId, responseOk, body);
  return {
    kind: 'service-repair-receipt',
    status: !responseOk
      ? 'failed'
      : certified
        ? 'certified'
        : 'needs-follow-up',
    certified,
    methodId,
    evidence: serviceReceiptEvidence(body),
    expectedOutcome: { ...serviceExpectedOutcome(methodId) },
    lifecycleDecision: serviceLifecycleDecision(methodId, responseOk, body),
    nextStep: certified
      ? 'Inspect services.status or connected-host status to confirm the setup wizard can advance.'
      : 'Inspect services.status and connected-host setup posture before retrying a lifecycle mutation.',
  };
}

function watcherReceiptEvidence(body: unknown): JsonRecord {
  if (!isRecord(body)) return { receipt: 'not-json-object' };
  const source = isRecord(body.source) ? body.source : {};
  return {
    id: typeof body.id === 'string' ? body.id : null,
    kind: typeof body.kind === 'string' ? body.kind : null,
    label: typeof body.label === 'string' ? body.label : null,
    state: typeof body.state === 'string' ? body.state : null,
    sourceKind: typeof source.kind === 'string' ? source.kind : null,
    sourceEnabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    sourceStatus: typeof body.sourceStatus === 'string' ? body.sourceStatus : null,
    lastCheckpoint: typeof body.lastCheckpoint === 'string' ? body.lastCheckpoint : null,
    lastError: typeof body.lastError === 'string' ? body.lastError : null,
  };
}

function watcherOutcomeCertified(methodId: WatcherMethodId, responseOk: boolean, body: unknown): boolean {
  if (!responseOk || !isRecord(body)) return false;
  if (methodId === 'watchers.delete') return body.removed === true;
  if (typeof body.lastError === 'string' && body.lastError.trim()) return false;
  return typeof body.id === 'string'
    && typeof body.kind === 'string'
    && typeof body.label === 'string'
    && typeof body.state === 'string'
    && isRecord(body.source);
}

function watcherOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  if (!isWatcherMethodId(methodId)) return undefined;
  const certified = watcherOutcomeCertified(methodId, responseOk, body);
  return {
    kind: 'watcher-receipt',
    status: !responseOk
      ? 'failed'
      : certified
        ? 'certified'
        : 'needs-follow-up',
    certified,
    methodId,
    evidence: watcherReceiptEvidence(body),
    expectedOutcome: watcherExpectedOutcome(methodId),
    nextStep: certified
      ? 'Inspect watchers.list or autonomy action:"queue" to verify the trigger remains visible and scoped.'
      : 'Inspect watchers.list and autonomy action:"intake" before retrying watcher setup or run control.',
  };
}

function operatorOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  return serviceOutcome(methodId, responseOk, body)
    ?? watcherOutcome(methodId, responseOk, body);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The contract's methods by their risk class (platform control-plane/method-risk.ts), read once. */
function methodsOfRisk(...risks: readonly MethodRisk[]): readonly string[] {
  return operatorContractMethods().map((method) => method.id).filter((id) => risks.includes(declaredMethodRisk(id, 'read') ?? 'none'));
}

/** The owner's own acts among the methods: refused to a model when it never calls them, else put to the owner. */
function methodOwnerActs(): ToolOwnerActs {
  // An answer to something addressed to the owner is never a model's: refused, never asked (method-risk.ts).
  const refused = [...new Set([...ownerOnlyOperatorMethodIds(), ...methodsOfRisk('answers-the-owner')])];
  // An owner's act the daemon admits natively for his model's own call (his profile, his replies to an occasion's nudge)
  // is decided there, once, under his mode (`hostDecides`): not asked here as well.
  const hostDecided = (id: string): boolean => NATIVELY_ADMITTED_METHOD_IDS.has(id) && agentCallCredential(id, 'agent') === 'delegated';
  const asked = methodsOfRisk('owner-act').filter((id) => !refused.includes(id) && !hostDecided(id));
  return { field: 'methodId', values: [...refused, ...asked], asked };
}

/** What the owner decides among the methods a model names: the contract's declarations and each method's risk class. */
function methodOwnerDecisions(): ToolOwnerDecisions {
  const declared = operatorOwnerDecisions('methodId', 'input');
  return {
    ...declared,
    irreversible: [...new Set([...declared.irreversible, ...methodsOfRisk('cannot-be-undone')])],
    loosens: methodsOfRisk('loosens-a-protection', 'writes-a-secret'),
    // What runs by itself later is never made unasked from what the turn read (permissions/manager.ts `callFacts`).
    runsLater: operatorContractMethods().map((method) => method.id).filter((id) => RUNS_LATER_METHOD_IDS.has(id)),
    // What spends money: asked each time once the conversation read text from outside, as the daemon's own turns
    // decide it (tools/capability/daemon-tools.ts `sendsOrSpends`).
    sendsOrSpends: methodsOfRisk('spends-money'),
  };
}

export function createAgentOperatorMethodTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): Tool {
  return {
    definition: {
      name: 'agent_operator_method',
      activity: { doing: 'Calling', did: 'called', object: 'the assistant service' },
      description: 'Invoke a GoodVibes daemon operator method under current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          methodId: {
            type: 'string',
            description: 'Exact operator method id, for example services.status.',
          },
          input: {
            type: 'object',
            description: 'Method input; path keys are removed before query/body.',
            additionalProperties: true,
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
          dryRun: {
            type: 'boolean',
            description: 'Preview the route without calling the daemon.',
          },
        },
        required: ['methodId'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      // Folded into capability_run (capability-tools.ts): the model names a capability or a method there, and
      // capability_run and the schedule tools call this one nested, so its admission and credentials stay one path.
      nestedOnly: true,
      // A method a model never calls stays refused; one whose risk class is the owner's own act (platform
      // control-plane/method-risk.ts) is put to him, opening on No, as a capability that is his own act is.
      ownerActs: methodOwnerActs(),
      // A method the daemon admits natively for the Agent's credential, and sent with it: the daemon's admission is
      // the one decision, so this gate does not decide it first.
      hostDecides: { field: 'methodId', values: [...NATIVELY_ADMITTED_METHOD_IDS].filter((methodId) => agentCallCredential(methodId, 'agent') === 'delegated') },
      // Irreversible methods, contract changes and sends to a recipient nobody allowed are the owner's to decide; so is a
      // method whose risk class loosens a protection or writes a secret, or cannot be undone, as the capability doing
      // the same act is. This gate's decision is the one: the call says so to the daemon (CAPABILITY_GATE_DECIDED_HEADER).
      ownerDecisions: methodOwnerDecisions(),
      // A method reached only to tighten a protection (an "always allow" grant revoked) is never refused or asked about.
      tightens: { field: 'methodId', values: tighteningMethodIds() },
    },
    execute: async (rawArgs, options) => {
      let args: OperatorMethodToolArgs;
      try { args = isRecord(rawArgs) ? captureStrictJudgmentJson(rawArgs) : {}; }
      catch { return { success: false, error: 'Operator method arguments must be plain JSON data.' }; }
      options?.signal?.throwIfAborted();
      const methodId = readString(args.methodId);
      if (!methodId) return { success: false, error: 'methodId is required.' };
      const method = resolveOperatorContractMethod(methodId);
      if (!method) {
        return {
          success: false,
          error: `Unknown GoodVibes operator method '${methodId}'. Inspect host action:"methods" first.`,
        };
      }
      // The owner's own acts (the method descriptor's ownerOnly) are refused with the way the owner does each one.
      if (operatorMethodIsOwnerOnly(method.id) && !method.id.startsWith('payments.')) {
        return {
          success: false,
          error: `operator method '${method.id}' (${method.title ?? method.id}) is the owner's own act: answering what was put to him, or granting or withdrawing access, so a call the model makes is refused whatever approved it. Nothing was sent. Tell the owner what is waiting; ${ownerActRoute(method.id)}`,
        };
      }
      if (operatorMethodIsOwnerOnly(method.id)) {
        return {
          success: false,
          error: `operator method '${method.id}' is the owner's own act (answering a purchase window, typing a card security code, recording what the merchant history shows, or approving a purchase in advance). Nothing was sent. Ask the owner: Waiting for you, under Purchases, answers windows and codes and records what the merchant history shows, "Approve one purchase ahead of time" in the Money place approves a purchase in advance, and the web UI Purchases panel does both. payments.purchase.status and payments.purchases.list can be read here to tell him where it stands; payments.checkout.begin and payments.purchase.cancel can be called here. Standing authorisations for scheduled purchases are his to add with "Allow a repeat purchase" in the Money place; payments.standing.list can be read here, and a scheduled begin names one as standingId.`,
        };
      }
      // A capability's risk is read from the capability itself, by capability_run; through this tool it would not be.
      if (method.id.startsWith('capabilities.')) {
        return { success: false, error: `operator method '${method.id}' is reached through capability_run, which reads each capability's own risk; call capability_run with the capability's id instead. Nothing was sent.` };
      }
      // A question's asker is whoever posted it: a model posting one names no session or agent as the asker (the owner's
      // answer would be delivered into a conversation that did not ask). Its own questions go through the query tool.
      const postedMetadata = method.id === 'inbox.post' && isRecord(args.input) && isRecord(args.input['metadata']) ? args.input['metadata'] : undefined;
      if (postedMetadata && ['answerSession', 'answerAgent', 'askerSessionFile', 'askerHost'].some((key) => postedMetadata[key] !== undefined)) {
        return { success: false, error: 'inbox.post with answerSession, answerAgent, askerSessionFile or askerHost is refused: a question names its asker by who posts it, so a model cannot name another conversation as the one asking. Nothing was sent. Ask the owner with the query tool; its answer comes back into this conversation.' };
      }
      if (PROFILE_TOOL_ONLY_METHOD_IDS.has(method.id)) {
        return {
          success: false,
          error: `operator method '${method.id}' is not callable through agent_operator_method: it returns the owner's personal profile data, which only the profile tool may read (it withholds the People section and requires the owner's own words to name a person). Call the profile tool with action:"read", "get", "person" or "provenance" instead.`,
        };
      }
      // Capability-advertisement honesty: the operator contract marks a
      // cataloged-but-not-route-backed method invokable:false (email.inbox.list,
      // email.send, etc., see @goodvibes/engine/platform's method-catalog-route-reconcile).
      // Refuse here, before prepareOperatorRoute/fetch, rather than letting the
      // model discover a bare 404 from a route that was never wired up. The ad
      // must degrade at the source, not rely on the model coping with a 404.
      if (method.invokable === false) {
        return {
          success: false,
          error: `operator method '${method.id}' is unavailable (route not served by this daemon). Do not retry it; the daemon has not wired this capability up.`,
        };
      }

      let route: PreparedOperatorRoute;
      let methodSnapshot: OperatorContractMethod;
      try {
        methodSnapshot = captureStrictJudgmentJson(method);
        route = prepareOperatorRoute(methodSnapshot, args.input);
      } catch (error) {
        return { success: false, error: summarizeError(error) };
      }

      if (methodSnapshot.id === 'occasions.remove' && route.payload.confirmed !== true) {
        // Removal drops the date with its answers and gift history, which nothing restores: the owner says yes once.
        // Refused here so an unconfirmed call costs no effect admission and no request.
        return { success: false, error: `Not removed: ${String(route.payload.occasionId ?? 'this occasion')} and everything recorded against it cannot be restored, so the owner confirms once. Ask him once, then call occasions.remove again with input.confirmed:true and input.line set to the occasion's text from occasions.list (only that line is removed). One question, not a negotiation.` };
      }
      const preview = summarizePreview(route);
      if (readFlag(args.dryRun, 'dryRun', false)) {
        try {
          const output = await stringifyOutput({ preview, dryRun: true }, { declaredFields: operatorResultFields(methodSnapshot), signal: options?.signal, assertCurrent: () => {
            options?.signal?.throwIfAborted(); assertCurrentToolInvocation(rawArgs, options);
          } });
          return { success: true, output };
        } catch { return { success: false, error: 'Connected operator preview could not be projected safely.' }; }
      }

      const requiresEffect = !operatorMethodIsReadOnly(methodSnapshot, args.input) || operatorMethodIsOutward(methodSnapshot.id);
      if (requiresEffect && options === undefined) {
        return { success: false, error: 'Connected operator effects require current recorded effect admission.' };
      }

      const readOnlyHttp = READ_ONLY_HTTP_METHODS.has(route.httpMethod);
      // Once the request is on the wire a throw no longer means "not done": a write may have landed.
      let stage: 'before-send' | 'sending' | 'answered' = 'before-send';
      let httpStatus: number | undefined;
      let bounded: RequestDeadline | undefined;
      try {
        const assertInvocation = () => {
          options?.signal?.throwIfAborted();
          if (requiresEffect) assertOperatorEffect(rawArgs, options, operatorMethodIsOutward(methodSnapshot.id));
          else assertCurrentToolInvocation(rawArgs, options);
        };
        assertInvocation();
        const projectedConnection = operatorExecutionConnection(rawArgs, options, shellPaths, configManager, 'method');
        if (!projectedConnection && requiresEffect) throw new Error('Connected operator effects require a registered source projection.');
        const connection = projectedConnection ?? captureOperatorConnection(shellPaths, configManager, assertInvocation, inProcess);
        const assertCurrent = () => { assertInvocation(); connection.assertCurrent(); };
        if (!connection.token) return { success: false, error: `auth_required: ${connection.unavailable?.reason ?? 'no connected-host operator token found'}.` };
        const retainedPayload = operatorExecutionWireInput(route.payload, rawArgs, options, shellPaths, configManager, 'method');
        const wirePayload = AUTONOMOUS_PROFILE_METHOD_IDS.has(methodSnapshot.id)
          ? { ...retainedPayload, authority: 'autonomous',
            ...(PROFILE_QUOTE_METHOD_IDS.has(methodSnapshot.id) ? { said: '' } : {}) }
          : methodSnapshot.id === 'payments.purchase.cancel' ? { ...retainedPayload, confirm: true }
            : methodSnapshot.id === 'payments.checkout.begin' ? withAskingSession(retainedPayload) : retainedPayload;
        // The Agent's call: its delegated credential for a write it makes for the owner, its ordinary one otherwise.
        const { delegated } = await agentCallConnection(connection, methodSnapshot.id, 'agent', shellPaths.homeDirectory, options?.signal);
        const bearer = delegated?.token ?? connection.token;
        // A begin naming the owner's standing authorisation is a purchase nobody asked for now (a
        // scheduled or triggered run): the entry is its authority, so it claims no owner request.
        const ownerRequest = AGENT_PURCHASE_METHOD_IDS.has(methodSnapshot.id)
          && !(methodSnapshot.id === 'payments.checkout.begin' && typeof wirePayload.standingId === 'string');
        // A read-only HTTP method carries its input in the query, so the query is built from the
        // same payload that is screened below, not from the pre-projection one.
        const requestPath = readOnlyHttp ? appendOperatorQuery(route.path, wirePayload) : route.path;
        if (requiresEffect) {
          const requestPolicy = operatorExecutionRequestPolicy(rawArgs, options, shellPaths, configManager, 'method');
          if (!requestPolicy) throw new Error('Connected operator source policy is unavailable.');
          await requestPolicy.screen({ toolName: 'agent_operator_method', methodId: methodSnapshot.id,
            endpoint: `${connection.baseUrl}${requestPath}`, payload: wirePayload }, { signal: options?.signal, assertCurrent });
        }
        // The owner-request signal for a purchase rides only on a call whose admission was just confirmed here.
        assertCurrent();
        stage = 'sending';
        // A method the daemon admits natively may wait there for the owner's answer to its question: no time limit
        // decides a permission question, so only the turn ends that wait. Any other request a host takes and never
        // answers ends at the deadline, not the turn.
        const nativelyAdmitted = NATIVELY_ADMITTED_METHOD_IDS.has(methodSnapshot.id);
        bounded = nativelyAdmitted ? undefined : connectedHostRequestDeadline(readOnlyHttp, options?.signal);
        // A run whose script answers every question decided this call here (its gate put it to the script): it is sent
        // saying so, and the daemon does not put it to the owner a second time (permissions/run-answerer.ts).
        // A run nobody answers decided it here too (what the owner must decide was held for him before it got here).
        const decidedHere = nativelyAdmitted && (runAnswersEveryQuestion() || runHoldsForOwner());
        // This program's call context and the registration this daemon issued it (call-context.ts), sent only to it.
        const programHeaders = await programCallHeadersFor(connection.baseUrl, bearer, connection.fetch ?? fetch);
        // The connection's own transport: the network, or the daemon's request path in a turn it hosts.
        const response = await (connection.fetch ?? fetch)(`${connection.baseUrl}${requestPath}`, {
          ...(bounded ? { signal: bounded.signal } : options?.signal ? { signal: options.signal } : {}),
          redirect: 'error',
          method: route.httpMethod,
          headers: {
            authorization: `Bearer ${bearer}`,
            // The program's call context (its project and conversation), when a terminal program set one (call-context.ts).
            ...programHeaders,
            ...(READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? {} : { 'content-type': 'application/json' }),
            ...(ownerRequest ? { 'x-goodvibes-explicit-user-request': 'true' } : {}),
            ...(decidedHere ? { [DECIDED_IN_RUN_HEADER]: 'true' } : {}),
            // This program's gate decided this call (it was admitted as this tool's call, by the method's own risk class):
            // the daemon takes it so from the Agent's credential or this program's own registration, and does not put it
            // to the owner a second time (platform daemon/method-owner-decision.ts).
            ...(requiresEffect ? { [CAPABILITY_GATE_DECIDED_HEADER]: 'true' } : {}),
          },
          ...(READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? {} : { body: JSON.stringify(route.invokeEndpoint ? { body: wirePayload } : wirePayload) }),
        });
        stage = 'answered'; httpStatus = response.status;
        // A delegated credential the host no longer accepts is forgotten; the next call makes a new one.
        if (response.status === 401 && delegated) await forgetDelegatedCredential(delegated).catch(() => {});
        // From here the host's answer is the outcome. A check after it cannot undo an
        // applied effect, so nothing below re-checks currentness, and for an effect a body
        // that cannot be read or protected is withheld instead of turning the answer into
        // a failure. A read without its body has nothing to report, so it fails and can be retried.
        const facts = {
          methodId: route.method.id,
          status: response.status,
          ok: response.ok,
          route: `${route.httpMethod} ${requestPath}`,
          effect: preview.effect,
        };
        let body: unknown;
        try {
          body = await readResponseBody(response);
        } catch (error) {
          if (!requiresEffect) throw error;
          return withheldOperatorAnswer({ ...facts, route: `${route.httpMethod} ${route.path}` }, `the answer body could not be read (${summarizeError(error)})`);
        }
        if (response.ok) {
          try {
            publishOperatorMethodReceipt(route.method.id, rawArgs, body);
          } catch (error) {
            logger.warn('agent_operator_method: the receipt of an applied method was not handed to its caller', {
              methodId: route.method.id, error: summarizeError(error),
            });
          }
        }
        const outcome = operatorOutcome(route.method.id, response.ok, body);
        let formatted: string;
        try {
          formatted = await stringifyOutput({ ...facts, body, ...(outcome ? { outcome } : {}) }, {
            signal: options?.signal, secretValues: [connection.token, bearer], declaredFields: operatorResultFields(methodSnapshot) });
        } catch (error) {
          if (!requiresEffect) throw error;
          return withheldOperatorAnswer({ ...facts, route: `${route.httpMethod} ${route.path}` }, `the answer body could not be checked for private data (${summarizeError(error)})`);
        }
        if (!response.ok) return { success: false, error: formatted };
        return { success: true, output: formatted };
      } catch (error) {
        const sent = bounded;
        const cause = sent && sent.deadline.aborted && options?.signal?.aborted !== true
          ? new Error(`the host did not answer within ${sent.deadlineMs / 1000} s`) : error;
        return { success: false, error: operatorMethodFailure(stage, readOnlyHttp, httpStatus, route.method.id, cause) };
      }
    },
  };
}

/**
 * The host answered an effect, but its body is withheld: the status decides the
 * result, and the reason says why the body is missing.
 */
function withheldOperatorAnswer(facts: { readonly methodId: string; readonly status: number; readonly ok: boolean; readonly route: string; readonly effect: unknown },
  reason: string): { success: boolean; output?: string; error?: string } {
  const text = JSON.stringify({ ...facts, body: 'withheld', bodyWithheldBecause: reason }, null, 2);
  if (facts.ok) return { success: true, output: `${facts.methodId} was applied: the host answered HTTP ${facts.status}. Its answer is withheld because ${reason}. Do not repeat the call; read the current state if the details are needed.\n${text}` };
  return { success: false, error: `${facts.methodId} did not succeed: the host answered HTTP ${facts.status}. Its answer is withheld because ${reason}.\n${text}` };
}

function operatorMethodFailure(stage: 'before-send' | 'sending' | 'answered', readOnlyHttp: boolean,
  httpStatus: number | undefined, methodId: string, error: unknown): string {
  const cause = summarizeError(error);
  if (stage === 'before-send') {
    return `connected_host_unavailable: the request was not sent (${cause}). Current recorded effect admission and an unchanged connection are required.`;
  }
  if (readOnlyHttp) {
    return `connected_host_unavailable: ${stage === 'answered' ? `the host answered HTTP ${httpStatus} but the answer could not be used` : 'the host could not be reached'} (${cause}). This was a read; it is safe to retry.`;
  }
  // No receipt is published here: the effect is unconfirmed, so the next step is a read, not a retry.
  return `outcome_unknown: ${methodId} was sent to the host${stage === 'answered' ? ` and the host answered HTTP ${httpStatus}` : ' and no answer was received'}, then it failed (${cause}). The daemon may have applied it. Read the current state with a list or status method before retrying, and do not repeat the call blindly.`;
}

/**
 * `inProcess`: the daemon hosting this turn, which is then the connected host
 * (in-process-host.ts); absent in the Agent's own process.
 */
export function registerAgentOperatorMethodTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentOperatorMethodTool(shellPaths, configManager, inProcess),
    { inputProjection: createOperatorInputProjector(shellPaths, configManager, 'method', inProcess) });
}
