import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecutionMode, withInvocationExecutionMode } from '../gate/execution-context.js';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { randomUUID } from 'node:crypto';
import { judgmentPort, createSharedRegexTester, type SharedRegexTester } from '@goodvibes/engine/errors';
import { endDecisionPhaseWithoutModel, isClassicOperation } from '../runtime/decision-policy.js';
import {
  ToolInputProjectionError, assertProjectionCurrent, assertProjectionSignal, captureProjectionArgs, captureProjectionStructure,
  combineProjectionSignals, projectionContext, projectionFunction, projectionProperty, projectionSignal,
  activateProjectionExecution,
  captureAdmissionEvidence,
  captureSettingsAdmissionEvidence,
  captureSettingsMutation,
  type ProjectedToolCall, type ToolInputProjector, type ToolRegistrationOptions,
  type ToolAdmissionEvidence, type ToolOwnedAdmissionEvidence, type ToolInputProjectionResult, type ToolInputProjectionOptions,
  type ToolPreparedSettingsMutation,
} from './input-projection.js';
import { captureNativeReferenceProjection } from './native-reference-projection.js';
import { mcpResultIngest } from './mcp/result-ingest.js';
import { deferUntrustedIngests, getProcessUntrustedContentLedger, type UntrustedIngest } from '../security/untrusted-content.js';
import { type JudgmentPort } from '@goodvibes/judgment';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { assertAutonomousConfigTransition, completeAutonomousConfigTransition, bindAutonomousNestedAdmission, readAutonomousSettingsPresentation, readAutonomousWorkspaceConstraint, readAutonomousEffectConstraint, readAutonomousNestedOwner, consumeAutonomousAdmission, type AutonomousNestedOwner, type AutonomousPermissionAdmission, type PermissionManager } from '../permissions/manager.js';
import type { AutonomousChoiceProjection } from '../permissions/autonomous-input-projection.js';
import { captureAutonomousSource } from '../permissions/autonomous.js';
import { buildDenialErrorMessage, toolDecisionOf } from '../permissions/denial.js';
import { withAdmittedToolDecision } from '../gate/admitted-decision.js';
import type { PreparedConfigMutationReceipt } from '../config/manager.js';
import type { PreparedSecretImportTransition } from '../config/secrets.js';
import type { PreparedSubscriptionImportTransition } from '../config/subscriptions.js';
import { assertPreparedConfigWriteRoute } from '../config/settings-precondition-client.js';
import { assertRemoteSettingsImportPrecondition, applyRemoteSettingsImportPrecondition,
  assertCompletedRemoteSettingsImportPrecondition } from '../config/settings-import-precondition-client.js';
import { firstJsonSchemaFailure, firstJsonSchemaFailureAsync } from '@goodvibes/engine/transport-http';
import { PERMISSION_CATEGORIES, type Tool, type ToolDefinition, type ToolExecuteOptions, type ToolResult } from '../types/tools.js';
import type { ToolActivity } from '@goodvibes/engine/contracts';
import { UnknownPreparedToolError } from './preparation-error.js';
import { createToolSchemaTool, deferredToolRefusal, oneLineDefinition, TOOL_SCHEMA_TOOL_NAME } from './tool-schema.js';
import { ToolError } from '../types/errors.js';
import { repairToolCall } from './auto-repair.js';
import { checkToolSchema, ToolContractVerifier } from '../runtime/tools/contract-verifier.js';
import type { ContractVerificationResult, ContractVerifierOptions } from '../runtime/tools/contract-verifier.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { JudgmentError } from '@goodvibes/judgment';

/**
 * ToolRegistry - Central registry for all tools available to the LLM.
 * Manages registration, discovery, and execution of tools.
 */
export interface PreparedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly schemaRevision: string;
  readonly judgmentDecisionIds: readonly string[];
}

interface PreparedExecution {
  readonly tool: Tool;
  readonly executor: Tool['execute'];
  readonly definitionRevision: string;
  readonly warnings: readonly string[];
  /** What the repair changed and which arguments it ignored, told to the model with the result. */
  readonly repairs: readonly string[];
  readonly unknownParameters: readonly string[];
  readonly projection: CapturedProjection;
  claimed: boolean;
}

