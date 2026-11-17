import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { isDeepStrictEqual } from 'node:util';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, rememberDecisionRefusal, wasDecisionRefused, type RefusedDecisionAction } from '../runtime/decision-policy.js';
import { readExternalRequestEvidence, type ExternalRequestEvidence } from './external-request-evidence.js';
import { JudgmentError, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { captureOwnedJson, captureJsonEntry } from '../gate/judgment-input.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { assertAutonomousData, captureCurrentAutonomousChoices, captureCurrentAutonomousSourceFrame, type AutonomousToolChoices, type AutonomousToolRevision, type AutonomousToolSource, autonomousSourceEvidence, decideAutonomousTool } from './autonomous.js';
import { AutonomousChoiceProjectionOwner, type AutonomousChoiceProjection } from './autonomous-input-projection.js';
import type { PreparedToolCall, ToolRegistry, ToolExecutionEffect } from '../tools/registry.js';
import { assertProjectionCurrent, projectionFunction, projectionProperty, ToolInputProjectionError, type ToolOwnedAdmissionEvidence, type ToolPreparedSettingsMutation } from '../tools/input-projection.js';
import { configKeyFacts } from '../config/config-key-facts.js';
import { DEFAULT_CONFIG, type ConfigKey } from '../config/schema.js';
import { readDotPath } from '../config/shared-config-tier.js';
import { bindTurnHookDispatcher, type TurnHookOwner } from '../hooks/turn-ownership.js';
import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.js';
import type { PermissionsToolConfig } from '../config/schema.js';
import type { PermissionAttribution, PermissionExecutionOptions, PermissionPromptDecision, PermissionRequestHandler } from './prompt.js';
import { describeHookChange } from './hook-change-prompt.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { assertPermissionActive, awaitPermission } from './cancellation.js';
import { analyzePermissionRequest, withReading } from './analysis.js';

import { decisionModelReady, effectivePermissionMode, presetForMode, type GatePreset, type GatePresetName } from '../gate/presets.js';
import { gateDecisionsCalibrated } from '../gate/calibration.js';
import { judgmentInputBoundary, runBoundary } from '../gate/boundary.js';
import { readToolCall, shellCommandsIn } from '../gate/reading.js';
import { currentExecutionMode, currentExecutionModeForReadDecision, currentExecutionModeOwner, isInvocationAdmitted, withExecutionMode, type ExecutionModeOwner } from '../gate/execution-context.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { currentTurnSurfaceId } from '../security/turn-boundary.js';
import { effectPermittedForProvenance } from '../gate/surface-authority.js';
import { isStateMutation } from '../gate/policy/state-policy.js';
import { resolve } from 'node:path';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { buildDurableRuleForDecision, buildRememberOptions, matchDurableRulesAsync, sessionApprovalKey, type RememberTier } from './approval-rules.js';
import { changesMcpTrust, classifyCall, classifyPaths, declaredRecoverable, declaredValues, ownerOnlyReason, recognizeOwnerOnly, type CallClass, type CallFacts, type CallRuleFact, type OwnerOnlyKind } from '../gate/classify.js';
import { toolDecisionOf } from './denial.js';
import { processHeldForOwner, type HeldForOwnerCall, type HeldForOwnerLedger } from './held-for-owner.js';
import { processJevDecisions, type JevDecisionLedger, type JevDecisionRuleEffect } from './jev-decisions.js';
import { readModeCategory, toolCategoryOf, type ToolDefinition } from '../types/tools.js';
import { projectIdentity, type UserPermissionRuleStore } from './user-rule-store.js';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.js';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.js';
import { exportDecisions } from '../runtime/permissions/decision-otlp.js';
import type { DecisionOtlpConfig } from '../runtime/permissions/decision-otlp.js';
import type { CallSubjects, CommandClassification, PolicyRule, PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import { retainPermissionConfigurationOwner, type PermissionConfigurationOwner, type ConfigManager, type PreparedConfigMutationTransition } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { landingPath } from '../utils/path-safety.js';
import type {
  PermissionCategory,
  PermissionCheckResult,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
  PermissionRequestAnalysis,
  GateBoundaryRecord,
  GatePresetRecord,
} from './types.js';
export type { PermissionMode } from '../config/schema.js';
export type {
  PermissionCategory,
  PermissionRiskLevel,
  PermissionDecisionSource,
  PermissionDecisionReasonCode,
  PermissionRequestAnalysis,
  PermissionCheckResult,
} from './types.js';

/**
 * The slice of config the permission layer reads, `.permissions` and nothing
 * else.
 *
 * `getConfigSnapshot` returns the whole `GoodVibesConfig`, and this alias used
 * to be exactly that, so `PermissionConfigReader` declared a dependency on
 * every config domain in the product while its two consumers (both in this
 * file) read `getSnapshot().permissions`. A stand-in reader had to produce all
 * fifty-odd domains to satisfy it. The real implementation avoids those
 * unrelated reads: `createPermissionConfigReader` uses the manager-owned
 * permission frame when available, with a full-snapshot fallback for readers
 * that only implement the legacy configuration interface.
 */
type PermissionConfigSnapshot = Readonly<Pick<ReturnType<typeof getConfigSnapshot>, 'permissions'>>;

/** Owned fields from the already captured autonomous authority frame. */
interface AutonomousPermissionOwner {
  readonly directory: string | null;
  readonly rules: readonly PolicyRule[];
  readonly policyRules: readonly PolicyRule[];
  readonly policyEnabled: boolean;
}
type AutonomousPermissionReading = Readonly<{
  frame: AutonomousPermissionOwner;
  assertCurrent(): void;
}>;

/** One call as the safety decision reads it, after classification. */
interface SafetyInput {
  readonly callId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly category: PermissionCategory;
  /** The classified result: a fact's decision, or a not-refused placeholder for owner-only and judgment calls. */
  readonly policyResult: PermissionCheckResult;
  readonly decided: CallClass;
  readonly mode: GatePresetName;
  readonly signal: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  readonly workingDirectory: string | undefined;
  readonly source?: AutonomousToolSource;
  readonly sourceId: string;
  readonly actionRevision: string;
  readonly authorityRevision: string;
  readonly authoritySnapshot: EntryType;
  readonly supportingIds?: readonly string[];
  readonly decoratePort?: ((port: JudgmentPort) => JudgmentPort) | undefined;
  readonly attribution?: PermissionAttribution | undefined;
  /** The owner confirmed this exact call himself; his confirmation is the approval. */
  readonly ownerConfirmed?: boolean | undefined;
}

interface SafetyOutcome {
  readonly result: PermissionCheckResult;
  readonly recordClaim?: () => void;
  readonly revision?: AutonomousToolRevision;
}

/** What one decision already holds about a call, before classification. */
interface CallFactInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly category: PermissionCategory;
  readonly mode: GatePresetName;
  readonly surface: string | undefined;
  readonly definition: ToolDefinition | undefined;
  readonly ownerOnly: OwnerOnlyKind | undefined;
  readonly directory: string | null;
  readonly tools: PermissionsToolConfig | undefined;
  readonly remembered: RememberedDecision | null;
  readonly landed: RememberedDecision | null;
  readonly policy: PermissionCheckResult | null;
  readonly untrustedRead: boolean;
  /** The registry's prepared call was declared read-only by its tool's own projection. */
  readonly declaredReadOnly?: boolean | undefined;
}

/** A session answer or saved rule that matched a call. */
interface RememberedDecision {
  readonly approved: boolean;
  /** `ask`: the owner's standing "always ask me" rule; neither an allow nor a denial. */
  readonly effect: PolicyRule['effect'];
  readonly source: PermissionDecisionSource;
  readonly reason: PermissionDecisionReasonCode;
  /** What the answer or rule covers, as the agent is told it. */
  readonly description: string;
  /** Set when the answer was the owner's to an item only he decides. */
  readonly ownerOnly?: OwnerOnlyKind | undefined;
  assertCurrent(): void;
}

/** The result layer and reason codes for a rule fact, by where the rule came from. */
const RULE_LAYERS: Readonly<Record<CallRuleFact['source'], readonly [PermissionDecisionSource, PermissionDecisionReasonCode, PermissionDecisionReasonCode, boolean]>> = {
  'tool-setting': ['config_policy', 'config_allow', 'config_deny', false],
  limit: ['config_policy', 'config_allow', 'config_deny', false],
  'managed-policy': ['managed_policy', 'managed_policy_allow', 'managed_policy_deny', false],
  session: ['session_override', 'session_cached_allow', 'session_cached_deny', true],
  'user-rule': ['user_rule', 'user_rule_allow', 'user_rule_deny', true],
};

/** Sequence of decisions sent to an OTLP collector by this process, so a collector can order them. */
let exportedDecisionSequence = 0;

/** A stable OTLP trace id for one session, so a collector joins its decisions. */
function sessionTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

/**
 * The paths, commands and hosts a call names, read where its tool declares
 * them; a kind the tool does not declare is left for the rule to find.
 */
function callSubjects(args: Record<string, unknown>, definition: Pick<ToolDefinition, 'subjects'> | undefined): CallSubjects | undefined {
  const declared = definition?.subjects;
  if (!declared) return undefined;
  const paths = declaredValues(args, declared.paths);
  const hosts = declaredValues(args, declared.hosts);
  const commands = declaredValues(args, declared.commands);
  if (!paths && !hosts && !commands) return undefined;
  return { ...(paths ? { paths } : {}), ...(hosts ? { hosts } : {}), ...(commands ? { commands } : {}) };
}

/**
 * The fields of the host source a decision was made for, copied when it is
 * captured (a host may change its source object in place): the goal, the
 * criteria, the transcript's length and last message, the selected diff.
 */
interface SourceFingerprint {
  readonly goal: unknown;
  readonly criteria: readonly unknown[] | undefined;
  readonly messages: number;
  readonly lastMessage: string | undefined;
  readonly diff: string | undefined;
}

function sourceFingerprint(value: unknown): SourceFingerprint {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<AutonomousToolSource>;
  const messages = Array.isArray(source.conversationContext) ? source.conversationContext : undefined;
  return {
    goal: source.goal,
    criteria: Array.isArray(source.criteria) ? [...source.criteria] : undefined,
    messages: messages?.length ?? -1,
    lastMessage: messages && messages.length > 0 ? JSON.stringify(messages[messages.length - 1]) : undefined,
    diff: source.selectedDiffContext === undefined ? undefined : JSON.stringify(source.selectedDiffContext),
  };
}

/**
 * Whether the host source now is the one a decision was made for: a field
 * compare against the captured fingerprint, never a copy or a schema parse of
 * the transcript.
 */
function sameSource(now: unknown, then: SourceFingerprint): boolean {
  const current = sourceFingerprint(now);
  return current.goal === then.goal && current.messages === then.messages && current.lastMessage === then.lastMessage
    && current.diff === then.diff && current.criteria?.length === then.criteria?.length
    && (current.criteria ?? []).every((criterion, index) => criterion === then.criteria?.[index]);
}

/** A session answer to an owner-only item is kept apart, so only it settles that item again. */
function ownerOnlySessionKey(kind: OwnerOnlyKind, key: string): string {
  return `owner-only:${kind}|${key}`;
}

/** A settings projector's stand-in for a value it could not see (a daemon-owned key, a credential's posture). */
function unseenPrevious(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Readonly<Record<string, unknown>>;
  return marker['unavailable'] === true || marker['redacted'] === true;
}

/**
 * Whether a settings write loosens what one of its keys protects, by the key's
 * declared loosening rule (config-key-facts.ts): raising a spending limit,
 * turning the sandbox off, a looser permission mode. The prepared write's own
 * facts are read when the registry holds them (every key it changes, the
 * normalized value, the value it replaces); otherwise the engine settings
 * tool's arguments. A previous value the write could not see is read from this
 * process's settings. Cost per call: nothing for any other tool; one facts
 * lookup and one compare per key written.
 */
function settingsWriteLoosens(toolName: string, args: Record<string, unknown>,
  evidence: ToolOwnedAdmissionEvidence | undefined, current: (key: string) => unknown): boolean {
  const writes: Array<{ readonly key: string; readonly next: unknown; readonly previous?: unknown }> = [];
  if (evidence?.kind === 'agent-settings') {
    const effect = evidence.effect;
    const seen = new Set<string>();
    // One setting carries its value (and what it replaces) at the top; a plan
    // or an import lists every change under `effects`, a daemon import under `remote.effects`.
    if (Object.hasOwn(effect, 'value')) {
      const previous = effect['previous'];
      writes.push({ key: evidence.key, next: effect['value'], ...(Object.hasOwn(effect, 'previous') && !unseenPrevious(previous) ? { previous } : {}) });
      seen.add(evidence.key);
    }
    const remote = effect['remote'];
    const lists = [effect['effects'], remote && typeof remote === 'object' ? (remote as Readonly<Record<string, unknown>>)['effects'] : undefined];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const change of list as unknown[]) {
        if (!change || typeof change !== 'object') continue;
        const { key, value } = change as { readonly key?: unknown; readonly value?: unknown };
        if (typeof key !== 'string' || seen.has(key)) continue;
        seen.add(key);
        writes.push({ key, next: value });
      }
    }
  } else if (toolName === 'goodvibes_settings' && typeof args.key === 'string' && (args.mode === 'set' || args.mode === 'reset')) {
    const key = args.key.trim();
    writes.push({ key, next: args.mode === 'set' ? args.value : readDotPath(DEFAULT_CONFIG, key).value });
  }
  return writes.some(({ key, next, ...rest }) => {
    const loosens = configKeyFacts(key).loosens;
    return loosens !== undefined && loosens('previous' in rest ? rest.previous : current(key), next);
  });
}

