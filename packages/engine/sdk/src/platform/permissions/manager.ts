import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { readExternalRequestEvidence, type ExternalRequestEvidence } from './external-request-evidence.js';
import { hashState, JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { captureOwnedJson, captureJsonEntry, snapshotJudgmentEntry } from '../gate/judgment-input.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { assertAutonomousData, captureCurrentAutonomousChoices, captureCurrentAutonomousSourceFrame, type AutonomousToolChoices, type AutonomousToolRevision, type AutonomousToolSource, autonomousSourceEvidence, decideAutonomousTool } from './autonomous.js';
import { AutonomousChoiceProjectionOwner, type AutonomousChoiceProjection } from './autonomous-input-projection.js';
import type { PreparedToolCall, ToolRegistry, ToolExecutionEffect } from '../tools/registry.js';
import { assertProjectionCurrent, projectionFunction, projectionProperty, ToolInputProjectionError, type ToolPreparedSettingsMutation } from '../tools/input-projection.js';
import type { JevVersionRef } from '@goodvibes-jev/judgment/decisions';
import { bindTurnHookDispatcher, type TurnHookOwner } from '../hooks/turn-ownership.js';
import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.js';
import type { BackgroundAgentsMode, PermissionsToolConfig } from '../config/schema.js';
import type { PermissionAttribution, PermissionExecutionOptions, PermissionRequestHandler } from './prompt.js';
import { assertPermissionActive, awaitPermission } from './cancellation.js';
import { analyzePermissionRequest, withReading } from './analysis.js';

import { effectivePermissionMode, presetForMode, type GatePreset, type GatePresetName } from '../gate/presets.js';
import { judgmentInputBoundary, runBoundary } from '../gate/boundary.js';
import { readToolCall, shellCommandsIn } from '../gate/reading.js';
import { currentExecutionMode, currentExecutionModeOwner, isInvocationAdmitted, withExecutionMode } from '../gate/execution-context.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { currentTurnSurfaceId } from '../security/turn-boundary.js';
import { effectPermittedForProvenance } from '../gate/surface-authority.js';
import { isStateMutation } from '../gate/policy/state-policy.js';
import { commandClassOf, matchDurableRulesAsync } from './approval-rules.js';
import type { UserPermissionRuleStore } from './user-rule-store.js';
import { extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.js';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.js';
import { exportDecisions } from '../runtime/permissions/decision-otlp.js';
import type { DecisionOtlpConfig } from '../runtime/permissions/decision-otlp.js';
import type { CommandClassification, PolicyRule, PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import type { ConfigManager, PreparedConfigMutationTransition } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  PermissionCategory,
  PermissionCheckResult,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
  PermissionRequestAnalysis,
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
  readonly sessionGrants: readonly (readonly [string, boolean])[];
  readonly policyEnabled: boolean;
}
type AutonomousPermissionReading = Readonly<{
  frame: AutonomousPermissionOwner;
  assertCurrent(): void;
}>;


export interface PermissionConfigReader {
  /** Settle already-visible owner disk generations before capturing authority. Never called from a retained currentness check. */
  flushPendingChanges?(): void;
  /** Coherent owner-held frame. Must read owned state without invoking observers or host callbacks. */
  getAutonomousSnapshot?(): Readonly<{ permissions: PermissionConfigSnapshot['permissions']; autoApprove: boolean; directory: string | null; incarnation?: number }>;
  isAutoApproveEnabled(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
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

export function createPermissionConfigReader(
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'> & Partial<Pick<ConfigManager, 'getAutonomousPermissionSnapshot' | 'flushConfigFileChanges'>>,
): PermissionConfigReader {
  // Bind the construction-owned accessor, not its result. Every check still
  // copies current permission state; unrelated configuration domains need not
  // be cloned for each original-owner/runtime path in a captured read sweep.
  const permissionSnapshot = configManager.getAutonomousPermissionSnapshot?.bind(configManager);
  const flushPendingChanges = configManager.flushConfigFileChanges?.bind(configManager);
  const reader: PermissionConfigReader = {
    ...(flushPendingChanges ? { flushPendingChanges } : {}),
    ...(permissionSnapshot ? { getAutonomousSnapshot: permissionSnapshot } : {}),
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    getSnapshot: permissionSnapshot
      ? () => ({ permissions: permissionSnapshot().permissions })
      : () => getConfigSnapshot(configManager),
    getWorkingDirectory: () => configManager.getWorkingDirectory(),
    // Read per decision, not captured: switching export on is a live change.
    getDecisionOtlpConfig: () => readDecisionOtlpConfig(configManager),
  };
  permissionConfigOwners.set(reader, configManager);
  return reader;
}

/** Maps tool names to permission categories and config tool keys. */
const TOOL_CATEGORIES: Record<string, PermissionCategory> = {
  read: 'read',
  find: 'read',
  fetch: 'read',
  analyze: 'read',
  inspect: 'read',
  state: 'read',
  registry: 'read',
  goodvibes_context: 'read',
  repo_map: 'read',
  context_accounting: 'read',
  // write, new tool names
  write: 'write',
  edit: 'write',
  goodvibes_settings: 'write',
  // execute, new tool name
  exec: 'execute',
  // delegate, new tool names
  agent: 'delegate',
  delegate: 'delegate',
  workflow: 'delegate',
  mcp: 'delegate',
};

/** Owner tool denials are independent of which safe execution mode judges risk. */
const TOOL_CONFIG_KEYS: Readonly<Record<string, keyof PermissionsToolConfig>> = {
  read: 'read', write: 'write', edit: 'edit', exec: 'exec', find: 'find', fetch: 'fetch',
  analyze: 'analyze', inspect: 'inspect', agent: 'agent', state: 'state', workflow: 'workflow',
  registry: 'registry', goodvibes_context: 'state', goodvibes_settings: 'write', delegate: 'delegate', mcp: 'mcp',
};

/** How the gate learns who is asking and what the turn has read. */
export interface GateOptions {
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

export class PermissionManager {
  private readonly autonomousChoiceProjections = new AutonomousChoiceProjectionOwner();
  private readonly autonomousPending = new Set<string>();
  private readonly autonomousEpochs = new Map<string, number>();
  private readonly autonomousClaims = new Set<string>();
  private readonly ownerRevisions = new Map<string, { readonly toolName: string; readonly argsRevision: string; readonly authorityRevision: string }>();
  private readonly autonomousDeferred = new Map<string, { readonly inputRevision: string; readonly until: JevVersionRef }>();
  /** Explicit session-tier decisions only; durable rules are always matched live. */
  private sessionApprovals = new Map<string, boolean>();
  private readonly policyDecisionOwners = new WeakMap<LayeredPermissionDecision, () => void>();
  private sessionApprovalRevision = 0;
  private readonly requestPermission: PermissionRequestHandler;
  private readonly configReader: PermissionConfigReader;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly userRuleStore: (Pick<UserPermissionRuleStore, 'rules' | 'add'> & Partial<Pick<UserPermissionRuleStore, 'init' | 'awaitReady' | 'getPublicationRevision'>>) | null;
  private readonly gate: GateOptions;

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader,
    policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
    featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null = null,
    userRuleStore: (Pick<UserPermissionRuleStore, 'rules' | 'add'> & Partial<Pick<UserPermissionRuleStore, 'init' | 'awaitReady' | 'getPublicationRevision'>>) | null = null,
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
    const ready = owner?.awaitReady ?? owner?.init;
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
    const rules = this.userRuleStore?.rules() ?? [];
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
    const mode = executionOwner?.getMode() ?? effectivePermissionMode(scope.permissions.mode, scope.autoApprove);
    const frame = { ...scope, permissions: { ...scope.permissions, mode }, autoApprove: false,
      executionOwnerRevision: executionOwner?.getRevision(), source, surface, rules, rulePublication, policyRules, policyPublication, policyEnabled,
      sessionGrants: [...this.sessionApprovals], sessionPublication: this.sessionApprovalRevision, exposure,
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

  /** The same live authority owns pre-admission argument-repair judgment. */
  autonomousPreparation(sourceId: string, sourceOf: () => AutonomousToolSource, signal?: AbortSignal, decoratePort?: (port: JudgmentPort) => JudgmentPort, choiceProjection?: AutonomousChoiceProjection): { readonly port: JudgmentPort; assertCurrent(): void } {
    assertPermissionActive(signal);
    this.assertSelectedModeCurrent();
    const revision = hashState(captureJsonEntry(this.autonomousAuthority(sourceId, sourceOf, choiceProjection)));
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.autonomousClaims.has(sourceId) || hashState(captureJsonEntry(this.autonomousAuthority(sourceId, sourceOf, choiceProjection, 'currentness'))) !== revision)
        throw new Error('Autonomous preparation authority changed or source was claimed');
      assertPermissionActive(signal);
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
        return awaitPermission(() => owner().ask({ ...request, beforeAttempt() { assertCurrent(); prior?.(); } }), signal);
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
    const category = admissionEvidence?.kind === 'agent-settings' ? 'write'
      : preparedCall?.registry.isPreparedReadOnly(preparedCall.call) ? 'read' : this.getCategory(toolName, args);
    const assertWorkspace = await this.autonomousWorkspaceConstraint(category, signal);
    const settingsMutation = preparedCall?.registry.readPreparedSettingsMutation(preparedCall.call);
    const authority = () => this.autonomousAuthority(sourceId, sourceOf, choiceProjection, 'currentness');
    // A running selected projection is already claimed. Its body compares the
    // raw owner frame rather than re-entering preclaim catalog/source guards.
    const rawAuthority = this.autonomousAuthority(sourceId, sourceOf);
    const rawAuthorityRevision = hashState(captureJsonEntry(rawAuthority));
    const capturedAuthority = (choiceProjection === undefined ? rawAuthority : Object.freeze({ ...rawAuthority,
      autonomousChoices: this.autonomousChoiceProjections.choices(choiceProjection, sourceId, rawAuthority) })) as AutonomousPermissionOwner & {
        source: AutonomousToolSource; autonomousChoices: AutonomousToolChoices; directory: string | null; permissions: PermissionConfigSnapshot['permissions']; autoApprove: boolean; surface?: string | undefined;
      };
    const source = capturedAuthority.source;
    const authorityRevision = hashState(captureJsonEntry(capturedAuthority));
    const assertPrepared = projectionFunction<() => void>(projectionProperty(options, 'assertPrepared'));
    const assertCurrent = () => {
      assertPermissionActive(signal); assertWorkspace();
      if (this.autonomousEpochs.get(sourceId) !== epoch) throw new Error('Autonomous admission was superseded');
      // Stage the compatibility callback before the final owner snapshot: it
      // may publish a revocation even when it returns normally.
      assertProjectionCurrent(assertPrepared);
      const current = authority();
      assertPermissionActive(signal);
      if (hashState(captureJsonEntry(current)) !== authorityRevision) throw new Error('Autonomous admission authority, source or scope changed');
      if (preparedCall) preparedCall.registry.assertPrepared(preparedCall.call);
      if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
      assertWorkspace();
    };
    assertCurrent();
    const analysis = analyzePermissionRequest(toolName, args, category);
    this.policyRuntimeState.recordPermissionRequest({ callId: sourceId, tool: toolName, category, analysis });
    assertCurrent();
    const permissions = capturedAuthority.permissions;
    const mode = effectivePermissionMode(permissions?.mode, capturedAuthority.autoApprove === true);
    const preset = presetForMode(mode);
    const effectReadOnly = preset.readOnly;
    const effectSurface = capturedAuthority.surface;
    const effectWriteDenied = mode !== 'yolo' && permissions.tools?.write === 'deny';
    const owner = { frame: capturedAuthority, assertCurrent };
    const durable = mode === 'yolo' ? null : await this.rememberedDecision(this.getApprovalKey(toolName, args), toolName, args, { signal, assertCurrent }, owner);
    const policy = mode !== 'yolo' && capturedAuthority.policyEnabled
      ? this.mapEvaluatorDecision(await this.evaluateRuntimePolicy(toolName, args, mode, this.policyClassification(category), { signal, assertCurrent }, owner), analysis)
      : null;
    durable?.assertCurrent();
    const planDenied = preset.readOnly && category !== 'read';
    const policyResult = !this.surfaceAllows(category, effectSurface)
      ? this.result(false, false, 'boundary', 'boundary_surface_authority', analysis)
      : mode !== 'yolo' && this.ownerDeniesTool(toolName, category, permissions.tools)
        ? this.result(false, false, 'config_policy', 'config_deny', analysis)
      : mode === 'yolo' ? this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis)
      : planDenied ? this.result(false, false, 'runtime_mode', 'plan_mode', analysis)
      : durable?.approved === false ? this.result(false, true, durable.source, durable.reason, analysis)
      : policy?.approved === false ? policy
      : this.result(true, false, 'config_policy', 'config_allow', analysis);
    const safety = await this.assessExecutionSafety({
      callId: sourceId, toolName, args, category, policyResult, mode, signal, assertCurrent,
      workingDirectory: capturedAuthority.directory ?? undefined, source,
      sourceId, actionRevision: hashState(captureJsonEntry({ toolName, args, schemaRevision })), authorityRevision,
      supportingIds: options.preparationDecisionIds ?? [], decoratePort: options.decoratePort,
    });
    const result = safety.result;
    this.policyRuntimeState.recordPermissionDecision({ callId: sourceId, tool: toolName, category, result });
    assertCurrent();
    const admission: AutonomousPermissionAdmission = Object.freeze({
      result, revisionIds: Object.freeze(safety.revision ? [safety.revision.ref.id] : []),
      ...(safety.revision ? { revision: safety.revision } : {}),
      claim: () => {
        assertCurrent();
        if (!result.approved) throw new Error('Owner policy denied this tool call');
        safety.recordClaim?.();
        assertCurrent();
        this.autonomousClaims.add(sourceId);
        this.autonomousDeferred.delete(sourceId);
      },
    });
    if (result.approved) {
      let acceptedRevision = rawAuthorityRevision;
      let acceptedIncarnation = (rawAuthority as Readonly<Record<string, unknown>>)['incarnation'];
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
        let expected = acceptedIncarnation;
        if (activeTransition) {
          const { binding, transition } = activeTransition;
          const mutation = assertTransitionBinding(binding);
          const facts = binding.owner.inspectPreparedMutationTransition(mutation, transition);
          if (facts.beforeIncarnation !== acceptedIncarnation || facts.afterIncarnation !== facts.beforeIncarnation + 1) {
            throw new Error('Autonomous settings transition changed');
          }
          expected = facts.afterIncarnation;
        }
        const current = this.autonomousAuthority(sourceId, sourceOf, undefined, 'currentness');
        assertOwnedLifetime();
        if ((current as Readonly<Record<string, unknown>>)['incarnation'] !== expected
          || hashState(captureJsonEntry({ ...current, incarnation: acceptedIncarnation })) !== acceptedRevision) {
          throw new Error('Autonomous execution authority, source or scope changed');
        }
        assertWorkspace();
      };
      const record: AuthenticAutonomousAdmission = {
        issuer: this, registry: preparedCall?.registry, call: preparedCall?.call, claim: admission.claim, consumed: false, assertWorkspace,
        settingsBinding: settingsMutation, nestedSettingsBindings, parents,
        nestedOwner: Object.freeze({ manager: this, source, decoratePort: options.decoratePort }),
        assertEffect: effect => {
          if ((effect !== 'write' && effect !== 'send') || effectReadOnly || effectWriteDenied
            || (effectSurface !== undefined && !effectPermittedForProvenance(effect, { surfaceId: effectSurface }).allowed)) {
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
          const current = this.autonomousAuthority(sourceId, sourceOf, undefined, 'currentness');
          assertOwnedLifetime(); actual.owner.assertCompletedMutation(mutation);
          if ((current as Readonly<Record<string, unknown>>)['incarnation'] !== facts.afterIncarnation
            || hashState(captureJsonEntry({ ...current, incarnation: acceptedIncarnation })) !== acceptedRevision) {
            throw new Error('Autonomous settings completion authority changed');
          }
          acceptedIncarnation = facts.afterIncarnation;
          acceptedRevision = hashState(captureJsonEntry(current));
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
  private assessExecutionSafety(input: Parameters<PermissionManager['assessDecisionExecutionSafety']>[0]): ReturnType<PermissionManager['assessDecisionExecutionSafety']> {
    return decisionOrClassic(() => this.assessDecisionExecutionSafety(input), () => this.assessClassicExecutionSafety(input));
  }

  private async assessClassicExecutionSafety(input: Parameters<PermissionManager['assessDecisionExecutionSafety']>[0]): ReturnType<PermissionManager['assessDecisionExecutionSafety']> {
    input.assertCurrent();
    if (!input.policyResult.approved || input.mode === 'plan' || input.mode === 'yolo') return { result: input.policyResult };
    const analysis = input.policyResult.analysis;
    const remembered = await this.rememberedDecision(this.getApprovalKey(input.toolName, input.args), input.toolName, input.args,
      { signal: input.signal, assertCurrent: input.assertCurrent });
    remembered?.assertCurrent(); input.assertCurrent();
    if (remembered) return { result: this.result(remembered.approved, true, remembered.source, remembered.reason, analysis) };
    const tools = this.configReader.getSnapshot().permissions.tools;
    const configured = tools?.[TOOL_CONFIG_KEYS[input.toolName] ?? 'unknown'];
    if (configured === 'allow' || input.category === 'read' && configured !== 'prompt') {
      input.assertCurrent();
      return { result: this.result(true, false, 'config_policy', 'config_allow', analysis,
        { detail: 'Classic operation: authorized by owner configuration and deterministic tool category; no semantic safety reading.' }) };
    }
    const approvedRevision = this.ownerRevisions.get(input.sourceId);
    if (approvedRevision && approvedRevision.toolName === input.toolName
      && approvedRevision.argsRevision === hashState(captureJsonEntry(input.args)) && approvedRevision.authorityRevision === input.authorityRevision) {
      this.ownerRevisions.delete(input.sourceId);
      return { result: this.result(true, false, 'user_prompt', 'user_approved', analysis) };
    }
    const reply = await awaitPermission(() => this.requestPermission({ callId: input.callId,
      tool: input.toolName, args: input.args, category: input.category, analysis,
      workingDirectory: input.workingDirectory,
      ...(input.attribution ? { attribution: input.attribution } : {}),
    }, { signal: input.signal }), input.signal);
    input.assertCurrent();
    const modified = reply.modifiedArgs === undefined ? undefined : captureOwnedJson(reply.modifiedArgs) as Record<string, unknown>;
    if (reply.approved && modified && hashState(captureJsonEntry(modified)) !== hashState(captureJsonEntry(input.args)) && input.source) {
      const argsRevision = hashState(captureJsonEntry(modified));
      if (this.ownerRevisions.size >= 10_000 && !this.ownerRevisions.has(input.sourceId)) throw new Error('Owner revision capacity reached');
      this.ownerRevisions.set(input.sourceId, Object.freeze({ toolName: input.toolName, argsRevision, authorityRevision: input.authorityRevision }));
      return { revision: Object.freeze({ ref: Object.freeze({ id: `owner-revision-${input.callId}`, revision: argsRevision, kind: 'revise-action' }),
        toolName: input.toolName, args: modified }),
        result: this.result(false, false, 'user_prompt', 'user_approved', analysis,
          { modifiedArgs: modified, detail: 'Prepare the exact action revised and approved by the owner during Classic operation.' }) };
    }
    return { result: this.result(reply.approved, false, 'user_prompt', reply.approved ? 'user_approved' : 'user_denied', analysis,
      { userReason: reply.reason, ...(modified ? { modifiedArgs: modified } : {}) }) };
  }

  private async assessDecisionExecutionSafety(input: {
    readonly callId: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly category: PermissionCategory;
    readonly policyResult: PermissionCheckResult;
    readonly mode: GatePresetName;
    readonly signal: AbortSignal | undefined;
    readonly assertCurrent: () => void;
    readonly workingDirectory: string | undefined;
    readonly source?: AutonomousToolSource;
    readonly sourceId: string;
    readonly actionRevision: string;
    readonly authorityRevision: string;
    readonly supportingIds?: readonly string[];
    readonly decoratePort?: ((port: JudgmentPort) => JudgmentPort) | undefined;
    readonly attribution?: PermissionAttribution | undefined;
  }): Promise<{ readonly result: PermissionCheckResult; readonly recordClaim?: () => void; readonly revision?: AutonomousToolRevision }> {
    input.assertCurrent();
    if (!input.policyResult.approved) return { result: input.policyResult };
    const approvedRevision = this.ownerRevisions.get(input.sourceId);
    if (input.mode === 'safe-owner' && approvedRevision
      && approvedRevision.toolName === input.toolName && approvedRevision.argsRevision === hashState(captureJsonEntry(input.args))
      && approvedRevision.authorityRevision === input.authorityRevision) {
      this.ownerRevisions.delete(input.sourceId);
      return { result: this.result(true, false, 'user_prompt', 'user_approved', input.policyResult.analysis,
        { preset: { preset: 'safe-owner', action: 'allow' }, detail: 'The owner approved these exact revised arguments.' }) };
    }
    if (approvedRevision) this.ownerRevisions.delete(input.sourceId);
    if (input.mode === 'yolo') {
      return { result: this.result(true, false, 'runtime_mode', 'mode_allow_all', input.policyResult.analysis,
        { preset: { preset: 'yolo', action: 'allow' } }) };
    }
    if (input.mode === 'plan') return { result: input.policyResult };
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
          input.assertCurrent();
          const prior = request.beforeAttempt;
          const result = await awaitPermission(() => installed.ask({ ...request, beforeAttempt() { prior?.(); input.assertCurrent(); } }), input.signal);
          input.assertCurrent();
          if (input.mode === 'safe-jev' && !result.decisionId) throw new JudgmentError('unrecorded', 'execution safety requires recorded provenance');
          if (result.decisionId) supportingIds.push(result.decisionId);
          return result;
        },
      };
      reading = await readToolCall({ toolName: input.toolName, args: input.args, workingDirectory: input.workingDirectory,
        askKind: TOOL_CATEGORIES[input.toolName] === undefined, askObfuscated: shellCommandsIn(input.args).length > 0,
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
    if (input.mode === 'safe-owner') {
      if (boundary.passed && reading?.stakes !== 'critical' && reading?.irreversible !== true && reading?.weakensSecurity !== true) {
        return { result: this.result(true, input.policyResult.persisted,
          input.policyResult.persisted ? input.policyResult.sourceLayer : 'stakes_preset',
          input.policyResult.persisted ? input.policyResult.reasonCode : 'preset_allow', analysis,
          { boundary: boundaryResult, preset: { preset: 'safe-owner', action: 'allow' } }) };
      }
      const reply = await awaitPermission(() => this.requestPermission({
        callId: input.callId, tool: input.toolName, args: input.args, category: input.category,
        analysis: { ...analysis, reasons: [...analysis.reasons,
          ...(!boundary.passed ? [boundary.reason] : []),
          ...(!input.policyResult.approved ? [input.policyResult.detail ?? input.policyResult.reasonCode] : [])] },
        workingDirectory: input.workingDirectory,
        ...(input.attribution ? { attribution: input.attribution } : {}),
      }, { signal: input.signal }), input.signal);
      const approved = reply.approved;
      const reason = reply.reason;
      const modified = reply.modifiedArgs === undefined ? undefined : captureOwnedJson(reply.modifiedArgs) as Record<string, unknown>;
      input.assertCurrent();
      if (approved && modified && hashState(captureJsonEntry(modified)) !== hashState(captureJsonEntry(input.args))) {
        if (!input.source) {
          return { result: this.result(true, false, 'user_prompt', 'user_approved', analysis,
            { boundary: boundaryResult, modifiedArgs: modified, userReason: reason, preset: { preset: 'safe-owner', action: 'ask' } }) };
        }
        const argsRevision = hashState(captureJsonEntry(modified));
        if (this.ownerRevisions.size >= 10_000 && !this.ownerRevisions.has(input.sourceId)) throw new Error('Owner revision capacity reached');
        this.ownerRevisions.set(input.sourceId, Object.freeze({ toolName: input.toolName, argsRevision, authorityRevision: input.authorityRevision }));
        const revision: AutonomousToolRevision = Object.freeze({
          ref: Object.freeze({ id: `owner-revision-${input.callId}`, revision: argsRevision, kind: 'revise-action' }),
          toolName: input.toolName, args: modified,
        });
        return { revision, result: this.result(false, false, 'user_prompt', 'user_approved', analysis,
          { boundary: boundaryResult, modifiedArgs: modified, detail: 'Prepare the exact action revised and approved by the owner.', userReason: reason }) };
      }
      return { result: this.result(approved, false, 'user_prompt', approved ? 'user_approved' : 'user_denied', analysis,
        { boundary: boundaryResult, userReason: reason, preset: { preset: 'safe-owner', action: 'ask' } }) };
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
      state: snapshotJudgmentEntry({ tool: input.toolName, arguments: input.args,
        ...(input.source ? { source: autonomousSourceEvidence(input.source) } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        evidence: { boundary: boundaryResult, ...(reading ? { reading: { family: reading.family, stakes: reading.stakes, uncertain: reading.uncertain,
          mutates: reading.mutates, outward: reading.outward, secrets: reading.secrets, irreversible: reading.irreversible,
          beyondProject: reading.beyondProject, weakensSecurity: reading.weakensSecurity, obfuscated: reading.obfuscated,
          boundary: reading.boundary } } : {}) },
        constraints: { mode: input.mode, ownerPolicyAllowed: input.policyResult.approved },
        provenance: { surface: this.gate.surfaceOf?.() ?? 'owner-direct' } }),
      evidence: [{ id: 'requested-tool-input', revision: input.actionRevision }, { id: 'live-authority', revision: input.authorityRevision }],
      supportingDecisionIds: supportingIds, choices: {}, allowAct: input.policyResult.approved,
      assertCurrent: input.assertCurrent, signal: input.signal,
    });
    input.assertCurrent();
    const receipt = decision.decision;
    return {
      result: this.result(receipt.outcome === 'act', false, 'jev_decision', `jev_${receipt.outcome}`, analysis,
        { boundary: boundaryResult, autonomousDecision: receipt, detail: receipt.summary,
          preset: { preset: 'safe-jev', action: receipt.outcome === 'act' ? 'allow' : 'deny' } }),
      recordClaim: () => { decision.assertCurrent(); decision.recordClaim(); input.assertCurrent(); },
    };
  }

  /** Resolves to true when the gate approves the call. */
  async check(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<boolean> {
    const signal = options?.signal;
    const result = await this.checkDetailed(toolName, args, attribution, options);
    assertPermissionActive(signal);
    return result.approved;
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
    const check = () => withExecutionMode(this.getMode(), () => this.checkActive(toolName, args, attribution, signal, owner));
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

  private async checkActive(toolName: string, borrowedArgs: Record<string, unknown>, attribution: PermissionAttribution | undefined, signal?: AbortSignal, hookOwner?: TurnHookOwner): Promise<PermissionCheckResult> {
    assertPermissionActive(signal);
    const duplicate = isInvocationAdmitted(toolName, borrowedArgs);
    const args = captureOwnedJson(borrowedArgs) as Record<string, unknown>;
    const category = this.getCategory(toolName, args);
    const analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    const mode = this.getMode();
    if (duplicate) return this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis);
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
    const authorityRevision = hashState(captureJsonEntry(config));
    const assertCurrent = () => {
      assertPermissionActive(signal);
      exposure.assertCurrent(); assertWorkspace();
      if (this.gate.surfaceOf?.() !== surface) throw new Error('Execution source authority changed while deciding');
      if (mode !== this.getMode() || owner?.getRevision() !== ownerRevision
        || hashState(captureJsonEntry(authoritySnapshot())) !== authorityRevision) throw new Error('Execution mode or owner changed while deciding');
    };
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', { callId, toolName, category, analysis }, hookOwner);
    assertCurrent();
    this.policyRuntimeState.recordPermissionRequest({ callId, tool: toolName, category, analysis });
    let policyResult = this.result(true, false, 'config_policy', 'config_allow', analysis);
    if (mode !== 'yolo') {
      if (mode === 'plan' && category !== 'read') policyResult = this.result(false, false, 'runtime_mode', 'plan_mode', analysis);
      else {
        if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
          const policy = this.mapEvaluatorDecision(await this.evaluateRuntimePolicy(toolName, args, mode, this.policyClassification(category), { signal, assertCurrent }), analysis);
          if (policy) policyResult = policy;
        }
        const remembered = await this.rememberedDecision(this.getApprovalKey(toolName, args), toolName, args, { signal, assertCurrent });
        remembered?.assertCurrent();
        if (remembered) policyResult = this.result(remembered.approved, true, remembered.source, remembered.reason, analysis);
      }
    }
    if (!this.surfaceAllows(category, surface)) policyResult = this.result(false, false, 'boundary', 'boundary_surface_authority', analysis);
    else if (mode !== 'yolo' && this.ownerDeniesTool(toolName, category, config.permissions?.tools)) policyResult = this.result(false, false, 'config_policy', 'config_deny', analysis);
    const safety = await this.assessExecutionSafety({
      callId, sourceId: callId, toolName, args, category, policyResult, mode, signal, assertCurrent,
      workingDirectory: config.directory ?? undefined, authorityRevision,
      actionRevision: hashState(captureJsonEntry({ toolName, args })), attribution,
    });
    assertCurrent();
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

  /** Explicit session decisions, then current durable rules with their own scope. */
  private async rememberedDecision(
    key: string,
    toolName: string,
    args: Record<string, unknown>,
    options: JudgmentReadingOptions = {},
    owner?: AutonomousPermissionReading,
  ): Promise<{ approved: boolean; source: PermissionDecisionSource; reason: PermissionDecisionReasonCode; assertCurrent(): void } | null> {
    const legacyRevision = () => JSON.stringify([this.sessionApprovalRevision, this.userRuleStore?.getPublicationRevision?.(), this.userRuleStore?.rules(), this.configReader.getAutonomousSnapshot?.().incarnation, this.configReader.getSnapshot().permissions, this.configReader.getWorkingDirectory()]);
    const before = owner ? undefined : legacyRevision();
    const current = () => {
      options.signal?.throwIfAborted();
      if (owner) { owner.assertCurrent(); return; }
      assertProjectionCurrent(projectionFunction<() => void>(projectionProperty(options, 'assertCurrent')));
      if (legacyRevision() !== before) throw new Error('Remembered permission owner changed while reading');
    };
    current();
    const sessions = owner ? new Map(owner.frame.sessionGrants) : this.sessionApprovals;
    if (sessions.has(key)) {
      const approved = sessions.get(key)!;
      return { approved, source: 'session_override', reason: approved ? 'session_cached_allow' : 'session_cached_deny', assertCurrent: current };
    }
    const rules = owner ? owner.frame.rules : this.userRuleStore?.rules();
    const projectRoot = owner ? owner.frame.directory : rules ? this.configReader.getWorkingDirectory() : undefined;
    const durable = rules
      ? await matchDurableRulesAsync(rules, toolName, args, { ...options, assertCurrent: current, projectRoot: projectRoot ?? undefined })
      : null;
    current();
    if (!durable) return null;
    const approved = durable.effect === 'allow';
    return { approved, source: 'user_rule', reason: approved ? 'user_rule_allow' : 'user_rule_deny', assertCurrent: current };
  }

  /** Search, map and read tools share explicit owner rules without per-path Jev calls. */
  async readAccess(rawPath: string): Promise<'allow' | 'restricted'> {
    this.assertSelectedModeCurrent();
    const assertWorkspace = await this.autonomousWorkspaceConstraint('read');
    assertWorkspace();
    if (this.getMode() === 'yolo') return 'allow';
    const permissions = (this.configReader.getAutonomousSnapshot?.() ?? this.configReader.getSnapshot()).permissions;
    if (permissions?.tools?.read === 'deny') return 'restricted';
    if (typeof rawPath !== 'string' || rawPath.length === 0) return 'allow';
    const args = { path: rawPath };
    const mode = this.getMode();
    if (this.configReader.isAutoApproveEnabled()) return 'allow';
    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(await this.evaluateRuntimePolicy('read', args, mode, 'read'), analyzePermissionRequest('read', args, 'read'));
      assertWorkspace();
      if (mapped) return mapped.approved ? 'allow' : 'restricted';
    }
    const remembered = await this.rememberedDecision(this.getApprovalKey('read', args), 'read', args);
    remembered?.assertCurrent(); assertWorkspace();
    return remembered?.approved === false ? 'restricted' : 'allow';
  }

  /**
   * getMode, Returns the active session permission mode from config.
   * Surfaces (mode pill) and the orchestrator's standing plan-mode instruction
   * read this to reflect the current mode. Defaults to safe-owner.
   */
  getMode(): GatePresetName {
    const scoped = currentExecutionModeOwner();
    if (scoped) return scoped.getMode();
    const frame = this.configReader.getAutonomousSnapshot?.();
    return frame ? effectivePermissionMode(frame.permissions.mode, frame.autoApprove)
      : effectivePermissionMode(this.configReader.getSnapshot().permissions?.mode, this.configReader.isAutoApproveEnabled());
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
    const revision = hashState(captureJsonEntry(frame));
    const mode = owner?.getMode() ?? effectivePermissionMode(frame.permissions.mode, frame.autoApprove);
    return Object.freeze({ mode, assertCurrent: () => {
      if (currentExecutionModeOwner() !== owner || owner?.getRevision() !== ownerRevision
        || (owner && owner.getMode() !== mode) || hashState(captureJsonEntry(snapshot())) !== revision) {
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

  /** Saved background-agent settings no longer create a second execution policy. */
  getBackgroundAgentsMode(): BackgroundAgentsMode {
    return 'inherit';
  }

  /** Returns the permission category for a tool name. Unknown tools default to 'delegate'. */
  getCategory(toolName: string, args: Record<string, unknown> = {}): PermissionCategory {
    if (toolName === 'inspect' && args.mode === 'scaffold' && args.dryRun === false) {
      return 'write';
    }
    // A state call that writes (a value, a memory, a hook registration, a mode
    // change) is not the read the state tool's category names: it gets the
    // gate's full reading. The state tool's own read-only surface decides.
    if (toolName === 'state' && isStateMutation(args)) return 'write';
    return TOOL_CATEGORIES[toolName] ?? 'delegate';
  }

  /**
   * getApprovalKey - Stable key for session-level "always approve" decisions.
   * Includes the most meaningful argument to distinguish different invocations.
   */
  private getApprovalKey(toolName: string, args: Record<string, unknown>): string {
    // exec: key by command CLASS (git, npm, ...) so a remembered decision
    // covers the class, not one unique command string. edit/write: key by the
    // set of touched paths so one path's approval never blankets the tool.
    const commands = extractCommandArgs(args);
    if (toolName === 'exec' && commands.length > 0) {
      const classes = [...new Set(commands.map(commandClassOf).filter((cls) => cls.length > 0))].sort();
      if (classes.length > 0) return `${toolName}:class:${classes.join('+')}`;
    }
    const paths = extractPathArgs(args);
    if (paths.length > 0) {
      return `${toolName}:path:${JSON.stringify([...new Set(paths)].sort())}`;
    }
    if (typeof args['command'] === 'string') {
      return `${toolName}:${args['command']}`;
    }
    // Generic key: tool name only ("always allow this tool").
    return toolName;
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
      ...(policy.operation === 'classic' ? { decisionPolicy: policy } : {}) };
  }

  private async evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
    classification: CommandClassification,
    options: JudgmentReadingOptions = {},
    owner?: AutonomousPermissionReading,
  ): Promise<LayeredPermissionDecision> {
    // User-origin rules are evaluated before managed (registry) rules by the
    // evaluator, so a user allow-rule wins over a managed one.
    const legacyRevision = () => JSON.stringify([this.userRuleStore?.getPublicationRevision?.(), this.policyRuntimeState.getRegistry().getPublicationRevision?.(), this.userRuleStore?.rules(), this.policyRuntimeState.getRegistry().getCurrent(), this.configReader.getAutonomousSnapshot?.().incarnation, this.configReader.getSnapshot().permissions, this.configReader.getWorkingDirectory()]);
    const before = owner ? undefined : legacyRevision();
    const current = () => {
      options.signal?.throwIfAborted();
      if (owner) { owner.assertCurrent(); return; }
      assertProjectionCurrent(projectionFunction<() => void>(projectionProperty(options, 'assertCurrent')));
      if (legacyRevision() !== before) throw new Error('Permission configuration changed while reading');
    };
    current();
    const rules = owner ? [...owner.frame.rules, ...owner.frame.policyRules] : [
      ...(this.userRuleStore?.rules() ?? []),
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
    const decision = await evaluator.evaluateAsync(toolName, args, classification, { ...options, assertCurrent: current });
    current(); evaluator.assertCurrent(decision);
    this.exportDecisionRecords(evaluator, mode);
    current(); evaluator.assertCurrent(decision);
    this.policyDecisionOwners.set(decision, () => { current(); evaluator.assertCurrent(decision); });
    return decision;
  }

  /**
   * Hand this evaluation's decision-log records to the OTLP exporter.
   *
   * The evaluator is constructed per evaluation, so its log contains exactly
   * the records this call produced. Export runs only when the current config
   * enables decision telemetry and supplies a nonempty collector endpoint.
   *
   * Fire-and-forget, and deliberately so. `exportDecisions` never throws and
   * reports its own failures, and a permission decision must not wait on a
   * collector: an unreachable endpoint would otherwise stall every tool call.
   * One record per request rather than a batch, because a batch would mean
   * holding decisions back from a collector to save round trips on a path that
   * is off unless an operator asked for it.
   */
  private exportDecisionRecords(
    evaluator: LayeredPolicyEvaluator,
    mode: PermissionConfigSnapshot['permissions']['mode'],
  ): void {
    const config = this.configReader.getDecisionOtlpConfig?.();
    if (!config?.enabled || !config.endpoint.trim()) return;
    void exportDecisions(evaluator.log.query(), config, { mode: mode ?? 'prompt' })
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
    const current = this.policyDecisionOwners.get(decision);
    if (!current) throw new Error('Policy decision has no current owner');
    current();
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