interface ProjectionRegistration {
  readonly tool: Tool;
  readonly revision: string;
  readonly projector: ToolInputProjector | null | undefined;
  readonly project: ToolInputProjector['project'] | undefined;
  readonly captureNativeReferences: ToolInputProjector['captureNativeReferences'] | undefined;
  readonly assertCurrent: (() => void) | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A tool's definition as calls are prepared against it: captured once per definition object. */
interface CapturedDefinition {
  readonly raw: unknown;
  readonly executor: Tool['execute'];
  readonly definition: ToolDefinition;
  readonly revision: string;
}

/** A pattern in an untrusted tool schema gets this long to test one argument before the call is refused. */
const TOOL_SCHEMA_PATTERN_DEADLINE_MS = 1_000;

interface CapturedProjection {
  readonly call: ProjectedToolCall;
  readonly registration: ProjectionRegistration;
  readonly tool: Tool;
  readonly executor: Tool['execute'];
  readonly definition: ToolDefinition;
  readonly rawDefinition: unknown;
  readonly definitionRevision: string;
  readonly captureCurrent: (() => void) | undefined;
  readonly preparationGuards: { readonly callbacks: Set<() => void>; revision: number };
  executionStarted: boolean;
  executionCurrent?: (() => void) | undefined;
  preparationSignal?: AbortSignal | undefined;
  readonly signal: AbortSignal | undefined;
  readonly assertCurrent: (() => void) | undefined;
  readonly nativeCurrent?: (() => void) | undefined;
  readonly nativeSchemaArgs?: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
  readonly assertRepairedArgs: ((args: Record<string, unknown>) => void) | undefined;
  readonly release: (() => Promise<void>) | undefined;
  readonly executionContext: object | undefined;
  readonly admissionEvidence: ToolOwnedAdmissionEvidence | undefined;
  readonly settingsMutation: ToolPreparedSettingsMutation | undefined;
  readonly resultPublication: 'read-only' | undefined;
  released: boolean;
  claimed: boolean;
  releasePromise?: Promise<void>;
  preparation?: Promise<PreparedToolCall>;
}

const applyIntrinsic = Reflect.apply;

export type ToolExecutionEffect = 'write' | 'send';

/** Original autonomous provenance. This restriction grants no separate effect authority. */
export interface CurrentToolAutonomySource {
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly assertCurrent: () => void;
}

interface CurrentToolExecution {
  readonly name: string;
  readonly registry: ToolRegistry;
  readonly nestedOwner: AutonomousNestedOwner;
  readonly admissionGuard: () => void;
  readonly assertWorkspace?: (() => void) | undefined;
  readonly args: Record<string, unknown>;
  readonly assertCurrent: () => void;
  readonly assertEffect: (effect: ToolExecutionEffect) => void;
  readonly commitSettings?: (() => PreparedConfigMutationReceipt) | undefined;
  readonly commitSettingsPlan?: (() => Promise<PreparedConfigMutationReceipt>) | undefined;
  readonly settingsPresentation?: Readonly<{ previous: unknown; current: unknown }> | undefined;
  settingsReceipt?: PreparedConfigMutationReceipt | undefined;
  settingsRetired?: boolean | undefined;
  /** The invocation's own cancellation signal, checked at every checkpoint. */
  readonly signal: AbortSignal | undefined;
  /** The registered definition declares local reads as its only side effect. */
  readonly readOnlyDefinition: boolean;
  /** Set only by {@link relaxCurrentToolReadFences}; see there. */
  liveOnly?: boolean | undefined;
  /**
   * Untrusted content that nested calls brought in. Recording it while the
   * parent runs would change the exposure revision the parent's authority was
   * captured under, so it is recorded when the parent has finished.
   */
  readonly pendingIngests: UntrustedIngest[];
  /** Reads the body itself recorded through an untrusted-content port, held for the same reason. */
  readonly deferredIngests: (() => void)[];
  active: boolean;
  checking: boolean;
}

/**
 * Called by a tool body that only reads local files (and whose registered
 * definition says the same). The call was verified completely when it was
 * claimed and is verified completely again before its result leaves the
 * registry; the body's own intermediate checkpoints only stop work early, so
 * from here on they check the call's signal and that the call has not been
 * retired, which costs a few property reads instead of a full verification
 * per file. An effect or nested call still gets a complete verification.
 * A definition with any other side effect, or a legacy call, is unchanged.
 */
export function relaxCurrentToolReadFences(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  if (!assertCurrentToolInvocation(args, options)) return;
  const proof = currentToolExecutions.get(options!);
  if (proof?.readOnlyDefinition) proof.liveOnly = true;
}

// Exact options identity is the invocation capability. No caller-visible field
// and no exported minting operation can construct an authentic body proof.
const currentToolExecutions = new WeakMap<ToolExecuteOptions, CurrentToolExecution>();
const settingsResultReceipts = new WeakMap<ToolResult, PreparedConfigMutationReceipt>();
/** Options of a call made through `executeNested`; its parent records what it ingested. */
const nestedCallOptions = new WeakSet<ToolExecuteOptions>();
/** The registry running each call that has no admission proof, for {@link runRegisteredTool}. */
const ordinaryCallRegistries = new WeakMap<ToolExecuteOptions, ToolRegistry>();

function retainSettingsReceipt(proof: CurrentToolExecution, receipt: PreparedConfigMutationReceipt): void {
  const previous = proof.settingsReceipt;
  proof.settingsReceipt = previous ? Object.freeze({ ...receipt,
    status: previous.status === 'committed' && receipt.status === 'committed' ? 'committed' : 'partial',
    completedPaths: Object.freeze([...previous.completedPaths, ...receipt.completedPaths]) }) : receipt;
}

/** What the recorded write did, in words: the call reads failed, but its settings change may stand. */
function settingsReceiptEffect(receipt: PreparedConfigMutationReceipt): string {
  if (receipt.status === 'committed') return 'The change WAS applied and saved. Do not repeat it. Read the setting to confirm.';
  if (receipt.status === 'partial') return `The settings change was PARTLY applied: ${receipt.completedPaths.length} file(s) were written, then ${receipt.uncertainPath ?? 'a later file'} failed. Read the setting before changing it again.`;
  return `It is UNKNOWN whether the settings change was applied${receipt.uncertainPath ? ` (${receipt.uncertainPath} failed while being written)` : ''}. Read the setting before changing it again.`;
}

function retiredSettingsResult(callId: string, receipt: PreparedConfigMutationReceipt, signal?: AbortSignal): ToolResult {
  const result: ToolResult = { callId, success: false, ...(signal?.aborted ? { cancelled: true } : {}),
    // Lead with the effect: a model that only reads `error` must not retry a change that already landed.
    error: `${settingsReceiptEffect(receipt)} The call itself was stopped afterwards, so no further work ran.`,
    output: JSON.stringify({ ...receipt, effect: settingsReceiptEffect(receipt) }) };
  settingsResultReceipts.set(result, receipt);
  return result;
}
// Carries the same authentic body proof across trusted wrappers. It never
// creates authority, and cannot be cleared or replaced by a tool argument.
const executingContext = new AsyncLocalStorage<{ readonly proof: CurrentToolExecution; readonly options: ToolExecuteOptions } | undefined>();

/** True only for the exact currently executing tool and its owned arguments. */
export function isInvocationAdmitted(toolName: string, args: Record<string, unknown>): boolean {
  const current = executingContext.getStore();
  if (!current || current.proof.name !== toolName || current.proof.args !== args) return false;
  return assertCurrentToolInvocation(args, current.options);
}

/** Effectful tools must not downgrade wrapped/copied options to legacy authority. */
export function assertCurrentToolInvocation(args: Record<string, unknown>, options?: ToolExecuteOptions): boolean {
  return assertInvocation(args, options, false);
}

function assertInvocation(args: Record<string, unknown>, options: ToolExecuteOptions | undefined, complete: boolean): boolean {
  const current = executingContext.getStore();
  if (current && (current.options !== options || currentToolExecutions.get(current.options) !== current.proof
    || current.proof.args !== args || !current.proof.active)) throw new ToolInputProjectionError('stale');
  return verifyToolExecution(args, options, complete);
}

/** A code-owned effect cannot relax the captured owner's deterministic restrictions. */
export function assertCurrentToolEffect(args: Record<string, unknown>, options?: ToolExecuteOptions,
  effect: ToolExecutionEffect = 'write'): boolean {
  if (!assertInvocation(args, options, true)) return false;
  const proof = options && currentToolExecutions.get(options);
  if (!proof) return false;
  try {
    proof.assertEffect(effect);
    return true;
  } catch (error) {
    proof.active = false;
    throw error;
  }
}

/** Read only the original admitted source, while its exact write invocation remains live. */
export function currentToolAutonomySource(args: Record<string, unknown>, options?: ToolExecuteOptions): CurrentToolAutonomySource | undefined {
  if (!assertCurrentToolEffect(args, options, 'write') || !options) return undefined;
  const proof = currentToolExecutions.get(options)!;
  const source = proof.nestedOwner.source;
  const assertCurrent = () => {
    if (currentToolExecutions.get(options) !== proof || !assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('stale');
  };
  const result = Object.freeze({ goal: source.goal, criteria: Object.freeze([...source.criteria]), assertCurrent });
  assertCurrent();
  return result;
}
/** Compatibility name for the existing Exec consumer. */
export const assertCurrentExecInvocation = assertCurrentToolInvocation;
/** Additional restriction only; captured jobs still require their own authority and lease. */
export function captureCurrentExecWorkspaceConstraint(args: Record<string, unknown>, options?: ToolExecuteOptions): (() => void) | undefined {
  if (!assertCurrentExecInvocation(args, options)) return undefined;
  return currentToolExecutions.get(options!)!.assertWorkspace;
}
// Constructor-only owner identity, without a caller-writable registry property.
const registryPermissionOwners = new WeakMap<ToolRegistry, PermissionManager>();

/** False for legacy/unadmitted calls; a known expired or mismatched proof throws. */
export function assertCurrentToolExecution(args: Record<string, unknown>, options?: ToolExecuteOptions): boolean {
  return verifyToolExecution(args, options, false);
}

/**
 * `complete` forces the full verification even for a read-only body that
 * relaxed its intermediate checkpoints (an effect, a nested call, a commit).
 */
function verifyToolExecution(args: Record<string, unknown>, options: ToolExecuteOptions | undefined, complete: boolean): boolean {
  // Restrictions apply even to ordinary/legacy invocations. They never mint an
  // authenticated admission: absent proof still returns false below.
  const proof = options && currentToolExecutions.get(options);
  if (!complete && proof?.liveOnly && proof.active && !proof.checking && proof.args === args) {
    try { assertProjectionSignal(proof.signal); }
    catch (error) { proof.active = false; throw error; }
    return true;
  }
  try { assertProjectionCurrent(options === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(options, 'assertCurrent')), args); }
  catch (error) { if (proof) proof.active = false; throw error; }
  if (!proof) return false;
  if (!proof.active || proof.checking || proof.args !== args) throw new ToolInputProjectionError('stale');
  proof.checking = true;
  try {
    proof.assertCurrent();
    if (!proof.active) throw new ToolInputProjectionError('stale');
    return true;
  } catch (error) {
    proof.active = false;
    throw error;
  } finally { proof.checking = false; }
}

/**
 * Runs another registered tool on behalf of the tool now executing, through
 * the registry that is running it: inside an admitted call it is a nested call
 * with its own admission (approval, recording and the tool's own checks). An
 * ordinary call was gated by its caller as itself, never as the tool it runs,
 * so the nested tool is checked by the registry's permission owner first and
 * refused when the registry has none. Undefined when the registry running this
 * call is not known or has no tool of that name.
 */
export async function runRegisteredTool(callId: string, name: string, args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult | undefined> {
  const proof = options && currentToolExecutions.get(options);
  if (proof) return proof.registry.has(name) ? proof.registry.executeNested(callId, name, args, options) : undefined;
  const registry = options && ordinaryCallRegistries.get(options);
  const definition = registry?.definitionOf(name);
  if (!registry || !definition) return undefined;
  const owner = registryPermissionOwners.get(registry);
  if (!owner) {
    return { callId, success: false, error: `${name} was not run: the call asking for it was not admitted through a permission owner, so ${name} cannot be approved on its behalf. Nothing was done; call ${name} directly.` };
  }
  const signal = options?.signal;
  // The owner's Pre:tool hooks see a tool run on another's behalf as they see a model's own call.
  const hooked = await owner.preToolHooks(callId, name, args, signal);
  if (hooked.refusal !== undefined) return hookRefusal(callId, name, hooked.refusal);
  const verdict = await owner.checkDetailed(name, hooked.args, undefined, { definition, ...(signal ? { signal } : {}), ...(hooked.ask !== undefined ? { ownerAsk: hooked.ask } : {}) });
  if (!verdict.approved) {
    const source = { reasonCode: verdict.reasonCode, sourceLayer: verdict.sourceLayer, userReason: verdict.userReason, detail: verdict.detail, decision: verdict.decision };
    return { callId, success: false, error: buildDenialErrorMessage(name, source), decision: toolDecisionOf({ ...source, approved: false }, name) };
  }
  const admitted = toolDecisionOf({ reasonCode: verdict.reasonCode, sourceLayer: verdict.sourceLayer, userReason: verdict.userReason,
    detail: verdict.detail, decision: verdict.decision, approved: true }, name);
  return withAdmittedToolDecision(admitted, () => registry.execute(callId, name, verdict.modifiedArgs ?? hooked.args, signal ? { signal } : undefined));
}

/** The result of a call the owner's Pre:tool hook refused (or that failed): not run, with the hook's reason. */
function hookRefusal(callId: string, name: string, reason: string): ToolResult {
  return { callId, success: false, error: reason,
    decision: { state: 'refused', decidedBy: 'rule', reason, limit: `Pre:tool:${name} hook`, next: ['Do something else, or ask the owner to change the hook.'] } };
}

/** Consume the exact registered local effect. Neither options nor callbacks mint a grant. */
export function commitCurrentToolSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): PreparedConfigMutationReceipt {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.commitSettings || !verifyToolExecution(args, options, true)) throw new ToolInputProjectionError('held');
  // Retire before begin: a callback can never reenter this invocation to write.
  proof.active = false;
  const receipt = proof.commitSettings(); proof.settingsReceipt = receipt; return receipt;
}

/** Consume a complete config/credential plan once. Async acquisition stays under its original proof. */
export async function commitCurrentToolSettingsPlan(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<PreparedConfigMutationReceipt> {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.commitSettingsPlan || !verifyToolExecution(args, options, true)) throw new ToolInputProjectionError('held');
  proof.active = false;
  const receipt = await proof.commitSettingsPlan(); proof.settingsReceipt = receipt; return receipt;
}

/** Captured display data is not execution authority and can accompany the committed receipt. */
export function currentToolSettingsPresentation(args: Record<string, unknown>, options?: ToolExecuteOptions): Readonly<{ previous: unknown; current: unknown }> {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.settingsPresentation || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  return proof.settingsPresentation;
}

/** The remote dispatch owns the effect after this synchronous one-shot boundary. */
export function claimCurrentToolSettingsDispatch(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.settingsPresentation || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  proof.active = false;
}