export interface PermissionConfigReader {
  /** Settle already-visible owner disk generations before capturing authority. Never called from a retained currentness check. */
  flushPendingChanges?(): void;
  /** Coherent owner-held frame. Must read owned state without invoking observers or host callbacks. */
  getAutonomousSnapshot?(): Readonly<{ permissions: PermissionConfigSnapshot['permissions']; autoApprove: boolean; directory: string | null; incarnation?: number }>;
  isAutoApproveEnabled(): boolean;
  /**
   * Whether a decision model works for the mode in force: it is set up to
   * answer (gate/presets.ts `decisionModelReady`), and, when the mode is the
   * shipped default rather than one the owner chose, a calibration run
   * measured the gate's decisions on it (gate/calibration.ts). Absent counts
   * as ready.
   */
  isDecisionModelReady?(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
  /**
   * One setting's current value, for the loosening rule of a settings write
   * (undefined when unknown; the rule then reads the strictest baseline).
   */
  getSetting?(key: string): unknown;
  /**
   * The `telemetry.decisionOtlp*` keys, as the exporter's own config shape.
   *
   * A method of its own rather than three more domains on
   * {@link PermissionConfigSnapshot}, so the narrowing above survives: a
   * stand-in reader that does not care about decision export omits this and
   * exports nothing, which is also the shipped default.
   */
  getDecisionOtlpConfig?(): DecisionOtlpConfig;
}

/** Read the three `telemetry.decisionOtlp*` keys into the exporter's config. */
function readDecisionOtlpConfig(configManager: Pick<ConfigManager, 'get'>): DecisionOtlpConfig {
  const signal = configManager.get('telemetry.decisionOtlpSignal');
  return {
    enabled: configManager.get('telemetry.decisionOtlpEnabled') === true,
    endpoint: String(configManager.get('telemetry.decisionOtlpEndpoint') ?? ''),
    // A hand-edited settings file is the only way to get something outside the
    // enum here, and spans are the shape the key ships with.
    signal: signal === 'log' || signal === 'both' ? signal : 'span',
  };
}

const permissionConfigOwners = new WeakMap<PermissionConfigReader, object>();
const nativePermissionConfigs = new WeakMap<PermissionConfigReader, {
  readonly owner: PermissionConfigurationOwner;
  readonly snapshot: NonNullable<PermissionConfigReader['getAutonomousSnapshot']>;
}>();

/** Native revisions avoid repeated serialization; custom readers retain exact snapshots. */
function capturePermissionConfiguration(reader: PermissionConfigReader, read: () => unknown, captured: unknown): () => void {
  const native = nativePermissionConfigs.get(reader);
  if (native && Object.getOwnPropertyDescriptor(reader, 'getAutonomousSnapshot')?.value === native.snapshot) {
    const unchanged = native.owner.captureRevision();
    return () => {
      if (Object.getOwnPropertyDescriptor(reader, 'getAutonomousSnapshot')?.value !== native.snapshot || !unchanged()) {
        throw new Error('Permission configuration changed while deciding');
      }
    };
  }
  const original = captureJsonEntry(captured);
  return () => {
    if (!isDeepStrictEqual(captureJsonEntry(read()), original)) throw new Error('Permission configuration changed while deciding');
  };
}

export function createPermissionConfigReader(
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'> & Partial<Pick<ConfigManager, 'getAutonomousPermissionSnapshot' | 'flushConfigFileChanges' | 'isExplicitlySet'>>,
): PermissionConfigReader {
  const snapshotAccessor = configManager.getAutonomousPermissionSnapshot;
  const permissionSnapshot = snapshotAccessor?.bind(configManager);
  const flushPendingChanges = configManager.flushConfigFileChanges?.bind(configManager);
  const reader: PermissionConfigReader = {
    ...(flushPendingChanges ? { flushPendingChanges } : {}),
    ...(permissionSnapshot ? { getAutonomousSnapshot: permissionSnapshot } : {}),
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    isDecisionModelReady: () => {
      const model = configManager.get('judgment.model');
      if (!decisionModelReady({
        policy: configManager.get('judgment.policy'), endpoint: configManager.get('judgment.endpoint'), model,
        keySource: configManager.get('judgment.keySource'), keyName: configManager.get('judgment.keyName'),
      })) return false;
      // The owner's own choice of mode stands on a working model; the shipped
      // default hands decisions to Jev only once they were measured on it.
      return configManager.isExplicitlySet?.('permissions.mode') !== false || gateDecisionsCalibrated(String(model ?? ''));
    },
    getSnapshot: permissionSnapshot
      ? () => ({ permissions: permissionSnapshot().permissions })
      : () => getConfigSnapshot(configManager),
    getWorkingDirectory: () => configManager.getWorkingDirectory(),
    getSetting: (key) => {
      try { return configManager.get(key as ConfigKey); } catch { return undefined; }
    },
    // Read per decision, not captured: switching export on is a live change.
    getDecisionOtlpConfig: () => readDecisionOtlpConfig(configManager),
  };
  permissionConfigOwners.set(reader, configManager);
  const native = retainPermissionConfigurationOwner(configManager, snapshotAccessor);
  if (native && permissionSnapshot) nativePermissionConfigs.set(reader, { owner: native, snapshot: permissionSnapshot });
  return reader;
}

/** Owner tool denials are independent of which safe execution mode judges risk. */
const TOOL_CONFIG_KEYS: Readonly<Record<string, keyof PermissionsToolConfig>> = {
  read: 'read', write: 'write', edit: 'edit', exec: 'exec', find: 'find', fetch: 'fetch',
  analyze: 'analyze', inspect: 'inspect', agent: 'agent', state: 'state', workflow: 'workflow',
  registry: 'registry', goodvibes_context: 'state', goodvibes_settings: 'write', delegate: 'delegate', mcp: 'mcp',
};

/** How the gate learns who is asking and what the turn has read. */
export interface GateOptions {
  /** Bookkeeping bounds; the defaults are far beyond any one turn. Tests lower them. */
  readonly bookkeepingLimits?: { readonly ownerRevisions?: number; readonly retiredClaims?: number } | undefined;
  /** Explicit null declares no workspace policy. Explicit undefined refuses
   * non-read effects; absent property preserves raw embedding compatibility. */
  readonly workspaceTrust?: Pick<import('../runtime/workspace-trust.js').WorkspaceTrustManager, 'prepareAutonomousConstraint'> | null | undefined;
  /** Trusted host alternatives; never populated from model-authored executable prose. */
  readonly autonomousChoices?: ((sourceId: string) => AutonomousToolChoices) | undefined;
  /**
   * The surface the current turn's instruction came from (gate/surface-authority.ts);
   * defaults to the turn boundary's record (security/turn-boundary.ts).
   * Returning undefined means the owner gave the instruction directly.
   */
  readonly surfaceOf?: (() => string | undefined) | undefined;
  /** The untrusted-content ledger; the process ledger when absent. */
  readonly ledger?: UntrustedContentLedger | undefined;
  /** Where just-vibes holds calls for the owner; the process's ledger when absent. */
  readonly heldForOwner?: HeldForOwnerLedger | undefined;
  /** Where the calls Jev decides are kept for the owner's `/decisions`; the process's ledger when absent. */
  readonly jevDecisions?: JevDecisionLedger | undefined;
}

/** A host-bound decision for the selected execution mode and exact current action. */
export interface AutonomousPermissionAdmission {
  readonly result: PermissionCheckResult;
  readonly revision?: AutonomousToolRevision | undefined;
  readonly revisionIds: readonly string[];
  /** Call once, synchronously after the final reentrant hook and before the body. */
  claim(): void;
}

export interface AutonomousPermissionOptions extends PermissionExecutionOptions {
  /** Opaque, detached adapter evidence; never an authority override. */
  readonly externalRequestEvidence?: ExternalRequestEvidence | undefined;
  readonly decoratePort?: ((port: JudgmentPort) => JudgmentPort) | undefined;
  /** Handle minted by this manager before any logical-call preparation. */
  readonly choiceProjection?: AutonomousChoiceProjection | undefined;
  readonly sourceOf: () => AutonomousToolSource;
  readonly consumedRevisions?: readonly string[];
  readonly permittedRevisionIds?: readonly string[];
  readonly schemaRevision?: string;
  readonly preparationDecisionIds?: readonly string[];
  readonly assertPrepared?: () => void;
  /** Exact registry-owned call. Required to authenticate a strict tool body. */
  readonly preparedCall?: Readonly<{ registry: ToolRegistry; call: PreparedToolCall }> | undefined;
  /**
   * The owner confirmed this exact call himself: a form he filled in and
   * answered yes to (`ToolRegistry.executeOwnerConfirmed`). A fact (a deny
   * rule, plan mode, a refused decision) still decides; nobody is asked again.
   */
  readonly ownerConfirmed?: boolean | undefined;
}

interface AuthenticAutonomousAdmission {
  readonly issuer: PermissionManager;
  readonly registry?: ToolRegistry | undefined;
  readonly call?: PreparedToolCall | undefined;
  readonly claim: () => void;
  readonly assertCurrent: () => void;
  readonly assertWorkspace: () => void;
  readonly assertEffect: (effect: ToolExecutionEffect) => void;
  readonly nestedOwner: AutonomousNestedOwner;
  readonly settingsBinding?: ToolPreparedSettingsMutation | undefined;
  readonly nestedSettingsBindings: Set<ToolPreparedSettingsMutation>;
  readonly parents: Set<AuthenticAutonomousAdmission>;
  readonly assertConfigTransition?: ((binding: ToolPreparedSettingsMutation, transition: PreparedConfigMutationTransition) => void) | undefined;
  readonly completeConfigTransition: (binding: ToolPreparedSettingsMutation, transition: PreparedConfigMutationTransition) => void;
  readonly settingsPresentation?: Readonly<{ previous: unknown; current: unknown }> | undefined;
  consumed: boolean;
  externalPhase?: 'claiming' | 'active' | 'closed';
  externalChecking?: boolean;
}

// Only this manager can issue a current, single-use tool execution admission.
// Public admission objects and claim callbacks are not themselves capabilities.
const authenticAutonomousAdmissions = new WeakMap<AutonomousPermissionAdmission, AuthenticAutonomousAdmission>();
const authenticConfigTransitions = new WeakMap<() => void, NonNullable<AuthenticAutonomousAdmission['assertConfigTransition']>>();
const consumedAdmissionRecords = new WeakMap<() => void, AuthenticAutonomousAdmission>();
const workspaceConstraints = new WeakMap<() => void, () => void>();
const effectConstraints = new WeakMap<() => void, (effect: ToolExecutionEffect) => void>();

/** @internal Original recorded source retained only by consumed execution guards. */
export interface AutonomousNestedOwner {
  readonly manager: PermissionManager;
  readonly source: AutonomousToolSource;
  readonly decoratePort: AutonomousPermissionOptions['decoratePort'];
}
const nestedOwners = new WeakMap<() => void, AutonomousNestedOwner>();

/** Consume a recorded native protocol act once, without creating a tool-body capability. */
export function claimExternalAdmission(admission: AutonomousPermissionAdmission,
  expectedIssuer: Pick<PermissionManager, 'admitAutonomous'>, effect: ToolExecutionEffect | 'read' = 'write'): void {
  const record = authenticAutonomousAdmissions.get(admission);
  if (!record || record.issuer !== expectedIssuer || record.registry || record.call || record.consumed) throw new ToolInputProjectionError('held');
  record.consumed = true; record.externalPhase = 'claiming';
  try {
    record.claim(); record.assertCurrent();
    if (effect !== 'read') record.assertEffect(effect);
    if (record.externalPhase !== 'claiming') throw new ToolInputProjectionError('stale');
    record.externalPhase = 'active';
  } catch (error) { record.externalPhase = 'closed'; throw error; }
}

/** Only the authentic consumed external act retains its original live authority. */
export function assertCurrentExternalAdmission(admission: AutonomousPermissionAdmission,
  expectedIssuer: Pick<PermissionManager, 'admitAutonomous'>, effect: ToolExecutionEffect | 'read' = 'write'): void {
  const record = authenticAutonomousAdmissions.get(admission);
  if (!record || record.issuer !== expectedIssuer || record.registry || record.call
    || !record.consumed || record.externalPhase !== 'active') throw new ToolInputProjectionError('held');
  if (record.externalChecking) { record.externalPhase = 'closed'; throw new ToolInputProjectionError('stale'); }
  record.externalChecking = true;
  try {
    record.assertCurrent(); if (effect !== 'read') record.assertEffect(effect);
    if (record.externalPhase !== 'active') throw new ToolInputProjectionError('stale');
  } catch (error) { record.externalPhase = 'closed'; throw error; }
  finally { record.externalChecking = false; }
}

/** Closing an authentic native act is irreversible and cannot retire a registered tool admission. */
export function closeExternalAdmission(admission: AutonomousPermissionAdmission,
  expectedIssuer: Pick<PermissionManager, 'admitAutonomous'>): void {
  const record = authenticAutonomousAdmissions.get(admission);
  if (!record || record.issuer !== expectedIssuer || record.registry || record.call) throw new ToolInputProjectionError('held');
  record.consumed = true; record.externalPhase = 'closed';
}

/** @internal Exact consumed guard required; caller data never selects a source. */
export function readAutonomousNestedOwner(guard: () => void): AutonomousNestedOwner | undefined {
  return nestedOwners.get(guard);
}

/** @internal Restriction-only capability for captured jobs with a separate owner lifetime. */
export function readAutonomousWorkspaceConstraint(guard: () => void): (() => void) | undefined {
  return workspaceConstraints.get(guard);
}

/** @internal Only an exact consumed admission carries these owner-held effect restrictions. */
export function readAutonomousEffectConstraint(guard: () => void): ((effect: ToolExecutionEffect) => void) | undefined {
  return effectConstraints.get(guard);
}

const settingsPresentations = new WeakMap<() => void, Readonly<{ previous: unknown; current: unknown }>>();

/** @internal Data-only display result from the same recorded pre-admission observations. */
export function readAutonomousSettingsPresentation(guard: () => void): Readonly<{ previous: unknown; current: unknown }> | undefined {
  return settingsPresentations.get(guard);
}

/** @internal Only the consumed, exact invocation guard can validate its own owner transition. */
export function assertAutonomousConfigTransition(assertCurrent: () => void, binding: ToolPreparedSettingsMutation,
  transition: PreparedConfigMutationTransition): void {
  const check = authenticConfigTransitions.get(assertCurrent);
  if (!check) throw new Error('Autonomous settings transition has no authentic execution owner');
  // The exact mutation transition may fence several companion effects; the
  // effect owner and registry each consume their handles once. No generation waiver.
  check(binding, transition);
}

/** @internal Registry-only bridge: the admitted child is the sole new effect owner. */
export function bindAutonomousNestedAdmission(parentGuard: () => void, child: AutonomousPermissionAdmission): void {
  const parent = consumedAdmissionRecords.get(parentGuard), nested = authenticAutonomousAdmissions.get(child);
  if (!parent || !nested || nested.consumed || parent.issuer !== nested.issuer || parent.registry !== nested.registry) {
    throw new ToolInputProjectionError('held');
  }
  parent.assertCurrent();
  if (nested.settingsBinding) {
    parent.assertEffect('write');
    const bind = (owner: AuthenticAutonomousAdmission) => {
      owner.nestedSettingsBindings.add(nested.settingsBinding!);
      for (const ancestor of owner.parents) bind(ancestor);
    };
    bind(parent);
  }
  nested.parents.add(parent);
}

/** @internal A completed exact native transaction alone may advance retained authority. */
export function completeAutonomousConfigTransition(guard: () => void, binding: ToolPreparedSettingsMutation,
  transition: PreparedConfigMutationTransition): void {
  const record = consumedAdmissionRecords.get(guard);
  if (!record) throw new ToolInputProjectionError('held');
  record.completeConfigTransition(binding, transition);
}

/** @internal Identity-only compatibility query. Never validates, consumes or creates authority. */
export function isAuthenticAutonomousAdmission(admission: unknown): boolean {
  // Retain the brand after consumption or revocation: a stale genuine admission
  // must still take strict object validation, never the legacy callback path.
  return admission !== null && typeof admission === 'object'
    && authenticAutonomousAdmissions.has(admission as AutonomousPermissionAdmission);
}

/** @internal Consume-only bridge for the registry; deliberately no token factory. */
export function consumeAutonomousAdmission(admission: AutonomousPermissionAdmission, registry: ToolRegistry,
  call: PreparedToolCall, expectedIssuer?: PermissionManager): () => void {
  const record = authenticAutonomousAdmissions.get(admission);
  if (!record || record.consumed || record.registry !== registry || record.call !== call
    || (expectedIssuer !== undefined && record.issuer !== expectedIssuer)) {
    throw new Error('Autonomous admission does not authenticate this prepared tool call');
  }
  record.consumed = true;
  record.claim();
  consumedAdmissionRecords.set(record.assertCurrent, record);
  workspaceConstraints.set(record.assertCurrent, record.assertWorkspace);
  effectConstraints.set(record.assertCurrent, record.assertEffect);
  nestedOwners.set(record.assertCurrent, record.nestedOwner);
  if (record.assertConfigTransition) authenticConfigTransitions.set(record.assertCurrent, record.assertConfigTransition);
  if (record.settingsPresentation) settingsPresentations.set(record.assertCurrent, record.settingsPresentation);
  return record.assertCurrent;
}

/** What the manager needs from the durable rule store; older embeddings may omit the optional members. */
type PermissionRuleStoreAccess = Pick<UserPermissionRuleStore, 'rules' | 'add'>
  & Partial<Pick<UserPermissionRuleStore, 'init' | 'awaitReady' | 'getPublicationRevision' | 'committedRevision' | 'remember' | 'rememberedRules' | 'evaluationRules'>>;

/** Owner-edited revisions waiting for re-admission; the oldest is dropped (and would be asked again) past this. */
/** The hosted session whose call is being decided, so a session-tier answer stays with it. */
const sessionOfCheck = new AsyncLocalStorage<string | undefined>();

const OWNER_REVISION_CAPACITY = 10_000;
/**
 * Settled calls whose claim is still remembered so a replay of the same call is
 * refused. A source id is one (session, turn, call) tuple, so it can only be
 * presented again within its own turn; a claim is forgotten only after this many
 * LATER calls have settled, far more than any one turn can issue.
 */
const RETIRED_CLAIM_RETENTION = 4_096;

export class PermissionManager {
  private readonly autonomousChoiceProjections = new AutonomousChoiceProjectionOwner();
  private readonly autonomousPending = new Set<string>();
  private readonly autonomousEpochs = new Map<string, number>();
  private readonly autonomousClaims = new Set<string>();
  /** Claims of settled calls, oldest first; the only claims that may ever be forgotten. */
  private readonly retiredClaims = new Set<string>();
  private readonly ownerRevisions = new Map<string, { readonly toolName: string; readonly args: Readonly<Record<string, unknown>>; readonly authority: EntryType }>();
  private ownerRevisionSequence = 0;
  /**
   * Explicit session-tier decisions only; durable rules are always matched live.
   * Read live by each decision rather than captured in the admission frame: a
   * grant recorded from an owner's answer must not invalidate the very call
   * that answer admitted, and an added grant only affects later decisions.
   */
  private readonly sessionApprovals = new Map<string, boolean>();
  private sessionApprovalRevision = 0;
  private readonly requestPermission: PermissionRequestHandler;
  private readonly configReader: PermissionConfigReader;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly userRuleStore: PermissionRuleStoreAccess | null;
  private readonly gate: GateOptions;

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader,
    policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
    featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null = null,
    userRuleStore: PermissionRuleStoreAccess | null = null,
    gate: GateOptions = {},
  ) {
    this.requestPermission = requestPermission;
    this.configReader = configReader;
    this.policyRuntimeState = policyRuntimeState;
    this.hookDispatcher = hookDispatcher;
    this.featureFlags = featureFlags;
    this.userRuleStore = userRuleStore;
    this.gate = { surfaceOf: currentTurnSurfaceId, ...gate };
  }

  /** Settle the existing rule/config owners before taking a new authority snapshot. */
  async prepareAutonomousOwner(signal?: AbortSignal): Promise<void> {
    assertPermissionActive(signal);
    const owner = this.userRuleStore;
    // Production stores distinguish load failure from their legacy empty-rule
    // fallback. Older embedding stores retain their existing init contract.
    // Yolo consults no remembered rule, so an unreadable rule file does not
    // refuse its calls.
    const ready = this.getMode() === 'yolo' ? undefined : owner?.awaitReady ?? owner?.init;
    if (ready) await awaitPermission(() => ready.call(owner), signal);
    assertPermissionActive(signal);
    this.configReader.flushPendingChanges?.();
    assertPermissionActive(signal);
  }

  private autonomousAuthority(sourceId: string, sourceOf: () => AutonomousToolSource, choiceProjection?: AutonomousChoiceProjection,
    _purpose: 'admission' | 'currentness' = 'admission') {
    // Stage host callbacks first. The subsequent source/config/store copies are
    // owned data reads, not a sequence interleaving observers with sampled fields.
    const choices = this.gate.autonomousChoices?.(sourceId) ?? {};
    const surface = this.gate.surfaceOf?.();
    const source = sourceOf();
    const rules = this.userRuleStore?.rules(this.configReader.getWorkingDirectory()) ?? [];
    const rulePublication = this.userRuleStore?.getPublicationRevision?.() ?? 0;
    const policyRegistry = this.policyRuntimeState.getRegistry();
    const policyRules = policyRegistry.getCurrent()?.rules ?? [];
    const policyPublication = policyRegistry.getPublicationRevision?.() ?? 0;
    const policyEnabled = this.featureFlags?.isEnabled('permissions-policy-engine') === true;
    const ledger = this.gate.ledger ?? getProcessUntrustedContentLedger();
    const exposure = ledger.ingestedThisTurn();
    const coverage = ledger.captureTaintEvidence('turn');
    const scope = this.configReader.getAutonomousSnapshot?.();
    if (!scope) throw new Error('Autonomous execution requires a coherent permission owner snapshot');
    assertAutonomousData(scope);
    const executionOwner = currentExecutionModeOwner();
    const mode = executionOwner ? this.ownerMode(executionOwner) : effectivePermissionMode(scope.permissions.mode, scope.autoApprove, this.decisionModelWorks());
    const frame = { ...scope, permissions: { ...scope.permissions, mode }, autoApprove: false,
      executionOwnerRevision: executionOwner?.getRevision(), source, surface, rules, rulePublication, policyRules, policyPublication, policyEnabled,
      exposure,
      exposureCoverage: { complete: coverage.complete, revision: coverage.revision } };
    assertAutonomousData(choices);
    assertAutonomousData(frame);
    const { source: capturedSource, evidence: sourceEvidence } = captureCurrentAutonomousSourceFrame(source);
    const normalizedFrame = { ...frame, source: sourceEvidence };
    // Local structural identity preserves revocation without sending tool input to Jev.
    const ownedFrame = captureOwnedJson(normalizedFrame) as Record<string, unknown>;
    const captured = Object.freeze({ ...ownedFrame, source: capturedSource, autonomousChoices: captureCurrentAutonomousChoices(choices) });
    return choiceProjection === undefined ? captured : Object.freeze({ ...captured,
      autonomousChoices: this.autonomousChoiceProjections.choices(choiceProjection, sourceId, captured) });
  }

  /**
   * The revisions of every owner one decision reads, captured once (B1). The
   * checks compare integers and identities and look at the host source's own
   * fields; nothing is copied, serialised or deep-compared, so a check costs
   * the same with 0 or 500 remembered rules and any transcript length.
   * `assertSettings` is apart because a settings change the call itself makes
   * moves that revision on purpose.
   */
  private authorityRevisions(sourceOf: () => AutonomousToolSource): { readonly assertOwners: () => void; readonly assertSettings: () => void } {
    const store = this.userRuleStore;
    const registry = this.policyRuntimeState.getRegistry();
    const rulesRevision = () => store?.committedRevision?.() ?? store?.getPublicationRevision?.() ?? 0;
    const policyRevision = () => registry.getPublicationRevision?.() ?? 0;
    const policyEnabled = () => this.featureFlags?.isEnabled('permissions-policy-engine') === true;
    const rules = rulesRevision(), policy = policyRevision(), enabled = policyEnabled();
    const executionOwner = currentExecutionModeOwner();
    const ownerRevision = executionOwner?.getRevision();
    const surface = this.gate.surfaceOf?.();
    const directory = this.configReader.getWorkingDirectory();
    const choices = this.gate.autonomousChoices;
    const exposure = (this.gate.ledger ?? getProcessUntrustedContentLedger()).captureTaintEvidence('turn');
    const source = sourceFingerprint(sourceOf());
    const read = () => this.configReader.getAutonomousSnapshot?.() ?? {
      permissions: this.configReader.getSnapshot().permissions,
      autoApprove: this.configReader.isAutoApproveEnabled(), directory: this.configReader.getWorkingDirectory(),
    };
    const assertSettings = capturePermissionConfiguration(this.configReader, read, read());
    return Object.freeze({
      assertSettings,
      assertOwners: () => {
        if (rulesRevision() !== rules || policyRevision() !== policy || policyEnabled() !== enabled
          || currentExecutionModeOwner() !== executionOwner || executionOwner?.getRevision() !== ownerRevision
          || this.gate.surfaceOf?.() !== surface || this.configReader.getWorkingDirectory() !== directory
          || this.gate.autonomousChoices !== choices) {
          throw new Error('Autonomous admission authority, source or scope changed');
        }
        exposure.assertCurrent();
        if (!sameSource(sourceOf(), source)) throw new Error('Autonomous admission authority, source or scope changed');
      },
    });
  }

  /** Project the complete host catalog before initial preparation or admission. */
  async projectAutonomousChoices(sourceId: string, callId: string, sourceOf: () => AutonomousToolSource,
    registry: ToolRegistry, signal?: AbortSignal): Promise<AutonomousChoiceProjection> {
    assertPermissionActive(signal);
    if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
    let captured = false;
    return this.autonomousChoiceProjections.project(sourceId, callId, registry, () => {
      // The owner asks once for its baseline, then only for complete equality
      // checks against the same host-owned frame.
      const authority = this.autonomousAuthority(sourceId, sourceOf, undefined, captured ? 'currentness' : 'admission');
      captured = true;
      return authority;
    }, signal);
  }

  /** Release every alternative after the entire logical call, including unused alternatives. */
  releaseAutonomousChoices(projection: AutonomousChoiceProjection): Promise<void> {
    return this.autonomousChoiceProjections.release(projection);
  }

  /**
   * A call that has settled keeps no live admission epoch and no pending owner
   * edit. Its claim stays, so a replay of the same call is still refused, but
   * only for the retention window above; the per-call bookkeeping would
   * otherwise grow with every tool call of the session.
   */
  retireAutonomousSource(sourceId: string): void {
    if (this.autonomousPending.has(sourceId)) return;
    this.autonomousEpochs.delete(sourceId);
    this.ownerRevisions.delete(sourceId);
    if (!this.autonomousClaims.has(sourceId)) return;
    this.retiredClaims.delete(sourceId);
    this.retiredClaims.add(sourceId);
    const retention = this.gate.bookkeepingLimits?.retiredClaims ?? RETIRED_CLAIM_RETENTION;
    while (this.retiredClaims.size > retention) {
      const oldest = this.retiredClaims.values().next();
      if (oldest.done) break;
      this.retiredClaims.delete(oldest.value);
      this.autonomousClaims.delete(oldest.value);
    }
  }