/** Metadata is inspected without invoking user-defined getters or proxy traps. */
function dataProperty(value: object, key: string, name: string): unknown {
  let owner: object | null = value;
  while (owner) {
    if (nodeTypes.isProxy(owner)) throw new ToolError('Proxy-backed autonomous metadata is unsupported', name);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new ToolError('Accessor-backed autonomous metadata is unsupported', name);
      return descriptor.value;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

function plainMetadata(value: unknown, name: string, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new ToolError('Proxy-backed autonomous metadata is unsupported', name);
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new ToolError('Accessor-backed autonomous metadata is unsupported', name);
    plainMetadata(descriptor.value, name, seen);
  }
}

function preparationData(tool: Tool, name: string, freshness = false): { executor: Tool['execute']; definition: ToolDefinition; rawDefinition: unknown } {
  const definition = dataProperty(tool, 'definition', name);
  const execute = dataProperty(tool, 'execute', name);
  if (typeof execute !== 'function' || nodeTypes.isProxy(execute)) throw new ToolError('Autonomous executor must be a data-backed function', name);
  plainMetadata(definition, name);
  // Acquisition screens the definition. Freshness needs a new bounded
  // structural capture of its current canonical data, not another privacy decision on
  // the same bytes. The caller must compare it to that screened revision before
  // use; the complete descriptor walk above still rejects hidden accessors/proxies.
  return { executor: execute as Tool['execute'], rawDefinition: definition, definition: (freshness
    ? captureOwnedJson(definition, nodeTypes.isProxy) : snapshotJudgmentInput(definition)) as unknown as ToolDefinition };
}

/** Refuse a definition a provider or the gate cannot use, naming every problem. */
function assertRegistrableDefinition(definition: ToolDefinition): void {
  const problems = checkToolSchema(definition).filter((violation) => violation.severity === 'error').map((violation) => violation.message);
  if (definition.category !== undefined && !(PERMISSION_CATEGORIES as readonly string[]).includes(definition.category)) {
    problems.push(`Tool '${definition.name}': category '${String(definition.category)}' is not one of ${PERMISSION_CATEGORIES.join(', ')}.`);
  }
  if (problems.length > 0) throw new Error(`Tool '${definition.name}' cannot be registered:\n  ${problems.join('\n  ')}`);
}

/**
 * The display words of every tool registered in this process, by name. A tool
 * name means the same tool in every registry of the process, so the terminal
 * renderers, which draw calls without a registry at hand, read the words here.
 */
const toolActivityByName = new Map<string, ToolActivity>();

const toolDescriptionByName = new Map<string, string>();

/** How many registries of this process hold each tool name; the words go when the last one lets the name go. */
const registryHoldersByName = new Map<string, number>();

/** Records the words of the latest registration of a tool name: a word it does not declare is not kept from an earlier one. */
function recordToolWords(name: string, definition: { readonly activity?: ToolActivity | undefined; readonly description?: unknown }): void {
  if (definition.activity) toolActivityByName.set(name, definition.activity);
  else toolActivityByName.delete(name);
  if (typeof definition.description === 'string' && definition.description.trim() !== '') toolDescriptionByName.set(name, definition.description);
  else toolDescriptionByName.delete(name);
}

function releaseToolName(name: string): void {
  const holders = (registryHoldersByName.get(name) ?? 1) - 1;
  if (holders > 0) {
    registryHoldersByName.set(name, holders);
    return;
  }
  registryHoldersByName.delete(name);
  toolActivityByName.delete(name);
  toolDescriptionByName.delete(name);
}

/** A registered tool's own description, by its name: what an ask about a tool with no display words is worded from. */
export function toolDescriptionOf(name: string): string | undefined {
  return toolDescriptionByName.get(name);
}

/** The display words a registered tool declared, by its name; undefined for a tool that declared none. */
export function toolActivityOf(name: string): ToolActivity | undefined {
  return toolActivityByName.get(name);
}

export class ToolRegistry {
  private readonly prepared = new WeakMap<PreparedToolCall, PreparedExecution>();
  private tools = new Map<string, Tool>();
  private readonly registrations = new Map<string, ProjectionRegistration>();
  private readonly projections = new WeakMap<ProjectedToolCall, CapturedProjection>();
  private readonly projectedArgs = new WeakMap<object, CapturedProjection>();
  private registrationRevision = 0;
  readonly #revisionSource = revisionSource('tool registry', () => this.registrationRevision);
  private definitionSequence = 0;
  private readonly definitionRevisions = new WeakMap<ProjectionRegistration, CapturedDefinition>();
  /** One isolated pattern tester for the untrusted patterns of this registry's tool schemas, started on first use. */
  private patternTester: SharedRegexTester | undefined;
  /** Tools sent one line at a time that `tool_schema` (or a refused call) has since loaded; they go in full from then on. */
  private readonly loadedTools = new Set<string>();
  private fullDefinitionOf: ((name: string) => ToolDefinition | undefined) | undefined;
  /** Tools this registry does not hold because they run somewhere else, with why and where. */
  private readonly elsewhere = new Map<string, { readonly reason: string; readonly next: string }>();

  /** Strict compositions bind their exact authority owner once; raw platform registries remain unbound. */
  constructor(expectedPermissionManager?: PermissionManager) {
    if (expectedPermissionManager !== undefined) registryPermissionOwners.set(this, expectedPermissionManager);
    // Every registry answers `tool_schema` for the tools it lists in one line. It
    // is not part of list(), so a registry built from this one registers its own.
    this.register(createToolSchemaTool({
      definitionOf: (name) => this.definitionOf(name),
      fullDefinition: (name) => this.fullDefinitionOf?.(name),
      loaded: (names) => { for (const name of names) this.loadedTools.add(name); },
    }));
  }

  /**
   * Where `tool_schema` finds a tool's uncompacted definition when a product
   * shortened the registered one (the Agent compacts descriptions).
   */
  setFullDefinitionSource(fullDefinition: (name: string) => ToolDefinition | undefined): void {
    this.fullDefinitionOf = fullDefinition;
  }

  /** Whether a model request carries this tool's full definition: it is core, or it was loaded. */
  private sentInFull(definition: ToolDefinition): boolean {
    return definition.core === true || this.loadedTools.has(definition.name);
  }

  /**
   * The tool definitions a model request carries: core tools (`core: true` on
   * the definition) and tools loaded this session in full, every other tool as
   * a one-line entry, plus `tool_schema` to load one. When every tool goes in
   * full, `tool_schema` is left out. Read once per request, so a tool loaded in
   * one round is sent in full in the next round of the same turn. Calls are
   * always validated against the full registered schema.
   */
  getModelToolDefinitions(): ToolDefinition[] {
    const definitions = this.getToolDefinitions();
    if (definitions.every((definition) => this.sentInFull(definition))) return definitions;
    const schemaTool = this.tools.get(TOOL_SCHEMA_TOOL_NAME);
    return [
      ...definitions.map((definition) => this.sentInFull(definition) ? definition : oneLineDefinition(definition)),
      ...(schemaTool ? [schemaTool.definition] : []),
    ];
  }

  /**
   * The answer to a call of a tool the request listed in one line and that is
   * not loaded yet. Its arguments are checked against the full definition: a
   * call that already fits it runs as usual (the tool is loaded from now on),
   * so a model that knew the parameters is not made to send the same call
   * twice. One that does not fit is not run, and is refused with the tool's
   * full definition so the model can send it again with real parameters.
   * Undefined for any call that runs as usual. A lookup and a schema check;
   * no model request.
   */
  deferredCallRefusal(callId: string, name: string, args?: Record<string, unknown>): ToolResult | undefined {
    const away = this.tools.has(name) ? undefined : this.elsewhere.get(name);
    if (away) {
      return {
        callId,
        success: false,
        error: `${away.reason} ${away.next}`,
        decision: { state: 'refused', decidedBy: 'code', reason: away.reason, next: [away.next], standing: true },
      };
    }
    const definition = this.tools.get(name)?.definition;
    if (!definition || name === TOOL_SCHEMA_TOOL_NAME || this.sentInFull(definition)) return undefined;
    this.loadedTools.add(name);
    const full = this.fullDefinitionOf?.(name) ?? definition;
    if (args !== undefined && firstJsonSchemaFailure(full.parameters, args) === undefined) return undefined;
    return deferredToolRefusal(callId, full);
  }

  /**
   * Names tools that run somewhere else (another process's turn) and so are not
   * in this registry: a call to one is answered as refused, with `reason` and
   * `next`, instead of as an unknown tool. Nothing lists them and no request
   * carries them. A tool registered under the same name is unaffected.
   */
  declareElsewhere(names: readonly string[], refusal: { readonly reason: string; readonly next: string }): void {
    for (const name of names) this.elsewhere.set(name, refusal);
  }

  /** Every registration and removal as a revision source. */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  /**
   * Register a tool. Throws if a tool with the same name is already
   * registered, or if its definition would be refused by a provider or the
   * gate: a malformed parameter schema, a missing name or description, or a
   * category that is not one of the permission categories.
   */
  register(tool: Tool, opts?: ToolRegistrationOptions): void {
    const { definition } = preparationData(tool, 'registration');
    const name = definition.name;
    if (this.tools.has(name)) throw new Error(`Tool '${name}' is already registered`);
    assertRegistrableDefinition(definition);
    const configured = opts === undefined ? undefined : projectionProperty(opts, 'inputProjection');
    // A supplied but missing projector is a protected registration, never an opt-out.
    const candidate = configured === undefined && opts !== undefined && Reflect.has(opts, 'inputProjection') ? null : configured;
    if (candidate !== undefined && candidate !== null && (typeof candidate !== 'object' || nodeTypes.isProxy(candidate))) {
      throw new ToolInputProjectionError('invalid');
    }
    const projector = candidate as ToolInputProjector | null | undefined;
    const project = projector ? projectionFunction<ToolInputProjector['project']>(projectionProperty(projector, 'project')) : undefined;
    if (projector && !project) throw new ToolInputProjectionError('invalid');
    const assertCurrent = projector ? projectionFunction<() => void>(projectionProperty(projector, 'assertCurrent')) : undefined;
    const captureNativeReferences = projector ? projectionFunction<NonNullable<ToolInputProjector['captureNativeReferences']>>(projectionProperty(projector, 'captureNativeReferences')) : undefined;
    const signal = projector ? projectionSignal(projectionProperty(projector, 'signal')) : undefined;
    if (!this.tools.has(name)) registryHoldersByName.set(name, (registryHoldersByName.get(name) ?? 0) + 1);
    this.tools.set(name, tool);
    recordToolWords(name, definition);
    this.registrations.set(name, Object.freeze({ tool, projector, project, captureNativeReferences, assertCurrent, signal,
      revision: `tool-input-projection:${++this.registrationRevision}` }));
  }

  /**
   * Run contract verification on a single registered tool without re-registering.
   *
   * @param name - The tool name to verify.
   * @param opts - Optional verifier options.
   * @returns The verification result, or undefined if the tool is not registered.
   */
  async verifyContract(
    name: string,
    opts?: ContractVerifierOptions,
  ): Promise<ContractVerificationResult | undefined> {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const verifier = new ToolContractVerifier(opts);
    return verifier.verify(tool);
  }

  /**
   * Run contract verification on all registered tools.
   *
   * @param opts - Optional verifier options.
   * @returns Map of tool name → ContractVerificationResult for every registered tool.
   */
  verifyAllContracts(
    opts?: ContractVerifierOptions,
  ): Promise<Map<string, ContractVerificationResult>> {
    const verifier = new ToolContractVerifier(opts);
    return verifier.verifyAll(this.list());
  }

  /** Every registered tool's full definition (the registry's own `tool_schema` aside). A model request uses {@link getModelToolDefinitions}. */
  getToolDefinitions(): ToolDefinition[] {
    return this.list().map((t) => t.definition);
  }

  /** Capture/project before conversation storage, repair, or any ordinary judgment. */
  async projectCall(callId: string, name: string, args: Record<string, unknown>, opts?: ToolInputProjectionOptions): Promise<ProjectedToolCall> {
    const signal = opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal'));
    const captureCurrent = opts === undefined ? undefined : projectionFunction<() => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionSignal(signal);
    const reused = this.projectedArgs.get(args);
    if (reused) {
      if (reused.call.callId !== callId || reused.call.name !== name) throw new ToolInputProjectionError('binding-changed');
      try { assertProjectionCurrent(captureCurrent); }
      catch (error) { if (reused.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
      this.assertCaptured(reused, true);
      return reused.call;
    }
    const registration = this.registrations.get(name);
    if (!registration) {
      captureProjectionArgs(args, name);
      throw new UnknownPreparedToolError(name);
    }
    if (registration.projector === null) throw new ToolInputProjectionError('unconfigured');
    const captured = registration.captureNativeReferences ? captureProjectionStructure(args) : captureProjectionArgs(args, name);
    const { executor, definition, raw: rawDefinition, revision: definitionRevision } = this.capturedDefinition(registration, name);
    const combined = combineProjectionSignals(signal, registration.signal);
    const skeleton = { registration, tool: registration.tool, executor, definition, rawDefinition, definitionRevision, captureCurrent, preparationGuards: { callbacks: new Set<() => void>(), revision: 0 }, executionStarted: false,
      signal: combined, assertCurrent: undefined, assertRepairedArgs: undefined, release: undefined,
      executionContext: undefined, admissionEvidence: undefined, settingsMutation: undefined, resultPublication: undefined, released: false, claimed: false };
    const provisional: CapturedProjection = { ...skeleton, call: Object.freeze({ callId, name, args: Object.freeze({}),
      schemaRevision: definitionRevision, projectionRevision: registration.revision }) };
    let capturedRecord: CapturedProjection | undefined;
    // An owner may retain this restriction through its actual tool body. A
    // preparation guard expires at claim; the exact execution takes its place.
    const assertProjectorCurrent = () => {
      if (capturedRecord?.executionCurrent) return capturedRecord.executionCurrent();
      if (capturedRecord?.claimed || capturedRecord?.released) throw new ToolInputProjectionError('stale');
      this.assertCaptured(provisional, true);
      if (capturedRecord) this.assertCapturedIdentity(capturedRecord);
    };
    let release: (() => Promise<void>) | undefined;
    try {
      let projected = captured;
      let nativeCurrent: (() => void) | undefined;
      let nativeAssertArgs: ((args: Record<string, unknown>) => void) | undefined;
      let nativeSchemaArgs: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
      let nativeReferenceContext: object | undefined;
      if (registration.captureNativeReferences) {
        const native: unknown = applyIntrinsic(registration.captureNativeReferences, registration.projector, [Object.freeze({
          callId, name, args: captured, signal: combined, assertCurrent: assertProjectorCurrent,
        })]);
        if (native !== undefined) {
          if (!native || typeof native !== 'object' || nodeTypes.isProxy(native)) throw new ToolInputProjectionError('invalid');
          if (nodeTypes.isPromise(native)) { assertProjectionCurrent(() => native); throw new ToolInputProjectionError('invalid'); }
          release = projectionFunction<() => Promise<void>>(projectionProperty(native, 'release'));
          const binding = captureNativeReferenceProjection(native, captured, name);
          projected = binding.args; nativeCurrent = binding.assertCurrent; nativeAssertArgs = binding.assertArgs;
          nativeSchemaArgs = binding.schemaArgs; nativeReferenceContext = binding.executionContext;
        } else projected = captureProjectionArgs(captured, name);
      }
      let resultSignal: AbortSignal | undefined;
      let assertCurrent: (() => void) | undefined;
      let assertRepairedArgs: ((args: Record<string, unknown>) => void) | undefined;
      let executionContext: object | undefined = nativeReferenceContext;
      let admissionEvidence: ToolOwnedAdmissionEvidence | undefined;
      let settingsMutation: ToolPreparedSettingsMutation | undefined;
      let resultPublication: 'read-only' | undefined;
      if (registration.projector && registration.project) {
        const result: ToolInputProjectionResult = await applyIntrinsic(registration.project, registration.projector, [Object.freeze({
          callId, name, args: projected, signal: combined, assertCurrent: assertProjectorCurrent,
          ...(nativeReferenceContext ? { nativeReferenceContext } : {}),
        })]);
        if (!result || typeof result !== 'object' || nodeTypes.isProxy(result)) throw new ToolInputProjectionError('invalid');
        const projectedRelease = projectionFunction<() => Promise<void>>(projectionProperty(result, 'release'));
        const nativeRelease = release;
        release = nativeRelease && projectedRelease ? async () => {
          const results = await Promise.allSettled([Promise.resolve().then(nativeRelease), Promise.resolve().then(projectedRelease)]);
          if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
        } : projectedRelease ?? nativeRelease;
        const status = projectionProperty(result, 'status');
        if (status === 'held') throw new ToolInputProjectionError('held');
        if (status !== 'projected') throw new ToolInputProjectionError('invalid');
        projected = captureProjectionArgs(projectionProperty(result, 'args'), name);
        nativeAssertArgs?.(projected);
        resultSignal = projectionSignal(projectionProperty(result, 'signal'));
        const projectedCurrent = projectionFunction<() => void>(projectionProperty(result, 'assertCurrent'));
        assertCurrent = nativeCurrent ? () => { assertProjectionCurrent(nativeCurrent); assertProjectionCurrent(projectedCurrent); assertProjectionCurrent(nativeCurrent); } : projectedCurrent;
        const projectedRepairedArgs = projectionFunction<(args: Record<string, unknown>) => void>(projectionProperty(result, 'assertRepairedArgs'));
        const originalProjected = projected;
        assertRepairedArgs = nativeAssertArgs ? effective => {
          nativeAssertArgs(effective);
          if (projectedRepairedArgs) assertProjectionCurrent(projectedRepairedArgs, effective);
          else if (!isDeepStrictEqual(captureOwnedJson(effective), captureOwnedJson(originalProjected))) throw new ToolInputProjectionError('binding-changed');
          nativeAssertArgs(effective);
        } : projectedRepairedArgs;
        const projectedContext = projectionContext(projectionProperty(result, 'executionContext'));
        if (nativeReferenceContext && projectedContext && nativeReferenceContext !== projectedContext) throw new ToolInputProjectionError('binding-changed');
        executionContext = projectedContext ?? nativeReferenceContext;
        admissionEvidence = captureAdmissionEvidence(projectionProperty(result, 'admissionEvidence'));
        const settingsEvidence = captureSettingsAdmissionEvidence(projectionProperty(result, 'settingsAdmissionEvidence'));
        if (admissionEvidence && settingsEvidence) throw new ToolInputProjectionError('invalid');
        admissionEvidence ??= settingsEvidence;
        settingsMutation = captureSettingsMutation(projectionProperty(result, 'settingsMutation'));
        if (settingsMutation && admissionEvidence?.kind !== 'agent-settings') throw new ToolInputProjectionError('invalid');
        const publication = projectionProperty(result, 'resultPublication');
        if (publication !== undefined && publication !== 'read-only') throw new ToolInputProjectionError('invalid');
        if (publication === 'read-only') {
          // Mixed state tools can resolve an invocation to a read in their
          // trusted projector. Explicit execution/write and owned mutations cannot opt in.
          if (settingsMutation || admissionEvidence?.kind === 'agent-settings'
            || definition.sideEffects?.some(effect => effect !== 'read_fs' && effect !== 'network' && effect !== 'state')) throw new ToolInputProjectionError('invalid');
          resultPublication = publication;
        }
      }
      const call = Object.freeze({ callId, name, args: projected, schemaRevision: definitionRevision,
        projectionRevision: registration.revision });
      const record: CapturedProjection = { ...skeleton, call, signal: combineProjectionSignals(combined, resultSignal),
        assertCurrent, nativeCurrent, nativeSchemaArgs, assertRepairedArgs, release, executionContext, admissionEvidence, settingsMutation, resultPublication };
      capturedRecord = record;
      this.assertCaptured(record, true);
      this.projections.set(call, record);
      this.projectedArgs.set(call.args, record);
      return call;
    } catch (error) {
      if (release) await this.cleanupProjection(release);
      if (error instanceof ToolInputProjectionError) throw error;
      if (registration.projector) throw new ToolInputProjectionError('unavailable');
      throw error;
    }
  }

  /**
   * The definition calls of this registration are prepared against. It is
   * captured (screened and copied) once per definition object and reused while
   * the tool keeps that object and executor; a tool that replaces its
   * definition between calls (the Agent compacts descriptions after
   * registration) is captured again, keeping its revision when unchanged.
   */
  private capturedDefinition(registration: ProjectionRegistration, name: string): CapturedDefinition {
    const known = this.definitionRevisions.get(registration);
    if (known && registration.tool.definition === known.raw && registration.tool.execute === known.executor) return known;
    const { executor, definition, rawDefinition } = preparationData(registration.tool, name);
    const revision = known && isDeepStrictEqual(known.definition, definition) ? known.revision : `tool-schema-${(++this.definitionSequence).toString(36)}`;
    const captured: CapturedDefinition = Object.freeze({ raw: rawDefinition, executor, definition, revision });
    this.definitionRevisions.set(registration, captured);
    return captured;
  }

  /** Live owner callbacks run only before admission, never in the post-claim tail. */
  assertProjected(call: ProjectedToolCall): void {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    this.assertCaptured(record, true);
  }

  /** Callback-free final check for consumers composing several projected alternatives. */
  assertProjectedSnapshot(call: ProjectedToolCall): void {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    this.assertCaptured(record, false);
  }

  /** Idempotent resource release; refusal and callers that never execute must await it too. */
  async releaseProjected(call: ProjectedToolCall): Promise<void> {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    return this.releaseCapture(record);
  }

  private async cleanupProjection(release: () => Promise<void>): Promise<void> {
    try { await release(); } catch { throw new ToolInputProjectionError('unavailable'); }
  }

  private releaseCapture(record: CapturedProjection): Promise<void> {
    if (record.releasePromise) return record.releasePromise;
    record.released = true;
    // Publish the shared completion before invoking owner cleanup (which may reenter).
    record.releasePromise = Promise.resolve().then(async () => {
      if (record.release) await this.cleanupProjection(record.release);
    });
    return record.releasePromise;
  }

  /** With callbacks=false this checks only owned data, descriptors and intrinsic signals. */
  private assertCaptured(record: CapturedProjection, callbacks: boolean): void {
    if (record.claimed) throw new ToolInputProjectionError('stale');
    this.assertCapturedIdentity(record);
    if (callbacks) {
      try { assertProjectionCurrent(record.captureCurrent); assertProjectionCurrent(record.registration.assertCurrent); assertProjectionCurrent(record.assertCurrent); }
      catch (error) { if (record.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
      this.assertCaptured(record, false);
    }
  }

  /** Registration and owned lifetime checks also valid after the one-use claim. */
  private assertCapturedIdentity(record: CapturedProjection, afterRelease = false): void {
    const { registration, call } = record;
    if (record.released && !afterRelease) throw new ToolInputProjectionError('released');
    if (this.registrations.get(call.name) !== registration || this.tools.get(call.name) !== record.tool) {
      throw new ToolInputProjectionError('stale');
    }
    // The call runs on the definition captured when it was projected: a tool
    // that replaced its definition or executor since then is a different tool.
    if (record.tool.definition !== record.rawDefinition || record.tool.execute !== record.executor) throw new ToolInputProjectionError('stale');
    if (registration.projector && (projectionProperty(registration.projector, 'project') !== registration.project
      || projectionProperty(registration.projector, 'captureNativeReferences') !== registration.captureNativeReferences
      || projectionProperty(registration.projector, 'assertCurrent') !== registration.assertCurrent
      || projectionProperty(registration.projector, 'signal') !== registration.signal)) throw new ToolInputProjectionError('stale');
    assertProjectionSignal(record.signal);
  }

  /** Stage guards can inspect a catalog containing this projection. Keep them out of assertProjected. */
  private assertPreparationCurrent(record: CapturedProjection): void {
    assertProjectionSignal(record.preparationSignal);
    this.assertCaptured(record, true);
    try { for (const guard of record.preparationGuards.callbacks) assertProjectionCurrent(guard); }
    catch (error) { if (record.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
    this.assertCaptured(record, false);
    assertProjectionSignal(record.preparationSignal);
  }

  private repairPort(record: CapturedProjection, ids: string[], inner?: JudgmentPort): JudgmentPort {
    // Native repairs do not borrow a supplied transport's metadata or recorder.
    // With no decision model in use repair's no-model path never asks this port, so nothing is looked up;
    // an ask made after the operation moved to no decision model ends the phase before any request.
    // Preserve the installed recorder without requiring a port for calls needing no repair.
    let captured = inner;
    if (!captured && !isClassicOperation()) { try { captured = judgmentPort('tools.input-projection.repair'); } catch { /* Lazily fail if a reading is needed. */ } }
    const port = () => captured ??= judgmentPort('tools.input-projection.repair');
    return {
      get model() { return port().model; },
      ...(captured?.recorder ? { recorder: captured.recorder } : {}),
      async ask(request) {
        const prior = request.beforeAttempt;
        assertProjectionSignal(record.preparationSignal);
        // An operation that moved to no decision model ends repair's reading phase: the no-model repair path finishes the call.
        endDecisionPhaseWithoutModel('tool argument repair');
        // The call is verified once its preparation ends; here only its signal stops a request for a cancelled call.
        const result = await port().ask({ ...request, beforeAttempt() {
          assertSynchronousJudgmentGuard(() => prior?.()); assertProjectionSignal(record.preparationSignal);
          endDecisionPhaseWithoutModel('tool argument repair');
        } });
        if (inner && !result.decisionId) throw new JudgmentError('unrecorded', 'argument repair has no recorded provenance');
        if (result.decisionId) ids.push(result.decisionId);
        return result;
      },
    };
  }

  private repairProjection(record: CapturedProjection, effective: Record<string, unknown>): void {
    if (record.registration.projector) {
      if (record.assertRepairedArgs) {
        try { assertProjectionCurrent(record.assertRepairedArgs, effective); } catch { throw new ToolInputProjectionError('binding-changed'); }
      } else if (!isDeepStrictEqual(captureOwnedJson(effective), captureOwnedJson(record.call.args))) {
        throw new ToolInputProjectionError('binding-changed');
      }
    }
  }

  /**
   * Patterns in tool schemas the product did not write (MCP and plugin tools)
   * run in one isolated worker kept for this registry, never on this thread
   * and never in a worker started per call.
   */
  private schemaPatternTester(): SharedRegexTester {
    return this.patternTester ??= createSharedRegexTester({ operation: 'tool schema pattern', timeoutMs: TOOL_SCHEMA_PATTERN_DEADLINE_MS });
  }

  /** Own and repair before permission; no repair is permitted after admission. */
  async prepareCall(callId: string, name: string, args: Record<string, unknown>, opts?: ToolInputProjectionOptions & { readonly port?: JudgmentPort }): Promise<PreparedToolCall> {
    const projection = await this.projectCall(callId, name, args, opts);
    const record = this.projections.get(projection)!;
    const stageGuard = opts === undefined ? undefined : projectionFunction<() => void>(projectionProperty(opts, 'assertCurrent'));
    if (stageGuard && stageGuard !== record.captureCurrent && !record.preparationGuards.callbacks.has(stageGuard)) {
      record.preparationGuards.callbacks.add(stageGuard);
      record.preparationGuards.revision++;
    }
    const signal = combineProjectionSignals(record.signal, record.preparationSignal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
    record.preparationSignal = signal;
    try {
      record.preparation ??= this.prepareProjection(record, signal, opts === undefined ? undefined : projectionProperty(opts, 'port') as JudgmentPort | undefined);
      const prepared = await record.preparation;
      assertProjectionSignal(signal);
      this.assertPreparationCurrent(record);
      return prepared;
    } catch (error) {
      await this.releaseCapture(record);
      throw error;
    }
  }

  private async prepareProjection(record: CapturedProjection, signal: AbortSignal | undefined, port: JudgmentPort | undefined): Promise<PreparedToolCall> {
    const projection = record.call;
    const { callId, name } = projection;
    const ids: string[] = [];
    try {
      const repair = await repairToolCall(name, projection.args, record.definition, signal, this.repairPort(record, ids, port));
      assertProjectionSignal(signal);
      const effective = captureProjectionArgs(repair.repaired ? repair.fixed : projection.args, name);
      this.repairProjection(record, effective);
      const schemaArgs = record.nativeSchemaArgs ? record.nativeSchemaArgs(effective) : effective;
      const schemaFailure = await firstJsonSchemaFailureAsync(record.definition.parameters, schemaArgs, { signal, isolatedTester: this.schemaPatternTester() });
      // Path and expectation come from the schema, never from the argument values.
      if (schemaFailure) throw new ToolError(`Prepared tool arguments do not match the registered schema at ${schemaFailure.path || '(root)'}: expected ${schemaFailure.expected}. Nothing was executed; fix that argument and re-issue the call.`, name);
      const call = Object.freeze({ callId, name, args: effective, schemaRevision: record.definitionRevision, judgmentDecisionIds: Object.freeze(ids) });
      this.prepared.set(call, { tool: record.tool, executor: record.executor, definitionRevision: record.definitionRevision,
        warnings: [...(repair.warnings ?? [])], repairs: repair.repaired ? [...repair.repairs] : [],
        unknownParameters: [...(repair.unknownParameters ?? [])], projection: record, claimed: false });
      this.assertPrepared(call);
      return call;
    } catch (error) {
      await this.releaseCapture(record);
      throw error;
    }
  }

  /** Synchronous registration/snapshot check, suitable for the last admission boundary. */
  assertPrepared(call: PreparedToolCall): void {
    const record = this.prepared.get(call);
    if (!record || record.claimed || this.tools.get(call.name) !== record.tool) {
      throw new ToolError('Prepared tool registration is stale or already claimed', call.name);
    }
    this.assertCaptured(record.projection, false);
    assertProjectionSignal(record.projection.preparationSignal);
  }

  /** Authenticate the exact prepared handle before exposing registration-owned facts. */
  readPreparedAdmissionEvidence(call: PreparedToolCall): ToolAdmissionEvidence | undefined {
    this.assertPrepared(call);
    const evidence = this.prepared.get(call)!.projection.admissionEvidence;
    return evidence?.kind === 'agent-read' ? evidence : undefined;
  }

  /** The common owner reads both closed backend fact variants without changing the legacy READ accessor. */
  readPreparedOwnedAdmissionEvidence(call: PreparedToolCall): ToolOwnedAdmissionEvidence | undefined {
    this.assertPrepared(call);
    return this.prepared.get(call)!.projection.admissionEvidence;
  }

  /** Read-only status belongs to the captured registration, never to caller arguments. */
  isPreparedReadOnly(call: PreparedToolCall): boolean {
    this.assertPrepared(call);
    return this.prepared.get(call)!.projection.resultPublication === 'read-only';
  }

  /** The captured registration's definition: the facts the gate classifies a call by. */
  readPreparedDefinition(call: PreparedToolCall): ToolDefinition {
    this.assertPrepared(call);
    return this.prepared.get(call)!.tool.definition;
  }

  /** The registered definition of a tool: the facts (category, effects, subjects) the gate decides its calls by. */
  definitionOf(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  /**
   * How this registry's permission owner would decide one call now, without
   * running it: `PermissionManager.previewDecision` with the tool's registered
   * definition. Undefined for a registry bound to no permission owner.
   */
  previewDecision(name: string, args: Record<string, unknown>, signal?: AbortSignal): ReturnType<PermissionManager['previewDecision']> | undefined {
    return registryPermissionOwners.get(this)?.previewDecision(name, args, this.definitionOf(name), signal);
  }

  /** Opaque backend binding, never part of the serializable permission evidence. */
  readPreparedSettingsMutation(call: PreparedToolCall): ToolPreparedSettingsMutation | undefined {
    this.assertPrepared(call);
    return this.prepared.get(call)!.projection.settingsMutation;
  }

  private assertExecuting(call: PreparedToolCall, record: PreparedExecution): void {
    if (this.prepared.get(call) !== record || !record.claimed || !record.projection.claimed
      || !record.projection.executionStarted) throw new ToolInputProjectionError('stale');
    this.assertCapturedIdentity(record.projection);
    assertProjectionSignal(record.projection.preparationSignal);
  }

  /** Invoke the exact prepared executor/arguments immediately after its one-use admission claim. */
  async executePrepared(call: PreparedToolCall, admission: AutonomousPermissionAdmission | (() => void), opts?: ToolExecuteOptions): Promise<ToolResult> {
    const callerCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    const record = this.prepared.get(call);
    if (!record || record.claimed || record.projection.executionStarted) throw new ToolError('Prepared tool registration is stale or already claimed', call.name);
    record.projection.executionStarted = true;
    let retireExecution: (() => void) | undefined;
    let proof: CurrentToolExecution | undefined;
    let executionSignal: AbortSignal | undefined;
    let assertReadPublication: (() => void) | undefined;
    // The tool's own result, once it has run: a cleanup failure after that must not hide an effect that happened.
    let outcome: ToolResult | undefined;
    try {
      const signal = combineProjectionSignals(record.projection.signal, record.projection.preparationSignal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
      executionSignal = signal;
      const onProgress = opts === undefined ? undefined : projectionFunction<(note?: string) => void>(projectionProperty(opts, 'onProgress'));
      const executionOptions = Object.freeze({ signal, callId: call.callId, ...(callerCurrent ? { assertCurrent: callerCurrent } : {}), ...(onProgress ? { onProgress } : {}), ...(record.projection.executionContext ? { inputProjectionContext: record.projection.executionContext } : {}) });
      // All callbacks and option capture precede claim. The tail below is synchronous
      // and invokes only metadata/intrinsic checks before the exact executor.
      const guardRevision = record.projection.preparationGuards.revision;
      // The one complete verification, immediately before the admission is consumed:
      // consuming claims the call's source, and a preparation check of a claimed
      // source refuses by design, so nothing after this point may run one.
      assertProjectionCurrent(callerCurrent);
      this.assertPreparationCurrent(record.projection);
      this.assertPrepared(call);
      // Compatibility callbacks never mint autonomous body authority. Only the
      // manager's consume-only identity map can authenticate this exact handle.
      const assertAdmissionCurrent = typeof admission === 'function'
        ? (admission(), undefined) : consumeAutonomousAdmission(admission, this, call, registryPermissionOwners.get(this));
      if (record.projection.resultPublication === 'read-only') {
        // Registration-owned read dispatch only. This check cannot revive body
        // authority and is retained solely until this invocation's cleanup ends.
        assertReadPublication = () => {
          this.assertCapturedIdentity(record.projection, true);
          assertProjectionSignal(signal);
          assertAdmissionCurrent?.();
          assertProjectionCurrent(callerCurrent);
          this.assertCapturedIdentity(record.projection, true);
          assertProjectionSignal(signal);
        };
      }
      this.assertPrepared(call);
      if (record.projection.preparationGuards.revision !== guardRevision) throw new ToolInputProjectionError('stale');
      assertProjectionSignal(signal);
      record.claimed = true;
      record.projection.claimed = true;
      retireExecution = activateProjectionExecution(record.projection.executionContext, call.args, signal);
      if (assertAdmissionCurrent) {
        const assertEffect = readAutonomousEffectConstraint(assertAdmissionCurrent);
        if (!assertEffect) throw new ToolInputProjectionError('held');
        const mutation = record.projection.settingsMutation;
        let secretTransition: PreparedSecretImportTransition | undefined;
        let subscriptionTransition: PreparedSubscriptionImportTransition | undefined;
        let secretCompleted = false, subscriptionCompleted = false, remoteStarted = false, remoteCompleted = false;
        const assertImports = () => {
          if (mutation?.remoteImport) {
            if (remoteCompleted) assertCompletedRemoteSettingsImportPrecondition(mutation.remoteImport);
            else if (!remoteStarted) assertRemoteSettingsImportPrecondition(mutation.remoteImport);
            // The native pending operation retains its private source at every
            // wire boundary; the unspent precondition cannot be reused here.
          }
          const secret = mutation?.secretImport, subscription = mutation?.subscriptionImport;
          if (secret) {
            if (secretCompleted) secret.owner.assertCompletedImport(secret.mutation);
            else if (secretTransition) secret.owner.assertPreparedImportTransition(secret.mutation, secretTransition);
            else secret.owner.assertPreparedImport(secret.mutation);
          }
          if (subscription) {
            if (subscriptionCompleted) subscription.owner.assertCompletedImport(subscription.mutation);
            else if (subscriptionTransition) subscription.owner.assertPreparedImportTransition(subscription.mutation, subscriptionTransition);
            else subscription.owner.assertPreparedImport(subscription.mutation);
          }
        };
        const assertPlanSource = () => {
          mutation?.owner.assertSettingsWritable();
          assertProjectionCurrent(mutation?.assertSourceCurrent);
          if (mutation?.route) assertPreparedConfigWriteRoute(mutation.route);
          assertImports();
        };
        const assertPlanAuthority = () => {
          assertProjectionCurrent(callerCurrent); assertPlanSource();
          if (mutation?.mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal); assertAdmissionCurrent(); assertEffect('write');
          assertPlanSource();
          if (mutation?.mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal);
        };
        const configMutation = mutation?.mutation;
        let configReceipt: PreparedConfigMutationReceipt | undefined;
        let remoteReceipt: PreparedConfigMutationReceipt | undefined;
        let priorPlanPaths: readonly string[] = [];
        const commitConfig = mutation && configMutation ? () => {
          assertPlanAuthority();
          const transition = mutation.owner.beginPreparedMutation(configMutation);
          const final = () => {
            // Establish only this native transaction on the private owner chain
            // before a child's retained parent samples the authorized onset.
            assertAutonomousConfigTransition(assertAdmissionCurrent, mutation, transition);
            assertProjectionCurrent(callerCurrent); assertPlanSource();
            this.assertExecuting(call, record); assertProjectionSignal(signal); assertEffect('write');
            this.assertExecuting(call, record); assertProjectionSignal(signal);
          };
          final();
          const receipt = mutation.owner.finishPreparedMutation(configMutation, transition, final);
          configReceipt = receipt;
          if (proof && receipt.completedPaths.length) proof.settingsReceipt = Object.freeze({ ...receipt,
            completedPaths: Object.freeze([...priorPlanPaths, ...receipt.completedPaths]) });
          if (receipt.status === 'committed') completeAutonomousConfigTransition(assertAdmissionCurrent, mutation, transition);
          return receipt;
        } : undefined;
        const commitPlan = mutation ? async (): Promise<PreparedConfigMutationReceipt> => {
          const completedPaths: string[] = [];
          priorPlanPaths = completedPaths;
          const joined = (receipt: PreparedConfigMutationReceipt): PreparedConfigMutationReceipt => Object.freeze({ ...receipt,
            status: receipt.status !== 'committed' && completedPaths.length ? 'partial' : receipt.status,
            completedPaths: Object.freeze([...completedPaths, ...receipt.completedPaths]) });
          try {
            assertPlanAuthority();
            if (mutation.remoteImport) {
              remoteStarted = true;
              const receipt = await applyRemoteSettingsImportPrecondition(mutation.remoteImport, {
                ...(signal ? { signal } : {}), assertCurrent: assertPlanAuthority,
              });
              remoteReceipt = receipt;
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); remoteCompleted = true;
              assertCompletedRemoteSettingsImportPrecondition(mutation.remoteImport); assertPlanAuthority();
            }
            if (mutation.secretImport) {
              const imported = mutation.secretImport;
              secretTransition = imported.owner.beginPreparedImport(imported.mutation);
              const receipt = await imported.owner.finishPreparedImport(imported.mutation, secretTransition, assertPlanAuthority);
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); secretCompleted = true;
              imported.owner.assertCompletedImport(imported.mutation); assertPlanAuthority();
            }
            if (mutation.subscriptionImport) {
              const imported = mutation.subscriptionImport;
              subscriptionTransition = imported.owner.beginPreparedImport(imported.mutation);
              const receipt = await imported.owner.finishPreparedImport(imported.mutation, subscriptionTransition, assertPlanAuthority);
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); subscriptionCompleted = true;
              imported.owner.assertCompletedImport(imported.mutation); assertPlanAuthority();
            }
            if (!mutation.secretDeletion) {
              return commitConfig ? joined(commitConfig()) : Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths) });
            }
            // The credential's store locks are taken first and the configuration is then published and the credential cleared
            // in one synchronous section, so no file-watcher poll or timer can land between the two steps and make the
            // second one see its own configuration write as a foreign change. The configuration is still published first:
            // a failure between the two leaves an orphan credential, never configuration that points at a deleted one.
            const deletion = mutation.secretDeletion;
            // One pass: the callbacks that can reenter run first, so the owned-data checks after them see the final state.
            const assertAfterConfig = () => {
              assertProjectionCurrent(callerCurrent); assertAdmissionCurrent(); assertEffect('write');
              assertPlanSource();
              if (configMutation) mutation.owner.assertCompletedMutation(configMutation);
              this.assertExecuting(call, record); assertProjectionSignal(signal);
            };
            let configResult = undefined as PreparedConfigMutationReceipt | undefined;
            let step: { readonly receipt: PreparedConfigMutationReceipt; readonly verified: boolean } | undefined;
            try {
              step = await deletion.owner.withPreparedScopedDeletion(deletion.mutation, (finish) => {
                configResult = commitConfig ? joined(commitConfig()) : Object.freeze({ status: 'committed', completedPaths: Object.freeze([...completedPaths]) });
                if (configResult.status !== 'committed') return undefined;
                completedPaths.splice(0, completedPaths.length, ...configResult.completedPaths);
                const receipt = finish(assertAfterConfig);
                let verified = true;
                if (receipt.status === 'committed') {
                  try { deletion.owner.assertCompletedScopedDeletion(deletion.mutation); assertAfterConfig(); } catch { verified = false; }
                }
                return { receipt, verified };
              });
            } catch (error) {
              // Before the configuration was published nothing happened: let the plan report that. After it, the
              // configuration change stands and only the credential step is uncertain.
              if (configResult === undefined) throw error;
              return Object.freeze({ status: 'partial' as const, completedPaths: Object.freeze([...completedPaths]) });
            }
            if (step === undefined) return configResult!;
            const deleted = step.receipt;
            if (!step.verified) return Object.freeze({ status: 'partial' as const, completedPaths: Object.freeze([...completedPaths]) });
            const combined: PreparedConfigMutationReceipt = Object.freeze({ ...deleted,
              status: deleted.status === 'committed' ? 'committed' as const : 'partial' as const,
              completedPaths: Object.freeze([...completedPaths, ...deleted.completedPaths]) });
            if (proof) proof.settingsReceipt = combined;
            return combined;
          } catch {
            // Completion/source retirement cannot erase a native receipt for
            // physical effects that already happened. It still retires authority.
            if (proof && (configReceipt || remoteReceipt?.status === 'committed' || completedPaths.length)) proof.settingsRetired = true;
            if (configReceipt) return joined(configReceipt);
            if (remoteReceipt && !mutation.mutation && !mutation.secretDeletion && !mutation.secretImport && !mutation.subscriptionImport) return remoteReceipt;
            return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths) });
          }
        } : undefined;
        const nestedOwner = readAutonomousNestedOwner(assertAdmissionCurrent);
        if (!nestedOwner) throw new ToolInputProjectionError('held');
        const declaredEffects = record.projection.definition.sideEffects;
        proof = { name: call.name, registry: this, nestedOwner, admissionGuard: assertAdmissionCurrent, args: call.args, active: true, checking: false, pendingIngests: [], deferredIngests: [], assertEffect,
          signal, readOnlyDefinition: Array.isArray(declaredEffects) && declaredEffects.length > 0 && declaredEffects.every(effect => effect === 'read_fs'),
          assertWorkspace: readAutonomousWorkspaceConstraint(assertAdmissionCurrent),
          settingsPresentation: readAutonomousSettingsPresentation(assertAdmissionCurrent),
          ...(mutation && commitPlan ? { ...(commitConfig && !mutation.remoteImport && !mutation.secretDeletion && !mutation.secretImport && !mutation.subscriptionImport ? { commitSettings: commitConfig } : {}), commitSettingsPlan: commitPlan } : {}), assertCurrent: () => {
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
          assertAdmissionCurrent();
          assertProjectionCurrent(callerCurrent);
          assertProjectionCurrent(record.projection.nativeCurrent);
          // Owner authority sampling can reenter. End at an owned-data check.
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
        } };
        currentToolExecutions.set(executionOptions, proof);
      } else ordinaryCallRegistries.set(executionOptions, this);
      record.projection.executionCurrent = () => {
        this.assertExecuting(call, record); assertProjectionSignal(signal);
        assertProjectionCurrent(record.projection.registration.assertCurrent);
        assertProjectionCurrent(callerCurrent); assertAdmissionCurrent?.();
        this.assertExecuting(call, record); assertProjectionSignal(signal);
      };
      const body = () => applyIntrinsic(record.executor, record.tool, [call.args, executionOptions]);
      const deferred = proof?.deferredIngests;
      // What the body reads is recorded when it ends, as below: recording it now would make this call's own authority stale.
      const execute = deferred ? () => deferUntrustedIngests(recordIngest => { deferred.push(recordIngest); }, body) : body;
      const mode = currentExecutionMode() ?? registryPermissionOwners.get(this)?.getMode();
      const invoke = () => executingContext.run(proof ? { proof, options: executionOptions } : undefined, execute);
      const assertModeCurrent = proof ? () => {
        if (!proof?.active) throw new ToolInputProjectionError('stale');
        proof.assertCurrent();
      } : undefined;
      const retainedMode = registryPermissionOwners.get(this)?.captureExecutionMode();
      const result = await (mode === undefined ? invoke() : withInvocationExecutionMode(mode, invoke, assertModeCurrent, retainedMode?.assertCurrent));
      // Before the result is published: a read body that relaxed its
      // checkpoints ends on a complete verification.
      if (proof?.liveOnly) verifyToolExecution(call.args, executionOptions, true);
      assertProjectionCurrent(callerCurrent);
      if (proof?.settingsReceipt) { assertProjectionSignal(signal); assertAdmissionCurrent?.(); }
      if (proof?.settingsRetired) throw new ToolInputProjectionError('stale');
      if (proof) proof.active = false;
      retireExecution(); retireExecution = undefined;
      const published = { ...result, callId: call.callId,
        ...(record.warnings.length ? { warnings: [...(result.warnings ?? []), ...record.warnings] } : {}) };
      outcome = published;
      annotateRepairs(published, record.repairs, record.unknownParameters, executionSignal);
      if (proof?.settingsReceipt) settingsResultReceipts.set(published, proof.settingsReceipt);
      return published;
    } catch (error) {
      if (proof?.settingsReceipt && (proof.settingsReceipt.status === 'committed' || proof.settingsReceipt.completedPaths.length)) {
        proof.active = false;
        return retiredSettingsResult(call.callId, proof.settingsReceipt, executionSignal);
      }
      throw error;
    } finally {
      record.projection.executionCurrent = undefined;
      if (proof) proof.active = false;
      retireExecution?.();
      // Recorded last: the exposure revision is part of autonomous authority, so
      // recording earlier would make this very call's own authority stale.
      const recordIngests = (): void => {
        if (outcome === undefined) return;
        const own = opts !== undefined && nestedCallOptions.has(opts) ? undefined : mcpResultIngest(call.name, call.args, outcome);
        for (const recordIngest of proof?.deferredIngests ?? []) recordIngest();
        for (const ingest of [...(proof?.pendingIngests ?? []), ...(own ? [own] : [])]) getProcessUntrustedContentLedger().record(ingest);
      };
      try {
        try { await this.releaseCapture(record.projection); }
        catch (error) {
          // Owner cleanup failing after the body finished does not undo what the body did. Report the result and say so,
          // instead of a failure that would make the caller repeat a non-idempotent effect.
          if (outcome === undefined || assertReadPublication !== undefined) throw error;
          logger.warn('Tool cleanup failed after the tool finished', { tool: call.name, error: summarizeError(error) });
          // The result still reaches the model, so what it carries is recorded even though cleanup failed.
          recordIngests();
          if (proof?.settingsReceipt && (proof.settingsReceipt.status === 'committed' || proof.settingsReceipt.completedPaths.length)) {
            return retiredSettingsResult(call.callId, proof.settingsReceipt, executionSignal);
          }
          return { ...outcome, warnings: [...(outcome.warnings ?? []), 'The tool ran and its result is reported, but cleaning up after it failed. Its effect was applied; do not repeat the call.'] };
        }
        assertReadPublication?.();
        recordIngests();
      }
      catch (error) {
        if (proof?.settingsReceipt && (proof.settingsReceipt.status === 'committed' || proof.settingsReceipt.completedPaths.length)) {
          return retiredSettingsResult(call.callId, proof.settingsReceipt, executionSignal);
        }
        throw error;
      }
      finally { assertReadPublication = undefined; }
    }
  }

  /** A child receives its own recorded admission under the original live parent source. */
  async executeNested(callId: string, name: string, args: Record<string, unknown>, opts?: ToolExecuteOptions,
    restrictions?: Pick<ToolExecuteOptions, 'signal' | 'assertCurrent'>): Promise<ToolResult> {
    const context = executingContext.getStore();
    const parent = opts && currentToolExecutions.get(opts);
    if (!opts || !parent || context?.options !== opts || context.proof !== parent
      || parent.registry !== this || !parent.active) throw new ToolInputProjectionError('held');
    const restrictionSignal = restrictions === undefined ? undefined : projectionSignal(projectionProperty(restrictions, 'signal'));
    const restrictionCurrent = restrictions === undefined ? undefined : projectionFunction<() => void>(projectionProperty(restrictions, 'assertCurrent'));
    const assertParentProof = () => {
      if (currentToolExecutions.get(opts) !== parent || !parent.active || parent.registry !== this
        || !verifyToolExecution(parent.args, opts, true)) throw new ToolInputProjectionError('stale');
    };
    const assertParent = () => {
      assertParentProof(); assertProjectionSignal(restrictionSignal);
      if (restrictions && (projectionProperty(restrictions, 'signal') !== restrictionSignal
        || projectionProperty(restrictions, 'assertCurrent') !== restrictionCurrent)) throw new ToolInputProjectionError('stale');
      if (restrictionCurrent) {
        executingContext.run(context, () => assertProjectionCurrent(restrictionCurrent));
        assertParentProof(); assertProjectionSignal(restrictionSignal);
      }
    };
    assertParent();
    const { manager, source, decoratePort } = parent.nestedOwner;
    const sourceOf = () => { assertParent(); return source; };
    const sourceId = randomUUID();
    const signal = combineProjectionSignals(opts.signal, restrictionSignal);
    // The owner's Pre:tool hooks see a tool run inside another as they see a model's own call, in every mode.
    const hooked = await manager.preToolHooks(callId, name, args, signal);
    assertParent();
    if (hooked.refusal !== undefined) return hookRefusal(callId, name, hooked.refusal);
    args = hooked.args;
    const ownerAsk = hooked.ask;
    const projections = new Set<ProjectedToolCall>();
    let choiceProjection: AutonomousChoiceProjection | undefined;
    try {
      await manager.prepareAutonomousOwner(signal); assertParent();
      const original = manager.autonomousPreparation(sourceId, sourceOf, signal, decoratePort);
      const initial = await this.projectCall(callId, name, args, { signal, assertCurrent: () => { assertParent(); original.assertCurrent(); } });
      projections.add(initial); assertParent();
      choiceProjection = await manager.projectAutonomousChoices(sourceId, callId, sourceOf, this, signal);
      assertParent(); original.assertCurrent();
      const prepare = async (toolName: string, input: Record<string, unknown>) => {
        const preparation = manager.autonomousPreparation(sourceId, sourceOf, signal, decoratePort, choiceProjection);
        const assertCurrent = () => { assertParent(); preparation.assertCurrent(); };
        const projected = await this.projectCall(callId, toolName, input, { signal, assertCurrent });
        projections.add(projected); assertCurrent();
        const call = await this.prepareCall(callId, toolName, projected.args, { signal, port: preparation.port, assertCurrent });
        assertCurrent(); return call;
      };
      let call = await prepare(name, initial.args);
      const consumedRevisions: string[] = [];
      let permittedRevisionIds: readonly string[] | undefined;
      while (true) {
        const current = call;
        const admission = await manager.admitAutonomous(sourceId, current.name, current.args, {
          sourceOf, decoratePort, signal, choiceProjection, sessionId: parent.nestedOwner.sessionId, ...(ownerAsk !== undefined ? { ownerAsk } : {}),
          consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}),
          schemaRevision: current.schemaRevision, preparationDecisionIds: current.judgmentDecisionIds,
          preparedCall: { registry: this, call: current }, assertPrepared: () => { assertParent(); this.assertPrepared(current); },
        });
        assertParent(); permittedRevisionIds ??= admission.revisionIds;
        if (admission.revision) {
          const revision = admission.revision;
          if (consumedRevisions.includes(revision.ref.id)) throw new ToolInputProjectionError('stale');
          consumedRevisions.push(revision.ref.id);
          call = await prepare(revision.toolName, revision.args);
          continue;
        }
        if (!admission.result.approved) return { callId, success: false,
          error: `Nested tool admission ${admission.result.autonomousDecision?.outcome ?? 'held'}: ${admission.result.reasonCode}` };
        bindAutonomousNestedAdmission(parent.admissionGuard, admission);
        const childOptions: ToolExecuteOptions = { signal, assertCurrent: assertParent };
        nestedCallOptions.add(childOptions);
        const result = await this.executePrepared(current, admission, childOptions);
        const receipt = settingsResultReceipts.get(result);
        if (receipt) retainSettingsReceipt(parent, receipt);
        try { assertParent(); }
        catch (error) {
          if (!receipt) throw error;
          parent.active = false;
          return retiredSettingsResult(current.callId, parent.settingsReceipt!, signal);
        }
        const ingest = mcpResultIngest(current.name, current.args, result);
        if (ingest) parent.pendingIngests.push(ingest);
        return result;
      }
    } finally {
      const released = await Promise.allSettled([
        ...[...projections].map(projected => this.releaseProjected(projected)),
        ...(choiceProjection ? [manager.releaseAutonomousChoices(choiceProjection)] : []),
      ]);
      // Each nested call has its own source id; once it has settled its epoch is not needed.
      manager.retireAutonomousSource(sourceId);
      const failure = released.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }

  /**
   * One call the owner confirmed himself: a form he filled in and answered yes
   * to. It is prepared, admitted and run on the same path as a nested call,
   * with no parent tool execution: the source is the owner's stated request,
   * and the admission carries his confirmation, so a deny rule or plan mode
   * still refuses but nobody is asked again. Only the owner's own input path
   * calls this; a model reaches tools through a turn or `executeNested`.
   */
  async executeOwnerConfirmed(callId: string, name: string, args: Record<string, unknown>,
    request: {
      readonly goal: string;
      readonly criteria: readonly string[];
      readonly signal?: AbortSignal | undefined;
      /** The session the owner confirmed the call in; his remembered answers are read under it. */
      readonly sessionId?: string | undefined;
    }): Promise<ToolResult> {
    const manager = registryPermissionOwners.get(this);
    if (!manager) {
      return { callId, success: false, error: `${name} was not run: this tool registry has no permission owner to admit an owner-confirmed call.` };
    }
    if (!this.tools.has(name)) return { callId, success: false, error: `${name} was not run: no tool by that name is registered here.` };
    const signal = request.signal;
    const source = captureAutonomousSource({ goal: request.goal, criteria: [...request.criteria] });
    const sourceOf = () => { signal?.throwIfAborted(); return source; };
    const sourceId = randomUUID();
    const projections = new Set<ProjectedToolCall>();
    let choiceProjection: AutonomousChoiceProjection | undefined;
    try {
      await manager.prepareAutonomousOwner(signal);
      const original = manager.autonomousPreparation(sourceId, sourceOf, signal);
      const initial = await this.projectCall(callId, name, args, { signal, assertCurrent: () => original.assertCurrent() });
      projections.add(initial);
      choiceProjection = await manager.projectAutonomousChoices(sourceId, callId, sourceOf, this, signal);
      original.assertCurrent();
      const prepare = async (toolName: string, input: Record<string, unknown>) => {
        const preparation = manager.autonomousPreparation(sourceId, sourceOf, signal, undefined, choiceProjection);
        const assertCurrent = () => preparation.assertCurrent();
        const projected = await this.projectCall(callId, toolName, input, { signal, assertCurrent });
        projections.add(projected); assertCurrent();
        const call = await this.prepareCall(callId, toolName, projected.args, { signal, port: preparation.port, assertCurrent });
        assertCurrent(); return call;
      };
      let call = await prepare(name, initial.args);
      const consumedRevisions: string[] = [];
      let permittedRevisionIds: readonly string[] | undefined;
      while (true) {
        const current = call;
        const admission = await manager.admitAutonomous(sourceId, current.name, current.args, {
          sourceOf, signal, choiceProjection, ownerConfirmed: true, sessionId: request.sessionId,
          consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}),
          schemaRevision: current.schemaRevision, preparationDecisionIds: current.judgmentDecisionIds,
          preparedCall: { registry: this, call: current }, assertPrepared: () => this.assertPrepared(current),
        });
        permittedRevisionIds ??= admission.revisionIds;
        if (admission.revision) {
          const revision = admission.revision;
          if (consumedRevisions.includes(revision.ref.id)) throw new ToolInputProjectionError('stale');
          consumedRevisions.push(revision.ref.id);
          call = await prepare(revision.toolName, revision.args);
          continue;
        }
        if (!admission.result.approved) {
          const reason = admission.result.detail ?? admission.result.reasonCode;
          return { callId, success: false, error: `${current.name} was not run: ${reason}.` };
        }
        return await this.executePrepared(current, admission, signal ? { signal } : undefined);
      }
    } finally {
      const released = await Promise.allSettled([
        ...[...projections].map(projected => this.releaseProjected(projected)),
        ...(choiceProjection ? [manager.releaseAutonomousChoices(choiceProjection)] : []),
      ]);
      manager.retireAutonomousSource(sourceId);
      const failure = released.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }

  /**
   * Execute a named tool with the given arguments. Wraps errors in ToolResult.
   *
   * `opts.signal` cancels pending argument repair and passes through to
   * `tool.execute`, where tools that opt in (exec, fetch) read it. Callers
   * that don't have a cancellation signal (the common case) omit `opts`.
   */
  async execute(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const callerCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionCurrent(callerCurrent);
    const tool = this.tools.get(name);
    if (!tool) {
      const known = [...this.tools.keys()].sort();
      return {
        callId,
        success: false,
        error: known.length > 0
          ? `Unknown tool: '${name}'. Known tools: ${known.join(', ')}.`
          : `Unknown tool: '${name}'. No tools are registered.`,
      };
    }

    // Omitted protection retains the legacy direct-execution contract: its
    // existing wrappers own their refusal/result shape and original arguments.
    // prepareCall and owned ingress still use immutable captures for admission.
    if (this.registrations.get(name)?.projector === undefined) {
      return this.executeOrdinary(callId, name, tool, args, opts);
    }

    let record: CapturedProjection | undefined;
    let retireExecution: (() => void) | undefined;
    let assertReadPublication: (() => void) | undefined;
    let outcome: ToolResult | undefined;
    try {
      const projected = await this.projectCall(callId, name, args, opts);
      const selected = this.projections.get(projected)!;
      if (selected.executionStarted) throw new ToolInputProjectionError('stale');
      record = selected;
      record.executionStarted = true;
      const signal = combineProjectionSignals(record.signal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
      const repairResult = await repairToolCall(name, projected.args, record.definition, signal, this.repairPort(record, []));
      assertProjectionSignal(signal);
      const effectiveArgs = captureProjectionArgs(repairResult.repaired ? repairResult.fixed : projected.args, name);
      this.repairProjection(record, effectiveArgs);
      const onProgress = opts === undefined ? undefined : projectionFunction<(note?: string) => void>(projectionProperty(opts, 'onProgress'));
      const executionOptions = record.registration.projector
        ? Object.freeze({ signal, callId, ...(callerCurrent ? { assertCurrent: callerCurrent } : {}), ...(onProgress ? { onProgress } : {}), ...(record.executionContext ? { inputProjectionContext: record.executionContext } : {}) })
        : opts === undefined || projectionProperty(opts, 'inputProjectionContext') === undefined ? opts : Object.freeze({ signal, callId, ...(onProgress ? { onProgress } : {}) });
      // The claim: the one complete verification immediately before the body.
      this.assertPreparationCurrent(record);
      record.claimed = true;
      const capturedRecord = record;
      record.executionCurrent = () => {
        if (!capturedRecord.claimed || !capturedRecord.executionStarted) throw new ToolInputProjectionError('stale');
        this.assertCapturedIdentity(capturedRecord); assertProjectionSignal(signal);
        assertProjectionCurrent(capturedRecord.captureCurrent);
        assertProjectionCurrent(capturedRecord.registration.assertCurrent);
        assertProjectionCurrent(callerCurrent, effectiveArgs);
        this.assertCapturedIdentity(capturedRecord); assertProjectionSignal(signal);
      };
      if (record.resultPublication === 'read-only') {
        assertReadPublication = () => {
          assertProjectionCurrent(callerCurrent, effectiveArgs);
          this.assertCapturedIdentity(capturedRecord, true);
          assertProjectionSignal(signal);
        };
      }
      retireExecution = activateProjectionExecution(record.executionContext, effectiveArgs, signal);
      if (executionOptions) ordinaryCallRegistries.set(executionOptions, this);
      // A separately dispatched call owns its own execution scope. Background
      // agents must not inherit the completed spawning tool's body proof.
      const result = await executingContext.run(undefined, () => applyIntrinsic(capturedRecord.executor, capturedRecord.tool, [effectiveArgs, executionOptions]));
      assertProjectionCurrent(callerCurrent, effectiveArgs);
      retireExecution(); retireExecution = undefined;
      const toolResult = { ...result, callId };
      if (repairResult.warnings && repairResult.warnings.length > 0) {
        toolResult.warnings = [...(toolResult.warnings ?? []), ...repairResult.warnings];
      }
      annotateRepairs(toolResult, repairResult.repaired ? repairResult.repairs : [], repairResult.unknownParameters ?? [], signal);
      const ingest = mcpResultIngest(name, effectiveArgs, toolResult);
      if (ingest) getProcessUntrustedContentLedger().record(ingest);
      outcome = toolResult;
      return toolResult;
    } catch (err) {
      if (err instanceof ToolInputProjectionError) {
        if (err.problem === 'cancelled' && this.registrations.get(name)?.projector === undefined) {
          throw new ToolError('the judgment call was cancelled', name, { cause: new JudgmentError('aborted', 'the judgment call was cancelled') });
        }
        throw err;
      }
      const message = summarizeError(err);
      throw new ToolError(message, name, err instanceof Error ? { cause: err } : undefined);
    } finally {
      if (record) record.executionCurrent = undefined;
      retireExecution?.();
      try {
        if (record) {
          try { await this.releaseCapture(record); }
          catch (error) {
            // Owner cleanup failing after the body finished does not undo what the body did; a thrown failure would make the caller repeat it.
            if (outcome === undefined || assertReadPublication !== undefined) throw error;
            logger.warn('Tool cleanup failed after the tool finished', { tool: name, error: summarizeError(error) });
            return { ...outcome, warnings: [...(outcome.warnings ?? []), 'The tool ran and its result is reported, but cleaning up after it failed. Its effect was applied; do not repeat the call.'] };
          }
        }
        assertReadPublication?.();
      }
      finally { assertReadPublication = undefined; }
    }
  }

  /** Original non-projected execute path; never used by a required projector. */
  private async executeOrdinary(callId: string, name: string, tool: Tool,
    args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const signal = opts?.signal;
    const assertCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionCurrent(assertCurrent);
    try {
      const repair = await repairToolCall(name, args, tool.definition, signal);
      if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
      assertProjectionCurrent(assertCurrent);
      const effectiveArgs = repair.repaired ? repair.fixed : args;
      // The new projection-context field is owner-only, even on a legacy call.
      const onProgress = opts === undefined ? undefined : projectionFunction<(note?: string) => void>(projectionProperty(opts, 'onProgress'));
      const executionOptions = assertCurrent ? Object.freeze({ signal, callId, assertCurrent, ...(onProgress ? { onProgress } : {}) })
        : opts === undefined || projectionProperty(opts, 'inputProjectionContext') === undefined ? opts : Object.freeze({ signal, callId, ...(onProgress ? { onProgress } : {}) });
      assertProjectionCurrent(assertCurrent, effectiveArgs);
      if (executionOptions) ordinaryCallRegistries.set(executionOptions, this);
      const result = await executingContext.run(undefined, () => tool.execute(effectiveArgs, executionOptions));
      assertProjectionCurrent(assertCurrent, effectiveArgs);
      const toolResult = { ...result, callId };
      if (repair.warnings?.length) toolResult.warnings = [...(toolResult.warnings ?? []), ...repair.warnings];
      annotateRepairs(toolResult, repair.repaired ? repair.repairs : [], repair.unknownParameters ?? [], signal);
      const ingest = mcpResultIngest(name, effectiveArgs, toolResult);
      if (ingest) getProcessUntrustedContentLedger().record(ingest);
      return toolResult;
    } catch (error) {
      throw new ToolError(summarizeError(error), name, error instanceof Error ? { cause: error } : undefined);
    }
  }

  /**
   * Remove a registered tool. When `expected` is given, the tool is removed
   * only if it is still that exact registration (a later owner of the same
   * name is left alone). Returns whether a tool was removed.
   */
  unregister(name: string, expected?: Tool): boolean {
    const current = this.tools.get(name);
    if (!current || (expected !== undefined && current !== expected)) return false;
    this.tools.delete(name);
    this.registrations.delete(name);
    this.registrationRevision++;
    releaseToolName(name);
    return true;
  }

  /** Returns true if a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * The registration options a tool was registered with, so a registry built
   * from this one (a worker's scoped registry) keeps the tool's input
   * projector instead of silently dropping it. Undefined for an ordinary tool.
   */
  registrationOptionsFor(name: string): ToolRegistrationOptions | undefined {
    const registration = this.registrations.get(name);
    if (!registration || registration.projector === undefined) return undefined;
    return { inputProjection: registration.projector };
  }

  /** Returns all registered tools, except the registry's own `tool_schema`. */
  list(): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => tool.definition.name !== TOOL_SCHEMA_TOOL_NAME);
  }
}

/**
 * Tells the model what the registry changed in its call (repaired arguments) and
 * which arguments were ignored, on every execution path. A cancelled or aborted
 * call carries no note.
 */
export function annotateRepairs(
  result: { output?: string | undefined; cancelled?: boolean | undefined },
  repairs: readonly string[],
  unknownParameters: readonly string[],
  signal?: AbortSignal,
): void {
  if (result.cancelled || signal?.aborted) return;
  if (repairs.length > 0) {
    const note = `[Auto-repaired: ${repairs.join(', ')}]`;
    result.output = withRepairNote(result.output, note, repairs);
  }
  if (unknownParameters.length > 0) result.output = withParameterWarnings(result.output, unknownParameters);
}

/** A JSON object result gains a leading `auto_repaired` field so its parsers keep working; other results get a first line. */
function withRepairNote(output: string | undefined, note: string, repairs: readonly string[]): string {
  if (typeof output !== 'string') return note;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ auto_repaired: [...repairs], ...parsed as Record<string, unknown> });
    }
  } catch {
    // Not JSON: fall through to a text line.
  }
  return `${note}\n${output}`;
}

/**
 * Tells the model which arguments were ignored. A JSON object result gains a
 * leading `parameter_warnings` field so parsers of the result keep working;
 * other results get a first line.
 */
function withParameterWarnings(output: string | undefined, warnings: readonly string[]): string {
  if (typeof output === 'string') {
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({ parameter_warnings: [...warnings], ...parsed as Record<string, unknown> });
      }
    } catch {
      // Not JSON: fall through to a text line.
    }
    return `[Ignored parameters: ${warnings.join(' ')}]\n${output}`;
  }
  return `[Ignored parameters: ${warnings.join(' ')}]`;
}