  /** The same live authority owns pre-admission argument-repair judgment. */
  autonomousPreparation(sourceId: string, sourceOf: () => AutonomousToolSource, signal?: AbortSignal, decoratePort?: (port: JudgmentPort) => JudgmentPort, _choiceProjection?: AutonomousChoiceProjection): { readonly port: JudgmentPort; assertCurrent(): void } {
    assertPermissionActive(signal);
    this.assertSelectedModeCurrent();
    const revisions = this.authorityRevisions(sourceOf);
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous preparation authority changed or source was claimed');
      revisions.assertOwners(); revisions.assertSettings();
    };
    let installed: JudgmentPort | undefined;
    const owner = () => {
      if (!installed) {
        const base = judgmentPort('engine.gate.autonomous-preparation');
        installed = decoratePort?.(base) ?? base;
      }
      return installed;
    };
    const port: JudgmentPort = {
      get model() { return owner().model; },
      // The recorder facade is lazy too: ordinary YOLO preparation never acquires Jev.
      recorder: {
        recordReadings(id, readings) {
          const recorder = owner().recorder;
          if (!recorder) throw new JudgmentError('unrecorded', 'judgment requires recorded provenance');
          recorder.recordReadings(id, readings);
        },
        recordAction(id, action) {
          const recorder = owner().recorder;
          if (!recorder) throw new JudgmentError('unrecorded', 'judgment requires recorded provenance');
          recorder.recordAction(id, action);
        },
      },
      ask(request) {
        assertCurrent();
        const prior = request.beforeAttempt;
        return awaitPermission(() => owner().ask({ ...request, beforeAttempt() { assertCurrent(); assertSynchronousJudgmentGuard(() => prior?.()); } }), signal);
      },
    };
    return { port, assertCurrent };
  }

  /**
   * Bind a tool invocation to the selected execution mode and its exact prepared body.
   */
  async admitAutonomous(
    sourceId: string,
    toolName: string,
    preparedArgs: Record<string, unknown>,
    options: AutonomousPermissionOptions,
  ): Promise<AutonomousPermissionAdmission> {
    assertPermissionActive(options.signal);
    this.assertSelectedModeCurrent();
    if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
    if (this.autonomousPending.has(sourceId)) throw new Error('Autonomous admission is already pending for this source');
    const epoch = (this.autonomousEpochs.get(sourceId) ?? 0) + 1;
    this.autonomousEpochs.set(sourceId, epoch);
    this.autonomousPending.add(sourceId);
    try {
      await this.prepareAutonomousOwner(options.signal);
      return await this.decideAutonomous(sourceId, toolName, preparedArgs, options, epoch);
    }
    finally { this.autonomousPending.delete(sourceId); }
  }

  private async autonomousWorkspaceConstraint(category: PermissionCategory, signal?: AbortSignal): Promise<() => void> {
    if (!Object.prototype.hasOwnProperty.call(this.gate, 'workspaceTrust')) return () => {};
    const owner = this.gate.workspaceTrust;
    const prepare = owner?.prepareAutonomousConstraint;
    if (owner === undefined && category !== 'read') throw new Error('Autonomous execution requires an explicit workspace trust capability');
    if (owner != null && typeof prepare !== 'function') throw new Error('Workspace trust capability cannot enforce current policy');
    const guard = await prepare?.call(owner, category, signal);
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.gate.workspaceTrust !== owner || owner?.prepareAutonomousConstraint !== prepare) throw new Error('Workspace trust capability changed');
      assertProjectionCurrent(guard);
    };
    assertCurrent();
    return assertCurrent;
  }

  private async decideAutonomous(sourceId: string, toolName: string, preparedArgs: Record<string, unknown>, options: AutonomousPermissionOptions, epoch: number): Promise<AutonomousPermissionAdmission> {
    const signal = options.signal;
    assertPermissionActive(signal);
    const args = captureOwnedJson(preparedArgs) as Record<string, unknown>;
    const sourceOf = options.sourceOf;
    const choiceProjection = options.choiceProjection;
    const schemaRevision = options.schemaRevision;
    const externalRequestToken = projectionProperty(options, 'externalRequestEvidence');
    const externalRequestEvidence = readExternalRequestEvidence(externalRequestToken);
    const suppliedPrepared = projectionProperty(options, 'preparedCall');
    if (suppliedPrepared !== undefined && (!suppliedPrepared || typeof suppliedPrepared !== 'object')) {
      throw new Error('Autonomous admission requires a registry-owned prepared call');
    }
    const preparedCall = suppliedPrepared === undefined ? undefined : Object.freeze({
      registry: projectionProperty(suppliedPrepared as object, 'registry') as ToolRegistry,
      call: projectionProperty(suppliedPrepared as object, 'call') as PreparedToolCall,
    });
    if (preparedCall) {
      preparedCall.registry.assertPrepared(preparedCall.call);
      if (preparedCall.call.name !== toolName || preparedCall.call.args !== preparedArgs
        || preparedCall.call.schemaRevision !== schemaRevision) throw new Error('Autonomous admission prepared call binding changed');
    }
    const admissionEvidence = preparedCall?.registry.readPreparedOwnedAdmissionEvidence(preparedCall.call);
    const definition = preparedCall?.registry.readPreparedDefinition(preparedCall.call);
    const category = admissionEvidence?.kind === 'agent-settings' ? 'write'
      : preparedCall?.registry.isPreparedReadOnly(preparedCall.call) ? 'read' : this.getCategory(toolName, args, definition);
    const assertWorkspace = await this.autonomousWorkspaceConstraint(category, signal);
    const settingsMutation = preparedCall?.registry.readPreparedSettingsMutation(preparedCall.call);
    // The one deep capture: what the decision reads and records. Currentness
    // afterwards is the owners' revisions, compared as integers.
    const rawAuthority = this.autonomousAuthority(sourceId, sourceOf);
    const revisions = this.authorityRevisions(sourceOf);
    const capturedAuthority = (choiceProjection === undefined ? rawAuthority : Object.freeze({ ...rawAuthority,
      autonomousChoices: this.autonomousChoiceProjections.choices(choiceProjection, sourceId, rawAuthority) })) as AutonomousPermissionOwner & {
        source: AutonomousToolSource; autonomousChoices: AutonomousToolChoices; directory: string | null; permissions: PermissionConfigSnapshot['permissions']; autoApprove: boolean; surface?: string | undefined;
      };
    const source = capturedAuthority.source;
    const authoritySnapshot = captureJsonEntry(capturedAuthority);
    const authorityRevision = `admission-${epoch.toString(36)}`;
    const assertPrepared = projectionFunction<() => void>(projectionProperty(options, 'assertPrepared'));
    const assertCurrent = () => {
      assertPermissionActive(signal); assertWorkspace();
      if (this.autonomousEpochs.get(sourceId) !== epoch) throw new Error('Autonomous admission was superseded');
      // Stage the compatibility callback before the final owner snapshot: it
      // may publish a revocation even when it returns normally.
      assertProjectionCurrent(assertPrepared);
      revisions.assertOwners(); revisions.assertSettings();
      if (preparedCall) preparedCall.registry.assertPrepared(preparedCall.call);
      if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
      assertWorkspace();
    };
    assertCurrent();
    const analysis = analyzePermissionRequest(toolName, args, category);
    this.policyRuntimeState.recordPermissionRequest({ callId: sourceId, tool: toolName, category, analysis });
    const permissions = capturedAuthority.permissions;
    const mode = effectivePermissionMode(permissions?.mode, capturedAuthority.autoApprove === true, this.decisionModelWorks());
    const preset = presetForMode(mode);
    const effectReadOnly = preset.readOnly;
    const effectSurface = capturedAuthority.surface;
    const effectWriteDenied = mode !== 'yolo' && permissions.tools?.write === 'deny';
    const owner = { frame: capturedAuthority, assertCurrent };
    const ownerOnly = recognizeOwnerOnly(toolName, args, definition, this.settingsFacts(toolName, args, admissionEvidence));
    const subjects = callSubjects(args, definition);
    const durable = mode === 'yolo' ? null : await this.rememberedDecision(this.getApprovalKey(toolName, args, options.hookOwner?.sessionId), toolName, args, { signal, assertCurrent }, owner, ownerOnly, subjects);
    const policy = mode !== 'yolo' && capturedAuthority.policyEnabled
      ? this.mapEvaluatorDecision(await this.evaluateRuntimePolicy(toolName, args, mode, this.policyClassification(category), { signal, assertCurrent }, owner, subjects), analysis)
      : null;
    // A link inside an allowed folder can lead to a path the owner denied: that denial applies too.
    const landed = mode !== 'yolo' && durable?.effect !== 'deny'
      ? await this.deniedWhereLinksLead(toolName, args, { signal, assertCurrent }, owner, options.hookOwner?.sessionId)
      : null;
    const exposure = (rawAuthority as Readonly<Record<string, unknown>>)['exposure'];
    const decided = classifyCall(mode, this.callFacts({
      toolName, args, category, mode, surface: effectSurface, definition, ownerOnly,
      directory: capturedAuthority.directory, tools: permissions.tools, remembered: durable, landed, policy,
      untrustedRead: Array.isArray(exposure) && exposure.length > 0,
      declaredReadOnly: preparedCall?.registry.isPreparedReadOnly(preparedCall.call) === true,
    }));
    const policyResult = this.policyResultOf(decided, analysis);
    const safety = await this.assessExecutionSafety({
      callId: sourceId, toolName, args, category, policyResult, decided, mode, signal, assertCurrent,
      workingDirectory: capturedAuthority.directory ?? undefined, source,
      sourceId, actionRevision: `action-${epoch.toString(36)}`, authorityRevision, authoritySnapshot,
      supportingIds: options.preparationDecisionIds ?? [], decoratePort: options.decoratePort,
      ...(options.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    });
    const result = safety.result;
    // The owner answered a channel's request himself: his approval is the authority the channel lacked.
    const ownerDirected = decided.kind === 'owner-only' && decided.item === 'channel-request' && result.approved && result.sourceLayer === 'user_prompt';
    this.policyRuntimeState.recordPermissionDecision({ callId: sourceId, tool: toolName, category, result });
    this.noteJevDecision(toolName, args, result, definition);
    assertCurrent();
    const admission: AutonomousPermissionAdmission = Object.freeze({
      result, revisionIds: Object.freeze(safety.revision ? [safety.revision.ref.id] : []),
      ...(safety.revision ? { revision: safety.revision } : {}),
      claim: () => {
        if (!result.approved) throw new Error('Owner policy denied this tool call');
        // A Jev decision's claim runs this same check once, then records the claim.
        if (safety.recordClaim) safety.recordClaim(); else assertCurrent();
        this.autonomousClaims.add(sourceId);
      },
    });
    if (result.approved) {
      let acceptedIncarnation = (rawAuthority as Readonly<Record<string, unknown>>)['incarnation'];
      // The settings as stored (the admitted mode may come from the execution owner
      // instead). The snapshot is kept by reference and serialised only when the
      // call starts a settings change; most calls never do.
      const admittedPermissions = this.configReader.getAutonomousSnapshot?.()?.permissions;
      let acceptedPermissions: string | undefined;
      let settingsCurrent = revisions.assertSettings;
      const currentIncarnation = () => (this.configReader.getAutonomousSnapshot?.() as Readonly<Record<string, unknown>> | undefined)?.['incarnation'];
      let activeTransition: { readonly binding: ToolPreparedSettingsMutation; readonly transition: PreparedConfigMutationTransition } | undefined;
      const nestedSettingsBindings = new Set<ToolPreparedSettingsMutation>();
      const parents = new Set<AuthenticAutonomousAdmission>();
      const assertOwnedLifetime = () => {
        assertPermissionActive(signal); assertWorkspace();
        if (this.autonomousEpochs.get(sourceId) !== epoch || !this.autonomousClaims.has(sourceId)) {
          throw new Error('Autonomous execution admission is stale');
        }
      };
      const assertTransitionBinding = (actual: ToolPreparedSettingsMutation) => {
        assertOwnedLifetime();
        if (!actual.mutation || (actual !== settingsMutation && !nestedSettingsBindings.has(actual))
          || permissionConfigOwners.get(this.configReader) !== actual.owner) throw new Error('Autonomous settings owner or invocation changed');
        return actual.mutation;
      };
      const assertAuthority = () => {
        // Native protocol producers retain their original request/target lease
        // through publication. Registry preparation guards are consumed at claim.
        if (!preparedCall) assertProjectionCurrent(assertPrepared);
        assertOwnedLifetime();
        revisions.assertOwners();
        if (activeTransition) {
          // The settings change this call is making moves the settings revision by exactly one.
          const { binding, transition } = activeTransition;
          const mutation = assertTransitionBinding(binding);
          const facts = binding.owner.inspectPreparedMutationTransition(mutation, transition);
          if (facts.beforeIncarnation !== acceptedIncarnation || facts.afterIncarnation !== facts.beforeIncarnation + 1
            || currentIncarnation() !== facts.afterIncarnation) {
            throw new Error('Autonomous settings transition changed');
          }
        } else {
          settingsCurrent();
        }
        assertWorkspace();
      };
      const record: AuthenticAutonomousAdmission = {
        issuer: this, registry: preparedCall?.registry, call: preparedCall?.call, claim: admission.claim, consumed: false, assertWorkspace,
        settingsBinding: settingsMutation, nestedSettingsBindings, parents,
        nestedOwner: Object.freeze({ manager: this, source, decoratePort: options.decoratePort }),
        assertEffect: effect => {
          if ((effect !== 'write' && effect !== 'send') || effectReadOnly || effectWriteDenied
            || (effectSurface !== undefined && !ownerDirected && !effectPermittedForProvenance(effect, { surfaceId: effectSurface }).allowed)) {
            throw new ToolInputProjectionError('held');
          }
        },
        ...(admissionEvidence?.kind === 'agent-settings' ? { settingsPresentation: Object.freeze({ previous: admissionEvidence.effect['previous'], current: admissionEvidence.effect['value'] }) } : {}),
        assertConfigTransition: (actual, transition) => {
          const mutation = assertTransitionBinding(actual);
          const facts = actual.owner.inspectPreparedMutationTransition(mutation, transition);
          if (facts.beforeIncarnation !== acceptedIncarnation || facts.afterIncarnation !== facts.beforeIncarnation + 1
            || (activeTransition && (activeTransition.binding !== actual || activeTransition.transition !== transition))) {
            throw new Error('Autonomous settings transition changed');
          }
          for (const parent of parents) parent.assertConfigTransition?.(actual, transition);
          acceptedPermissions ??= JSON.stringify(admittedPermissions);
          activeTransition = { binding: actual, transition };
          assertAuthority();
        },
        completeConfigTransition: (actual, transition) => {
          const mutation = assertTransitionBinding(actual);
          if (activeTransition?.binding !== actual || activeTransition.transition !== transition) throw new Error('Autonomous settings completion changed');
          const facts = actual.owner.inspectCompletedMutation(mutation);
          if (facts.beforeIncarnation !== acceptedIncarnation || facts.afterIncarnation !== facts.beforeIncarnation + 1) throw new Error('Autonomous settings completion changed');
          // Ancestors adopt this exact child's result before the child's private
          // source callback samples its retained parent guard.
          for (const parent of parents) parent.completeConfigTransition(actual, transition);
          assertOwnedLifetime(); actual.owner.assertCompletedMutation(mutation);
          revisions.assertOwners();
          const current = this.configReader.getAutonomousSnapshot?.();
          // The change may not touch the permission settings the call was admitted under.
          if (!current || current.incarnation !== facts.afterIncarnation || JSON.stringify(current.permissions) !== acceptedPermissions) {
            throw new Error('Autonomous settings completion authority changed');
          }
          acceptedIncarnation = facts.afterIncarnation;
          acceptedPermissions = JSON.stringify(current.permissions);
          settingsCurrent = capturePermissionConfiguration(this.configReader, () => this.configReader.getAutonomousSnapshot?.(), current);
          activeTransition = undefined;
          assertOwnedLifetime();
        },
        assertCurrent: assertAuthority,
      };
      authenticAutonomousAdmissions.set(admission, record);
    }
    return admission;
  }

  /** One safety decision across prepared tools, external actions and raw checks. */
  private assessExecutionSafety(input: SafetyInput): Promise<SafetyOutcome> {
    return decisionOrClassic(async () => {
      const result = await this.assessDecisionExecutionSafety(input);
      if (result.result.autonomousDecision?.outcome === 'reject') rememberDecisionRefusal(this.captureRefusalAction(input));
      return result;
    }, () => this.assessClassicExecutionSafety(input));
  }

  private captureRefusalAction(input: SafetyInput): RefusedDecisionAction {
    return captureOwnedJson({ tool: input.toolName, args: input.args, directory: input.workingDirectory ?? null }) as RefusedDecisionAction;
  }

  /** The owner's exact revised arguments, approved in an answer to this source; consumed when read. */
  private takeOwnerRevision(input: SafetyInput): boolean {
    const approved = this.ownerRevisions.get(input.sourceId);
    if (!approved) return false;
    this.ownerRevisions.delete(input.sourceId);
    return approved.toolName === input.toolName && isDeepStrictEqual(approved.args, input.args)
      && isDeepStrictEqual(approved.authority, input.authoritySnapshot);
  }

  private async assessClassicExecutionSafety(input: SafetyInput): Promise<SafetyOutcome> {
    input.assertCurrent();
    // A fact (including yolo and the plan refusal) is already the decision.
    if (!input.policyResult.approved || input.decided.kind === 'fact' || input.mode === 'plan') return { result: input.policyResult };
    const analysis = input.policyResult.analysis;
    if (wasDecisionRefused(this.captureRefusalAction(input))) return { result: this.result(false, false, 'safety_check', 'jev_reject', analysis,
      { detail: 'A decision model refused this exact action. Availability fallback cannot override that refusal.' }) };
    const ownerOnly = input.decided.kind === 'owner-only' ? input.decided.item : undefined;
    if (ownerOnly === undefined) {
      const tools = this.configReader.getSnapshot().permissions.tools;
      const toolConfigKey = TOOL_CONFIG_KEYS[input.toolName];
      const configured = toolConfigKey === undefined ? undefined : tools?.[toolConfigKey];
      if (configured === 'allow' || input.category === 'read' && configured !== 'prompt') {
        input.assertCurrent();
        return { result: this.result(true, false, 'config_policy', 'config_allow', analysis,
          { detail: 'Classic operation: authorized by owner configuration and deterministic tool category; no semantic safety reading.' }) };
      }
    }
    if (this.takeOwnerRevision(input)) return { result: this.result(true, false, 'user_prompt', 'user_approved', analysis) };
    if (input.ownerConfirmed === true) return this.ownerConfirmedOutcome(input);
    return this.askOwner(input, analysis, {
      reasons: ownerOnly ? [`Only you decide this: ${ownerOnlyReason(ownerOnly)}.`] : [],
      ownerOnly, revisedDetail: 'Prepare the exact action revised and approved by the owner during Classic operation.',
    });
  }

  /** A call the owner confirmed himself in a form: his yes is the approval, recorded as his. */
  private ownerConfirmedOutcome(input: SafetyInput): SafetyOutcome {
    input.assertCurrent();
    return { result: this.result(true, false, 'user_prompt', 'user_approved', input.policyResult.analysis,
      { detail: 'The owner confirmed this exact action in a form he filled in.' }) };
  }

  /**
   * Ask the owner about one call and keep what he asked to be remembered. An
   * answer to an owner-only item is remembered as covering that item, so he is
   * asked once. Revised arguments become a revision the caller prepares again.
   */
  private async askOwner(input: SafetyInput, analysis: PermissionRequestAnalysis, o: {
    readonly reasons: readonly string[];
    readonly ownerOnly?: OwnerOnlyKind | undefined;
    readonly boundary?: GateBoundaryRecord | undefined;
    readonly preset?: GatePresetRecord | undefined;
    readonly revisedDetail: string;
  }): Promise<SafetyOutcome> {
    const reply = await awaitPermission(() => this.requestPermission({
      callId: input.callId, tool: input.toolName, args: input.args, category: input.category,
      analysis: { ...analysis, reasons: [...analysis.reasons, ...o.reasons] },
      workingDirectory: input.workingDirectory,
      ...(input.attribution ? { attribution: input.attribution } : {}),
      // A channel's request is approved one call at a time: no remembered answer can stand in for the owner there.
      ...(o.ownerOnly === 'channel-request' ? {} : { rememberOptions: buildRememberOptions(input.toolName, input.args, this.rememberedRulesHere()) }),
    }, { signal: input.signal }), input.signal);
    input.assertCurrent();
    const modified = reply.modifiedArgs === undefined ? undefined : captureOwnedJson(reply.modifiedArgs) as Record<string, unknown>;
    const notSaved = await this.rememberReply(input.toolName, input.args, reply, modified, o.ownerOnly);
    input.assertCurrent();
    const extra = { ...(o.boundary ? { boundary: o.boundary } : {}), ...(o.preset ? { preset: o.preset } : {}) };
    if (reply.approved && modified && !isDeepStrictEqual(modified, input.args)) {
      if (!input.source) {
        return { result: this.result(true, false, 'user_prompt', 'user_approved', analysis,
          { ...extra, modifiedArgs: modified, userReason: reply.reason }) };
      }
      const argsRevision = `owner-edit-${(++this.ownerRevisionSequence).toString(36)}`;
      this.recordOwnerRevision(input.sourceId, Object.freeze({ toolName: input.toolName, args: modified, authority: input.authoritySnapshot }));
      const revision: AutonomousToolRevision = Object.freeze({
        ref: Object.freeze({ id: `owner-revision-${input.callId}`, revision: argsRevision, kind: 'revise-action' }),
        toolName: input.toolName, args: modified,
      });
      return { revision, result: this.result(false, false, 'user_prompt', 'user_approved', analysis,
        { ...extra, modifiedArgs: modified, detail: o.revisedDetail, userReason: reply.reason }) };
    }
    return { result: this.result(reply.approved, false, 'user_prompt', reply.approved ? 'user_approved' : 'user_denied', analysis,
      { ...extra, userReason: reply.reason, ...(modified ? { modifiedArgs: modified } : {}), ...(notSaved ? { detail: notSaved } : {}) }) };
  }

  /**
   * The decision after the classifier: a fact is final; an owner-only item is
   * put to the owner (held for the end in just-vibes); only a judgment reads
   * the call and, in jev-decides and just-vibes, asks Jev.
   */
  private async assessDecisionExecutionSafety(input: SafetyInput): Promise<SafetyOutcome> {
    input.assertCurrent();
    const decided = input.decided;
    if (!input.policyResult.approved || decided.kind === 'fact') return { result: input.policyResult };
    if (this.takeOwnerRevision(input)) {
      return { result: this.result(true, false, 'user_prompt', 'user_approved', input.policyResult.analysis,
        { detail: 'The owner approved these exact revised arguments.' }) };
    }
    if (input.ownerConfirmed === true) return this.ownerConfirmedOutcome(input);
    if (decided.kind === 'owner-only') {
      if (input.mode === 'just-vibes') return this.queuedForOwner(input, input.policyResult.analysis, `held for you: ${ownerOnlyReason(decided.item)}`, decided.item);
      return this.askOwner(input, input.policyResult.analysis, {
        reasons: [`Only you decide this: ${ownerOnlyReason(decided.item)}.`], ownerOnly: decided.item,
        revisedDetail: 'Prepare the exact action revised and approved by the owner.',
      });
    }
    // Plan mode reached here only for a read the defaults did not settle (outside the directories).
    if (input.mode === 'plan') return { result: input.policyResult };
    // just-vibes with no working decision model: nobody can decide now without interrupting the owner.
    if (input.mode === 'just-vibes' && !this.decisionModelWorks()) {
      return this.queuedForOwner(input, input.policyResult.analysis, 'held for you: this needs a decision and no decision model is set up');
    }
    const privacy = judgmentInputBoundary(input.toolName, input.args, input.workingDirectory);
    let analysis = input.policyResult.analysis;
    let reading: Awaited<ReturnType<typeof readToolCall>> | undefined;
    let boundary = privacy;
    const supportingIds = [...(input.supportingIds ?? [])];
    let port: JudgmentPort | undefined;
    if (privacy.passed) {
      const base = judgmentPort('engine.gate.execution-safety');
      const installed = input.decoratePort?.(base) ?? base;
      port = {
        get model() { return installed.model; },
        ...(installed.recorder ? { recorder: installed.recorder } : {}),
        async ask(request) {
          // Checked before every attempt, the first included. The one caller that brings
          // its own attempt guard (decideAutonomous) runs this same check in it.
          const prior = request.beforeAttempt;
          const result = await awaitPermission(() => installed.ask({ ...request, beforeAttempt() {
            if (prior) assertSynchronousJudgmentGuard(() => prior()); else input.assertCurrent();
          } }), input.signal);
          input.assertCurrent();
          if ((input.mode === 'jev-decides' || input.mode === 'just-vibes') && !result.decisionId) throw new JudgmentError('unrecorded', 'execution safety requires recorded provenance');
          if (result.decisionId) supportingIds.push(result.decisionId);
          return result;
        },
      };
      reading = await readToolCall({ toolName: input.toolName, args: input.args, workingDirectory: input.workingDirectory,
        askKind: toolCategoryOf({ name: input.toolName }) === undefined, askObfuscated: shellCommandsIn(input.args).length > 0,
        signal: input.signal, port });
      input.assertCurrent();
      analysis = withReading(analysis, reading, input.category);
      boundary = await runBoundary({ toolName: input.toolName, args: input.args, reading,
        declaredMutation: input.category === 'write', surfaceId: this.gate.surfaceOf?.(),
        ledger: this.gate.ledger, signal: input.signal, port });
      input.assertCurrent();
    }
    if (!boundary.passed && boundary.refusedBy === 'surface-authority') {
      return { result: this.result(false, false, 'boundary', 'boundary_surface_authority', analysis,
        { boundary: { passed: false, refusedBy: boundary.refusedBy, checks: boundary.checks }, detail: boundary.reason }) };
    }
    const boundaryResult = {
      passed: boundary.passed, checks: boundary.checks,
      ...(!boundary.passed ? { refusedBy: boundary.refusedBy } : {}),
    };
    if (input.mode === 'ask-me') {
      if (boundary.passed && reading?.stakes !== 'critical' && reading?.irreversible !== true && reading?.weakensSecurity !== true) {
        return { result: this.result(true, false, 'stakes_preset', 'preset_allow', analysis,
          { boundary: boundaryResult, preset: { preset: 'ask-me', action: 'allow' } }) };
      }
      return this.askOwner(input, analysis, {
        reasons: !boundary.passed ? [boundary.reason] : [], boundary: boundaryResult,
        preset: { preset: 'ask-me', action: 'ask' }, revisedDetail: 'Prepare the exact action revised and approved by the owner.',
      });
    }
    if (!privacy.passed) {
      return { result: this.result(false, false, 'boundary', 'boundary_judgment_input', analysis,
        { boundary: boundaryResult, detail: privacy.reason }) };
    }
    const decision = await decideAutonomousTool({
      port: port!,
      binding: { sourceId: input.sourceId, inputRevision: input.actionRevision,
        actionId: input.callId, actionRevision: input.actionRevision,
        authorityId: 'engine.permission-runtime', authorityRevision: input.authorityRevision,
        scopeId: 'execution-safety', scopeRevision: input.authorityRevision },
      // decideAutonomous screens the state it sends; it is passed as it is.
      state: ({ tool: input.toolName, arguments: input.args,
        ...(input.source ? { source: autonomousSourceEvidence(input.source) } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        evidence: { boundary: boundaryResult, ...(reading ? { reading: { family: reading.family, stakes: reading.stakes, uncertain: reading.uncertain,
          mutates: reading.mutates, outward: reading.outward, secrets: reading.secrets, irreversible: reading.irreversible,
          beyondProject: reading.beyondProject, weakensSecurity: reading.weakensSecurity, obfuscated: reading.obfuscated,
          boundary: reading.boundary } } : {}) },
        constraints: { mode: input.mode, ownerPolicyAllowed: input.policyResult.approved },
        provenance: { surface: this.gate.surfaceOf?.() ?? 'owner-direct' } }) as unknown as EntryType,
      evidence: [{ id: 'requested-tool-input', revision: input.actionRevision }, { id: 'live-authority', revision: input.authorityRevision }],
      supportingDecisionIds: supportingIds, choices: {}, allowAct: input.policyResult.approved,
      assertCurrent: input.assertCurrent, signal: input.signal,
    });
    input.assertCurrent();
    const receipt = decision.decision;
    // just-vibes does not refuse what Jev would not run: the owner decides it at the end of the run.
    if (input.mode === 'just-vibes' && receipt.outcome !== 'act') {
      return { ...this.queuedForOwner(input, analysis, `held for you: ${receipt.summary}`), recordClaim: () => decision.recordClaim() };
    }
    return {
      result: this.result(receipt.outcome === 'act', false, 'jev_decision', `jev_${receipt.outcome}`, analysis,
        { boundary: boundaryResult, autonomousDecision: receipt, detail: receipt.summary,
          preset: { preset: input.mode, action: receipt.outcome === 'act' ? 'allow' : 'deny' } }),
      recordClaim: () => decision.recordClaim(),
    };
  }

  /**
   * The facts one call is classified by, from values this decision already
   * holds. A deny is reported over an allow: a tool setting, then managed
   * policy, then a denying answer or rule (including where a link leads), then
   * an allowing answer or rule, then a managed allow.
   */
  private callFacts(i: CallFactInput): CallFacts {
    const paths = declaredValues(i.args, i.definition?.subjects?.paths);
    return {
      tool: i.toolName, category: i.category, sideEffects: i.definition?.sideEffects, surface: i.surface,
      rule: i.mode === 'yolo' ? undefined : this.ruleFact(i),
      paths: paths === undefined ? undefined : classifyPaths(paths, i.directory),
      recoverable: declaredRecoverable(i.definition, i.args),
      ownerOnly: i.ownerOnly, untrustedRead: i.untrustedRead, declaredReadOnly: i.declaredReadOnly,
    };
  }

  private ruleFact(i: CallFactInput): CallRuleFact | undefined {
    if (this.ownerDeniesTool(i.toolName, i.category, i.tools)) {
      const key = TOOL_CONFIG_KEYS[i.toolName] ?? 'delegate';
      return { effect: 'deny', source: 'tool-setting',
        description: i.tools?.[key] === 'deny' ? `the setting permissions.tools.${key} = deny` : 'the setting permissions.tools.write = deny' };
    }
    if (i.policy?.approved === false) return { effect: 'deny', source: 'managed-policy', description: 'managed permission policy' };
    const remembered = (answer: RememberedDecision, source: CallRuleFact['source'], where = ''): CallRuleFact => ({
      effect: answer.effect, source, description: `${answer.description}${where}`,
      ...(answer.ownerOnly ? { ownerOnly: answer.ownerOnly } : {}),
    });
    const sourceOf = (answer: RememberedDecision): CallRuleFact['source'] => answer.source === 'session_override' ? 'session' : 'user-rule';
    if (i.landed) return remembered(i.landed, sourceOf(i.landed), ', where this path\'s link leads');
    if (i.remembered) return remembered(i.remembered, sourceOf(i.remembered));
    if (i.policy?.approved) return { effect: 'allow', source: 'managed-policy', description: 'managed permission policy' };
    return undefined;
  }

  /** The gate result a classification stands for; owner-only and judgment calls continue as not refused. */
  private policyResultOf(decided: CallClass, analysis: PermissionRequestAnalysis): PermissionCheckResult {
    if (decided.kind !== 'fact') return this.result(true, false, 'config_policy', 'config_allow', analysis);
    const decision = decided.decision;
    switch (decided.basis) {
      case 'surface': return this.result(false, false, 'boundary', 'boundary_surface_authority', analysis, { decision, detail: decision.reason });
      case 'plan': return this.result(false, false, 'runtime_mode', 'plan_mode', analysis, { decision });
      case 'mode': return this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis, { decision, preset: { preset: 'yolo', action: 'allow' } });
      case 'declared-effect': return this.result(true, false, 'config_policy', 'config_allow', analysis, { decision, detail: decision.reason });
      case 'rule': case 'owner-rule': {
        const [layer, allowCode, denyCode, persisted] = RULE_LAYERS[decided.rule?.source ?? 'tool-setting'];
        return this.result(decided.allow, persisted, layer, decided.allow ? allowCode : denyCode, analysis, { decision, detail: decision.reason });
      }
    }
  }

  /** Resolves to true when the gate approves the call. */
  async check(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<boolean> {
    const signal = options?.signal;
    const result = await this.checkDetailed(toolName, args, attribution, options);
    assertPermissionActive(signal);
    return result.approved;
  }

  /**
   * Decides a model-requested hook change. A hook runs on events for as long as it is registered and an
   * http hook sends each event's tool arguments and results to its URL, so a change is never settled by
   * category, mode or a remembered rule: the owner is asked every time, whatever was approved before.
   * Plan mode refuses it (it is a write); the mode that skips every prompt allows it. An answer is never
   * remembered, so approving one change grants nothing else.
   */
  async checkHookChange(request: import('../tools/state/index.js').HookChangeRequest, options?: PermissionExecutionOptions): Promise<{ approved: boolean; reason?: string }> {
    this.assertSelectedModeCurrent();
    const signal = options?.signal;
    assertPermissionActive(signal);
    const hook = request.hook;
    const mode = this.getMode();
    if (mode === 'yolo') return { approved: true };
    if (mode === 'plan') {
      return { approved: false, reason: `plan mode is on and changing a hook is a write; leave plan mode, then ask again` };
    }
    if (!this.surfaceAllows('write')) {
      return { approved: false, reason: 'this source may not make changes, and changing a hook is a change' };
    }
    const underlying = hook.type === 'command' || hook.type === 'ts' ? 'exec' : hook.type === 'http' ? 'fetch' : 'agent';
    const configured = (this.configReader.getAutonomousSnapshot?.() ?? this.configReader.getSnapshot()).permissions?.tools;
    if (this.ownerDeniesTool(underlying, 'write', configured)) {
      return { approved: false, reason: `the owner's permission settings deny ${configured?.write === 'deny' ? 'writes' : `the ${underlying} tool`}, which this ${hook.type} hook would use` };
    }
    const { args, analysis } = describeHookChange(request);
    const reply = await awaitPermission(() => this.requestPermission({
      callId: crypto.randomUUID(), tool: 'state', args, category: 'write', analysis,
      workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
      rememberEffect: 'owner-asked-again',
    }, { signal }), signal);
    assertPermissionActive(signal);
    if (reply.approved) return { approved: true };
    return { approved: false, reason: reply.reason ?? `the ${hook.type} hook change was not approved` };
  }

  /**
   * Runs one call through the gate.
   *
   * @param attribution When present, rides on the brokered ask so a surface can
   * render which background agent (or server, or sandbox) is asking.
   */
  async checkDetailed(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<PermissionCheckResult> {
    this.assertSelectedModeCurrent();
    const signal = options?.signal;
    const owner = options?.hookOwner;
    const definition = options?.definition;
    const check = () => sessionOfCheck.run(owner?.sessionId, () => withExecutionMode(this.getMode(), () => this.checkActive(toolName, args, attribution, signal, owner, definition)));
    // The cancellation race may release the permission caller, but the owning
    // turn still joins the actual check and any admitted hook/approval cleanup.
    return awaitPermission(() => owner ? owner.admit(check) : check(), signal);
  }

  private policyClassification(category: PermissionCategory): CommandClassification {
    return category === 'read' ? 'read' : category === 'write' ? 'write' : 'escalation';
  }

  private surfaceAllows(category: PermissionCategory, surface = this.gate.surfaceOf?.()): boolean {
    return category === 'read' || surface === undefined || effectPermittedForProvenance('write', { surfaceId: surface }).allowed;
  }

  private ownerDeniesTool(toolName: string, category: PermissionCategory, tools: PermissionsToolConfig | undefined): boolean {
    const key = TOOL_CONFIG_KEYS[toolName] ?? 'delegate';
    return tools?.[key] === 'deny' || (category === 'write' && tools?.write === 'deny');
  }

  private async checkActive(toolName: string, borrowedArgs: Record<string, unknown>, attribution: PermissionAttribution | undefined, signal?: AbortSignal, hookOwner?: TurnHookOwner, definition?: ToolDefinition): Promise<PermissionCheckResult> {
    assertPermissionActive(signal);
    const duplicate = isInvocationAdmitted(toolName, borrowedArgs);
    const args = captureOwnedJson(borrowedArgs) as Record<string, unknown>;
    const category = this.getCategory(toolName, args, definition);
    const analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    const mode = this.getMode();
    // isInvocationAdmitted already revalidates the exact private invocation's
    // source, policy, mode owner and lifetime; this is not a new mode approval.
    if (duplicate) return this.result(true, false, 'invocation_admission', 'invocation_already_admitted', analysis);
    const owner = currentExecutionModeOwner();
    const ownerRevision = owner?.getRevision();
    const surface = this.gate.surfaceOf?.();
    const assertWorkspace = await this.autonomousWorkspaceConstraint(category, signal);
    const exposure = (this.gate.ledger ?? getProcessUntrustedContentLedger()).captureTaintEvidence('turn');
    const authoritySnapshot = () => this.configReader.getAutonomousSnapshot?.() ?? {
      permissions: this.configReader.getSnapshot().permissions,
      autoApprove: this.configReader.isAutoApproveEnabled(), directory: this.configReader.getWorkingDirectory(),
    };
    const config = authoritySnapshot();
    const assertConfiguration = capturePermissionConfiguration(this.configReader, authoritySnapshot, config);
    // The call names its owned immutable capture; owner revisions enforce freshness.
    const authorityRevision = callId;
    const assertCurrent = () => {
      assertPermissionActive(signal);
      exposure.assertCurrent(); assertWorkspace();
      if (this.gate.surfaceOf?.() !== surface) throw new Error('Execution source authority changed while deciding');
      assertConfiguration();
      if (mode !== this.getMode() || owner?.getRevision() !== ownerRevision) throw new Error('Execution mode or owner changed while deciding');
    };
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', { callId, toolName, category, analysis }, hookOwner);
    assertCurrent();
    this.policyRuntimeState.recordPermissionRequest({ callId, tool: toolName, category, analysis });
    const ownerOnly = recognizeOwnerOnly(toolName, args, definition, this.settingsFacts(toolName, args));
    let policy: PermissionCheckResult | null = null;
    let remembered: RememberedDecision | null = null;
    let landed: RememberedDecision | null = null;
    const subjects = callSubjects(args, definition);
    if (mode !== 'yolo' && !(mode === 'plan' && category !== 'read')) {
      if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
        policy = this.mapEvaluatorDecision(await this.evaluateRuntimePolicy(toolName, args, mode, this.policyClassification(category), { signal, assertCurrent }, undefined, subjects), analysis);
      }
      remembered = await this.rememberedDecision(this.getApprovalKey(toolName, args), toolName, args, { signal, assertCurrent }, undefined, ownerOnly, subjects);
      // A link inside an allowed folder can lead to a path the owner denied: that denial applies too.
      if (remembered?.effect !== 'deny') landed = await this.deniedWhereLinksLead(toolName, args, { signal, assertCurrent });
    }
    const decided = classifyCall(mode, this.callFacts({
      toolName, args, category, mode, surface, definition, ownerOnly,
      directory: config.directory, tools: config.permissions?.tools, remembered, landed, policy,
      untrustedRead: (this.gate.ledger ?? getProcessUntrustedContentLedger()).ingestedThisTurn().length > 0,
    }));
    const policyResult = this.policyResultOf(decided, analysis);
    const safety = await this.assessExecutionSafety({
      callId, sourceId: callId, toolName, args, category, policyResult, decided, mode, signal, assertCurrent,
      workingDirectory: config.directory ?? undefined, authorityRevision, authoritySnapshot: captureJsonEntry(config),
      actionRevision: callId, attribution,
    });
    assertCurrent();
    this.noteJevDecision(toolName, args, safety.result, definition);
    return this.emitAndReturn(callId, toolName, category, safety.result, hookOwner);
  }

  /** Surface restrictions are declared by the host; Jev does not grant tool access. */
  async passesBoundary(toolName: string, args: Record<string, unknown>, options?: PermissionExecutionOptions): Promise<boolean> {
    this.assertSelectedModeCurrent();
    assertPermissionActive(options?.signal);
    const captured = captureOwnedJson(args) as Record<string, unknown>;
    const assertWorkspace = await this.autonomousWorkspaceConstraint(this.getCategory(toolName, captured), options?.signal);
    assertWorkspace();
    return this.surfaceAllows(this.getCategory(toolName, captured));
  }

  /**
   * How the gate would classify this exact call now, without running it: the
   * mode, the category, the session answers and saved rules, the owner-only
   * list and the surface, through the same classifier `check` uses. No hook,
   * prompt or model request; a `judgment` result means a live call would ask
   * the decision model (or, without one, the owner).
   */
  async previewDecision(toolName: string, args: Record<string, unknown>, definition?: ToolDefinition, signal?: AbortSignal): Promise<{
    readonly mode: GatePresetName; readonly category: PermissionCategory; readonly decided: CallClass;
  }> {
    const captured = captureOwnedJson(args) as Record<string, unknown>;
    const mode = this.getMode();
    const category = this.getCategory(toolName, captured, definition);
    const config = this.configReader.getSnapshot();
    const ownerOnly = recognizeOwnerOnly(toolName, captured, definition, this.settingsFacts(toolName, captured));
    const subjects = callSubjects(captured, definition);
    const options = signal ? { signal } : {};
    const remembered = mode === 'yolo' ? null
      : await this.rememberedDecision(this.getApprovalKey(toolName, captured), toolName, captured, options, undefined, ownerOnly, subjects);
    const landed = mode === 'yolo' || remembered?.effect === 'deny' ? null : await this.deniedWhereLinksLead(toolName, captured, options);
    const decided = classifyCall(mode, this.callFacts({
      toolName, args: captured, category, mode, surface: this.gate.surfaceOf?.(), definition, ownerOnly,
      directory: this.configReader.getWorkingDirectory(), tools: config.permissions?.tools, remembered, landed, policy: null,
      untrustedRead: (this.gate.ledger ?? getProcessUntrustedContentLedger()).ingestedThisTurn().length > 0,
    }));
    return { mode, category, decided };
  }

  /** Whether this call is a settings write that loosens its key, for the owner-only list. */
  private settingsFacts(toolName: string, args: Record<string, unknown>, evidence?: ToolOwnedAdmissionEvidence): { readonly loosensSetting: boolean } {
    return { loosensSetting: settingsWriteLoosens(toolName, args, evidence, key => this.configReader.getSetting?.(key)) };
  }

  /** Explicit session decisions, then current durable rules with their own scope. */
  private async rememberedDecision(
    key: string,
    toolName: string,
    args: Record<string, unknown>,
    options: JudgmentReadingOptions = {},
    owner?: AutonomousPermissionReading,
    ownerOnly?: OwnerOnlyKind,
    subjects?: CallSubjects,
  ): Promise<RememberedDecision | null> {
    const view = this.ruleView();
    const unchanged = owner ? undefined : this.ruleRevisions(view.revision);
    const current = () => {
      options.signal?.throwIfAborted();
      if (owner) { owner.assertCurrent(); return; }
      assertProjectionCurrent(projectionFunction<() => void>(projectionProperty(options, 'assertCurrent')));
      if (!unchanged!()) throw new Error('Remembered permission owner changed while reading');
    };
    current();
    // An answer to an owner-only item is kept under its own key: only it says the owner settled that item.
    const ownerAnswer = ownerOnly === undefined ? undefined : this.sessionApprovals.get(ownerOnlySessionKey(ownerOnly, key));
    const session = ownerAnswer ?? this.sessionApprovals.get(key);
    if (session !== undefined) {
      return { approved: session, effect: session ? 'allow' : 'deny', source: 'session_override', reason: session ? 'session_cached_allow' : 'session_cached_deny',
        description: 'your answer earlier in this session', ...(ownerAnswer !== undefined ? { ownerOnly } : {}), assertCurrent: current };
    }
    // Rules remembered from an answer this process are matched live, after the
    // committed rules, until the store loads them as committed on restart.
    const rules = owner ? [...owner.frame.rules, ...view.remembered] : this.userRuleStore ? [...view.committed, ...view.remembered] : undefined;
    const projectRoot = owner ? owner.frame.directory : rules ? this.configReader.getWorkingDirectory() : undefined;
    const durable = rules
      ? await matchDurableRulesAsync(rules, toolName, args, { signal: options.signal, assertCurrent: current, projectRoot: projectRoot ?? undefined, subjects })
      : null;
    current();
    if (!durable) return null;
    const approved = durable.effect === 'allow';
    const rule = rules?.find((candidate) => candidate.id === durable.ruleId);
    return { approved, effect: durable.effect, source: 'user_rule', reason: approved ? 'user_rule_allow' : 'user_rule_deny',
      description: `the saved rule "${rule?.description ?? durable.ruleId}"`,
      ...(rule?.ownerOnly ? { ownerOnly: rule.ownerOnly } : {}), assertCurrent: current };
  }

  /** The denial for the first path argument whose link lands somewhere a remembered rule or session answer denies. */
  private async deniedWhereLinksLead(toolName: string, args: Record<string, unknown>, options: JudgmentReadingOptions, owner?: AutonomousPermissionReading, sessionId?: string) {
    for (const path of extractPathArgs(args)) {
      const absolute = owner ? (owner.frame.directory ? resolve(owner.frame.directory, path) : path) : this.absoluteReadPath(path);
      let real: string;
      try { real = landingPath(absolute); } catch { continue; }
      if (real === absolute) continue;
      const landedArgs = { path: real };
      const remembered = await this.rememberedDecision(this.getApprovalKey(toolName, landedArgs, sessionId), toolName, landedArgs, options, owner);
      remembered?.assertCurrent();
      if (remembered?.effect === 'deny') return remembered;
    }
    return null;
  }

  private absoluteReadPath(path: string): string {
    const directory = this.configReader.getWorkingDirectory();
    return directory ? resolve(directory, path) : path;
  }

  /**
   * Whether a session answer denied this read key. With a session id only that
   * session's answer counts; without one (the caller does not know its session)
   * a denial from any session restricts, so an answer is never lost to a missing id.
   */
  private sessionDeniesRead(key: string, sessionId: string | undefined): boolean {
    if (sessionId !== undefined) return this.sessionApprovals.get(`session:${sessionId}|${key}`) === false;
    for (const [stored, approved] of this.sessionApprovals) {
      if (approved === false && (stored === key || (stored.startsWith('session:') && stored.endsWith(`|${key}`)))) return true;
    }
    return false;
  }

  /**
   * Search, map and read tools share explicit owner rules without per-path Jev calls.
   * `sessionId` is the hosted session asking; a session's own "deny for this
   * session" answer to a read then holds for the files those tools surface.
   */
  async readAccess(rawPath: string, sessionId?: string): Promise<'allow' | 'restricted'> {
    const lexical = await this.readAccessForPath(rawPath, sessionId);
    if (lexical === 'restricted' || typeof rawPath !== 'string' || rawPath.length === 0) return lexical;
    // A link can lead somewhere the owner's rules deny: judge where it really lands too.
    const absolute = this.absoluteReadPath(rawPath);
    let real: string;
    try { real = landingPath(absolute); } catch { return lexical; }
    return real === absolute ? lexical : this.readAccessForPath(real, sessionId);
  }

  private async readAccessForPath(rawPath: string, sessionId: string | undefined): Promise<'allow' | 'restricted'> {
    // A read decision uses the mode its invocation was admitted under.
    const mode = currentExecutionModeForReadDecision() ?? this.getMode();
    const assertWorkspace = await this.autonomousWorkspaceConstraint('read');
    assertWorkspace();
    if (mode === 'yolo') return 'allow';
    const permissions = (this.configReader.getAutonomousSnapshot?.() ?? this.configReader.getSnapshot()).permissions;
    if (permissions?.tools?.read === 'deny') return 'restricted';
    if (typeof rawPath !== 'string' || rawPath.length === 0) return 'allow';
    const args = { path: rawPath };
    if (this.configReader.isAutoApproveEnabled()) return 'allow';
    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(await this.evaluateRuntimePolicy('read', args, mode, 'read'), analyzePermissionRequest('read', args, 'read'));
      assertWorkspace();
      if (mapped) return mapped.approved ? 'allow' : 'restricted';
    }
    const readKey = this.getApprovalKey('read', { path: this.absoluteReadPath(rawPath) }, sessionId);
    if (this.sessionDeniesRead(sessionApprovalKey('read', { path: this.absoluteReadPath(rawPath) }), sessionId)) return 'restricted';
    const remembered = await this.rememberedDecision(readKey, 'read', args);
    remembered?.assertCurrent(); assertWorkspace();
    return remembered?.effect === 'deny' ? 'restricted' : 'allow';
  }

  /**
   * Keep what an owner's answer asked to be remembered, for later decisions
   * only; the decision this answer settles is already made. A session answer
   * is keyed exactly as session decisions are read (getApprovalKey); any other
   * tier becomes the same durable rule the approval broker matches, written to
   * disk now. An answer that edited the arguments is about different
   * arguments, so nothing is remembered from it.
   */
  private async rememberReply(toolName: string, args: Record<string, unknown>, reply: PermissionPromptDecision, modified: Record<string, unknown> | undefined,
    ownerOnly?: OwnerOnlyKind): Promise<string | undefined> {
    const tier = reply.rememberTier ?? (reply.remember === true ? 'session' : undefined);
    if (tier === undefined) return undefined;
    if (modified !== undefined && !isDeepStrictEqual(modified, args)) return undefined;
    const approved = reply.approved === true;
    if (tier === 'session') {
      const key = this.getApprovalKey(toolName, args);
      this.sessionApprovals.set(ownerOnly === undefined ? key : ownerOnlySessionKey(ownerOnly, key), approved);
      // Search and map tools ask about one absolute path at a time (readAccess),
      // so a read answer is also kept for each file it covered.
      if (toolName === 'read') for (const path of extractPathArgs(args)) this.sessionApprovals.set(this.getApprovalKey('read', { path: this.absoluteReadPath(path) }), approved);
      this.sessionApprovalRevision++;
      return undefined;
    }
    const rule = buildDurableRuleForDecision({ toolName, args, tier, effect: approved ? 'allow' : 'deny', ...(ownerOnly && approved ? { ownerOnly } : {}) });
    const store = this.userRuleStore;
    const project = this.configReader.getWorkingDirectory();
    const notSaved = (why: string): string => {
      logger.warn('PermissionManager: remembered decision not kept', { tool: toolName, tier, why });
      return `Your choice to ${approved ? 'allow' : 'deny'} this ${tier === 'tool' ? 'tool' : tier === 'path' ? 'path' : tier === 'command-class' ? 'command class' : 'command'} was not saved (${why}); it applies to this call only, and you will be asked again.`;
    };
    if (!rule) return notSaved('the choice does not apply to these arguments');
    if (!store?.remember) return notSaved('no rule store is available');
    // A rule with no project would match in every project, wider than the choice that was made.
    if (!project) return notSaved('there is no project to scope the rule to');
    try {
      // A rule made here is scoped to the project it was made in.
      await store.remember({ rule, tier, tool: toolName, createdAt: Date.now(), project: projectIdentity(project) });
      return undefined;
    } catch (error: unknown) {
      return notSaved(summarizeError(error));
    }
  }

  /** The rules kept from the owner's answers that apply in this project. */
  private rememberedRulesHere(): readonly PolicyRule[] {
    const project = this.configReader.getWorkingDirectory();
    const store = this.userRuleStore;
    if (!store || !project) return [];
    return [...store.rules(project), ...(store.rememberedRules?.(project) ?? [])].filter((rule) => rule.origin === 'user');
  }

  private recordOwnerRevision(sourceId: string, revision: { readonly toolName: string; readonly args: Readonly<Record<string, unknown>>; readonly authority: EntryType }): void {
    if (!this.ownerRevisions.has(sourceId) && this.ownerRevisions.size >= (this.gate.bookkeepingLimits?.ownerRevisions ?? OWNER_REVISION_CAPACITY)) {
      const oldest = this.ownerRevisions.keys().next();
      if (!oldest.done) this.ownerRevisions.delete(oldest.value);
    }
    this.ownerRevisions.set(sourceId, revision);
  }

  /**
   * getMode, Returns the active session permission mode from config.
   * Surfaces (mode pill) and the orchestrator's standing plan-mode instruction
   * read this to reflect the current mode. Defaults to jev-decides (ask-me with no working decision model).
   */
  getMode(): GatePresetName {
    const scoped = currentExecutionModeOwner();
    if (scoped) return this.ownerMode(scoped);
    const native = nativePermissionConfigs.get(this.configReader);
    if (native && Object.getOwnPropertyDescriptor(this.configReader, 'getAutonomousSnapshot')?.value === native.snapshot) {
      const frame = native.owner.readMode();
      return effectivePermissionMode(frame.mode, frame.autoApprove, this.decisionModelWorks());
    }
    const frame = this.configReader.getAutonomousSnapshot?.();
    return frame ? effectivePermissionMode(frame.permissions.mode, frame.autoApprove, this.decisionModelWorks())
      : effectivePermissionMode(this.configReader.getSnapshot().permissions?.mode, this.configReader.isAutoApproveEnabled(), this.decisionModelWorks());
  }

  /** Capture the live host mode and its generation before entering an invocation scope. */
  captureExecutionMode(): { readonly mode: GatePresetName; assertCurrent(): void } {
    const owner = currentExecutionModeOwner();
    const ownerRevision = owner?.getRevision();
    const snapshot = () => this.configReader.getAutonomousSnapshot?.() ?? {
      permissions: this.configReader.getSnapshot().permissions,
      autoApprove: this.configReader.isAutoApproveEnabled(), directory: this.configReader.getWorkingDirectory(),
    };
    const frame = snapshot();
    const assertConfiguration = capturePermissionConfiguration(this.configReader, snapshot, frame);
    const mode = owner ? this.ownerMode(owner) : effectivePermissionMode(frame.permissions.mode, frame.autoApprove, this.decisionModelWorks());
    return Object.freeze({ mode, assertCurrent: () => {
      assertConfiguration();
      if (currentExecutionModeOwner() !== owner || owner?.getRevision() !== ownerRevision
        || (owner && this.ownerMode(owner) !== mode)) {
        throw new Error('Execution mode owner or configuration changed during the invocation');
      }
    } });
  }

  private assertSelectedModeCurrent(): void {
    const selected = currentExecutionMode();
    if (selected !== undefined && selected !== this.getMode()) throw new Error('Execution mode changed during the invocation');
  }

  /** The gate preset the current `permissions.mode` selects. */
  getPreset(): GatePreset {
    return presetForMode(this.getMode());
  }

  /**
   * The permission category of one call: the tool's declared category
   * (toolCategoryOf its registered definition), narrowed by what these
   * arguments do. A tool that declares none is 'delegate'.
   */
  getCategory(toolName: string, args: Record<string, unknown> = {}, definition?: Pick<ToolDefinition, 'category' | 'readModes'>): PermissionCategory {
    // inspect's scaffold creates its files through the write tool, which is asked about as a write itself.
    // A state call that writes (a value, a memory, a hook registration, a mode
    // change) is not the read the state tool's category names: it gets the
    // gate's full reading. The state tool's own read-only surface decides.
    if (toolName === 'state' && isStateMutation(args)) return 'write';
    // A schedule or trigger registers a command that later runs on its own, so
    // adding one is execution, not delegation.
    if (toolName === 'workflow' && ((args.mode === 'schedule' && args.scheduleAction === 'add') || (args.mode === 'hook-actions' && args.hookAction === 'add'))) return 'execute';
    // Changing what an MCP server may do is not the delegation a remembered
    // allow for the mcp tool was given for.
    if (changesMcpTrust(toolName, args)) return 'execute';
    const own = toolCategoryOf({ name: toolName, category: definition?.category }) ?? 'delegate';
    // A tool that names its read-only modes: a listed mode is a read, any other is decided as a change.
    return definition?.readModes ? readModeCategory(definition.readModes, args, own) : own;
  }

  /**
   * getApprovalKey - Stable key for session-level "always approve" decisions.
   * Includes the most meaningful argument to distinguish different invocations.
   */
  private getApprovalKey(toolName: string, args: Record<string, unknown>, sessionId: string | undefined = sessionOfCheck.getStore()): string {
    // Session answers belong to the hosted session that gave them: the daemon shares one manager
    // across sessions, so an answer in one must not decide a call in another.
    const key = sessionApprovalKey(toolName, args);
    return sessionId === undefined ? key : `session:${sessionId}|${key}`;
  }

  /** Whether Jev can decide now: the decision-model settings, read when a decision is made. */
  private decisionModelWorks(): boolean {
    return this.configReader.isDecisionModelReady?.() ?? true;
  }

  /**
   * The mode in force for a mode a session or surface chose: jev-decides is
   * ask-me while no decision model works, the same rule the configured mode
   * follows, so judgments go to the owner rather than to a model that cannot
   * answer. Read per call: setting up a decision model takes effect at once.
   */
  modeInForce(chosen: unknown): GatePresetName {
    return effectivePermissionMode(chosen, false, this.decisionModelWorks());
  }

  /** A session owner's mode in force; the owner holds the mode the session chose. */
  private ownerMode(owner: ExecutionModeOwner): GatePresetName {
    return this.modeInForce(owner.getMode());
  }

  /**
   * A call held for the owner in just-vibes: not run, the work carries on, and
   * the agent lists it for the owner at the end of the run.
   */
  private queuedForOwner(input: Pick<SafetyInput, 'toolName' | 'args'>, analysis: PermissionRequestAnalysis, reason: string, ownerOnly?: OwnerOnlyKind): SafetyOutcome {
    const key = this.getApprovalKey(input.toolName, input.args);
    const approvalKey = ownerOnly === undefined ? key : ownerOnlySessionKey(ownerOnly, key);
    // Approving it later is the owner's session answer for this exact call, as if he had been asked now.
    const held = this.heldForOwner().hold({ key: approvalKey, toolName: input.toolName, summary: analysis.summary, reason }, () => {
      this.sessionApprovals.set(approvalKey, true);
      this.sessionApprovalRevision++;
    });
    return { result: this.result(false, false, 'runtime_mode', 'mode_queued_for_owner', analysis, {
      detail: reason,
      decision: { state: 'queued-for-owner', decidedBy: 'mode', reason, heldId: held.id,
        next: ['carry on with the work that does not need this call',
          `the owner is shown it at the end of the run and can approve it with /held approve ${held.id}; after that the same call runs`] },
    }) };
  }

  /**
   * Keep a decision Jev made for the owner (`/decisions`), with what he can do
   * about it: the standing rules a choice would save, at the narrowest tier
   * this call allows (built now, so the call's arguments are not kept), and,
   * when the tool records every change for undo, the files undo restores.
   * Nothing when another layer decided.
   */
  private noteJevDecision(toolName: string, args: Record<string, unknown>, result: PermissionCheckResult, definition: ToolDefinition | undefined): void {
    const receipt = result.autonomousDecision;
    if (result.sourceLayer !== 'jev_decision' || !receipt) return;
    const directory = this.configReader.getWorkingDirectory();
    const option = buildRememberOptions(toolName, args).find((candidate) => candidate.tier !== 'session');
    let scope: string | undefined;
    let remember: ((effect: JevDecisionRuleEffect) => Promise<string>) | undefined;
    if (option !== undefined && option.tier !== 'session' && directory) {
      const tier = option.tier;
      const allow = buildDurableRuleForDecision({ toolName, args, tier, effect: 'allow' });
      const deny = buildDurableRuleForDecision({ toolName, args, tier, effect: 'deny' });
      const ask = buildDurableRuleForDecision({ toolName, args, tier, effect: 'ask' });
      if (allow && deny && ask) {
        const chosen: Readonly<Record<JevDecisionRuleEffect, PolicyRule>> = { allow, deny, ask };
        scope = `${option.label} (${option.detail})`;
        remember = (effect) => this.saveStandingRule(chosen[effect], tier, toolName, directory);
      }
    }
    const paths = extractPathArgs(args);
    const undoPaths = result.approved && paths.length > 0 && declaredRecoverable(definition, args)
      ? paths.map((path) => resolve(directory ?? '', path)) : undefined;
    this.jevDecisions().record({
      toolName, summary: result.analysis.summary, approved: result.approved, reason: receipt.summary, decisionId: receipt.decisionId,
      ...(undoPaths ? { undoPaths } : {}),
      ...(scope !== undefined ? { scope } : {}),
    }, remember);
  }

  /** Save a standing rule the owner chose from a decision, scoped to the project it was made in; resolves with what it covers. */
  private async saveStandingRule(rule: PolicyRule, tier: Exclude<RememberTier, 'session'>, toolName: string, project: string): Promise<string> {
    const store = this.userRuleStore;
    if (!store?.remember) throw new Error('This app has no permission rule store, so no standing rule can be saved here.');
    await store.remember({ rule, tier, tool: toolName, createdAt: Date.now(), project: projectIdentity(project) });
    return rule.description ?? `${rule.effect} ${toolName} calls like this`;
  }

  /** The ledger Jev's decisions are kept in: the process's, unless the embedder gave one. */
  private jevDecisions(): JevDecisionLedger {
    return this.gate.jevDecisions ?? processJevDecisions();
  }

  /** The ledger this gate holds just-vibes calls in: the process's, unless the embedder gave one. */
  private heldForOwner(): HeldForOwnerLedger {
    return this.gate.heldForOwner ?? processHeldForOwner();
  }

  /** The calls just-vibes holds for the owner, oldest first. */
  listHeldForOwner(): readonly HeldForOwnerCall[] {
    return this.heldForOwner().list();
  }

  private result(
    approved: boolean,
    persisted: boolean,
    sourceLayer: PermissionDecisionSource,
    reasonCode: PermissionDecisionReasonCode,
    analysis: PermissionRequestAnalysis,
    extra: Partial<PermissionCheckResult> = {},
  ): PermissionCheckResult {
    const policy = decisionModelPolicyState();
    return { ...extra, approved, persisted, sourceLayer, reasonCode, analysis,
      ...(policy.operation === 'classic' ? { decisionPolicy: policy } : {}),
      decision: toolDecisionOf({ approved, reasonCode, sourceLayer, userReason: extra.userReason, detail: extra.detail,
        decision: extra.decision, autonomousDecision: extra.autonomousDecision }) };
  }

  private async evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
    classification: CommandClassification,
    options: JudgmentReadingOptions = {},
    owner?: AutonomousPermissionReading,
    subjects?: CallSubjects,
  ): Promise<LayeredPermissionDecision> {
    const view = this.ruleView();
    const unchanged = owner ? undefined : this.ruleRevisions(view.revision);
    const current = () => {
      options.signal?.throwIfAborted();
      if (owner) { owner.assertCurrent(); return; }
      assertProjectionCurrent(projectionFunction<() => void>(projectionProperty(options, 'assertCurrent')));
      if (!unchanged!()) throw new Error('Permission configuration changed while reading');
    };
    current();
    // User-origin rules are evaluated before managed (registry) rules by the
    // evaluator, so a user allow-rule wins over a managed one.
    const rules = owner ? [...owner.frame.rules, ...view.remembered, ...owner.frame.policyRules] : [
      ...view.committed,
      ...view.remembered,
      ...(this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? []),
    ];
    const evaluator = new LayeredPolicyEvaluator({
      mode:
        mode === 'yolo' ? 'allow-all'
        : mode === 'plan' ? 'plan'
        : 'default',
      projectRoot: (owner ? owner.frame.directory : this.configReader.getWorkingDirectory()) ?? undefined,
      rules,
      defaultEffect: 'deny',
    });
    const decision = await evaluator.evaluateAsync(toolName, args, classification, { signal: options.signal, assertCurrent: current, subjects });
    this.exportDecision(decision, mode);
    return decision;
  }

  /**
   * The rule lists one check matches against, read once: another process's
   * write is taken in here (one `stat`), and the lists are the store's frozen
   * copies, rebuilt only when a rule changed.
   */
  private ruleView(): { readonly committed: readonly PolicyRule[]; readonly remembered: readonly PolicyRule[]; readonly revision: number } {
    const store = this.userRuleStore;
    const project = this.configReader.getWorkingDirectory();
    if (!store) return { committed: [], remembered: [], revision: 0 };
    if (store.evaluationRules) return store.evaluationRules(project);
    return { committed: store.rules(project), remembered: store.rememberedRules?.(project) ?? [],
      revision: store.committedRevision?.() ?? store.getPublicationRevision?.() ?? 0 };
  }

  /**
   * The integers the rule list a non-autonomous check reads is current by:
   * the rule store's publication revision as the check read it, the managed
   * policy bundle, and this manager's session answers. Compares are in memory;
   * another process's write was taken in when the rules were read, and the
   * claim before the call runs compares the store's committed revision again.
   */
  private ruleRevisions(rulesRevision: number): () => boolean {
    const store = this.userRuleStore;
    const read = () => [store?.getPublicationRevision?.() ?? rulesRevision,
      this.policyRuntimeState.getRegistry().getPublicationRevision?.() ?? 0, this.sessionApprovalRevision] as const;
    const policy = read()[1], session = this.sessionApprovalRevision;
    return () => { const now = read(); return now[0] === rulesRevision && now[1] === policy && now[2] === session; };
  }

  /**
   * Hand one policy decision to the OTLP exporter when decision telemetry is on.
   *
   * Fire-and-forget, and deliberately so. `exportDecisions` never throws and
   * reports its own failures, and a permission decision must not wait on a
   * collector: an unreachable endpoint would otherwise stall every tool call.
   * The sequence number is process-wide and the trace id is the session's, so
   * a collector can order decisions and join those of one session.
   */
  private exportDecision(decision: LayeredPermissionDecision, mode: PermissionConfigSnapshot['permissions']['mode']): void {
    const config = this.configReader.getDecisionOtlpConfig?.();
    if (!config?.enabled || !config.endpoint.trim()) return;
    const sessionId = sessionOfCheck.getStore();
    void exportDecisions([{ seq: ++exportedDecisionSequence, decision }], config,
      { mode: mode ?? 'prompt', ...(sessionId ? { traceId: sessionTraceId(sessionId) } : {}) })
      .catch((error: unknown) => {
        logger.warn('decision OTLP export failed', { error: summarizeError(error) });
      });
  }

  /**
   * Map explicit user or managed policy rules to permission results. Only the
   * evaluator's policy layer supplies a result here; preset decisions use the
   * Jev reading in the surrounding permission flow.
   */
  private mapEvaluatorDecision(
    decision: LayeredPermissionDecision,
    analysis: PermissionRequestAnalysis,
  ): PermissionCheckResult | null {
    if (decision.sourceLayer === 'policy') {
      return decision.allowed
        ? this.result(true, false, 'managed_policy', 'managed_policy_allow', analysis)
        : this.result(false, false, 'managed_policy', 'managed_policy_deny', analysis);
    }
    return null;
  }

  private emitAndReturn(
    callId: string,
    toolName: string,
    category: PermissionCategory,
    result: PermissionCheckResult,
    hookOwner?: TurnHookOwner,
  ): PermissionCheckResult {
    this.policyRuntimeState.recordPermissionDecision({
      callId,
      tool: toolName,
      category,
      result,
    });
    void this.fireHook('Post:permission:decision', 'Post', 'permission', 'decision', {
      callId,
      toolName,
      category,
      approved: result.approved,
      persisted: result.persisted,
      sourceLayer: result.sourceLayer,
      reasonCode: result.reasonCode,
      riskLevel: result.analysis.riskLevel,
      classification: result.analysis.classification,
      riskFamily: result.reading?.family,
      stakes: result.reading?.stakes,
      preset: result.preset?.preset,
      boundaryRefusedBy: result.boundary?.refusedBy,
    }, hookOwner);
    return { ...result, category };
  }

  private async fireHook(
    path: HookEventPath,
    phase: HookPhase,
    category: HookCategory,
    specific: string,
    payload: Record<string, unknown>,
    hookOwner?: TurnHookOwner,
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await bindTurnHookDispatcher(this.hookDispatcher, hookOwner ?? null)!.fire({
        path,
        phase,
        category,
        specific,
        sessionId: hookOwner?.sessionId ?? 'permissions',
        timestamp: Date.now(),
        payload,
      });
    } catch (error) {
      // Permission hooks are observability-only. Dispatch failures are logged
      // but do not alter permission decisions or prompt flow.
      logger.warn('PermissionManager: permission hook dispatch failed', {
        path,
        callId: typeof payload['callId'] === 'string' ? payload['callId'] : undefined,
        error: summarizeError(error),
      });
    }
  }
}
