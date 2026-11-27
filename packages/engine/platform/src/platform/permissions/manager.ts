import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { isDeepStrictEqual } from 'node:util';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { decisionModelPolicyState } from '@goodvibes/engine/errors';
import { decisionOrClassic, rememberDecisionRefusal, wasDecisionRefused, type RefusedDecisionAction } from '../runtime/decision-policy.js';
import { readExternalRequestEvidence, type ExternalRequestEvidence } from './external-request-evidence.js';
import { JudgmentError, type EntryType, type JudgmentPort } from '@goodvibes/judgment';
import { judgmentPort } from '@goodvibes/engine/errors';
import { captureOwnedJson, captureJsonEntry } from '../gate/judgment-input.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { conversationExposedNow, exposureWordsNow } from '../security/conversation-exposure.js';
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

import { effectivePermissionMode, normalizePermissionMode, presetForMode, type GatePreset, type GatePresetName } from '../gate/presets.js';
import { describePermissionModeInForce, permissionDecisionModelReady, type PermissionModeInForce } from './decision-model-readiness.js';
import { judgmentInputBoundary, runBoundary, type BoundaryCheckName } from '../gate/boundary.js';
import { readToolCall, shellCommandsIn } from '../gate/reading.js';
import { currentExecutionMode, currentExecutionModeForReadDecision, currentExecutionModeOwner, isInvocationAdmitted, withExecutionMode, type ExecutionModeOwner } from '../gate/execution-context.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { currentTurnAuthoritySurface } from '../security/turn-boundary.js';
import { inDirectCall, turnInputParty } from '../security/turn-input-party.js';
import { channelWithoutProjectRefusalFor } from '../channels/channel-project.js';
import { effectPermittedForProvenance } from '../gate/surface-authority.js';
import { isStateMutation } from '../gate/policy/state-policy.js';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { ProductReachProbe } from '../gate/product-commands.js';
import { hostname } from 'node:os';
import { hostSandboxAvailability, sandboxNotWorkingSentence } from '../tools/exec/sandbox.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { buildDurableRuleForDecision, buildRememberOptions, compileRules, sessionApprovalKey, type CompiledRules, type RememberTier } from './approval-rules.js';
import { undoFactOf } from './ask-consequence.js';
import { canonicalJson } from '../utils/target-ref.js';
import { callCommands, callRecipients, changesMcpTrust, classifyCall, classifyPaths, declaredRecoverable, declaredValues, hostDecidesCall, ownerOnlyReason, ownerActAsked, ownerActOnce, ownerActWordsOf, ownerOnlyCause, ownerOnlyWords, outsideAskBecause, reachesProductPastGate, recognizeOwnerOnly, outsideFolderCall, runsLaterCall, RUNS_LATER_FROM_READ_BECAUSE, sendsOrSpendsCall, SENDS_FROM_READ_BECAUSE, EXPOSED_ASKED_KINDS, type CallClass, type CallFacts, type CallRuleFact, type OwnerOnlyKind } from '../gate/classify.js';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../config/goodvibes-home.js';
import { OWNER_ADDRESS_CONFIG_KEYS, splitRecipients } from '../security/owner-identity.js';
import { isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { resolveNotificationWebhookLocally } from '../integrations/notification-webhooks.js';
import type { SecretsManager } from '../config/secrets.js';
import { undeclaredSendRecipients } from '../gate/send-recipients.js';
import { callShellTexts, neverRunMatchIn, parseNeverRunPattern, type CallShellTexts, type NeverRunMatch, type NeverRunPattern } from '../gate/never-run.js';
import { toolDecisionOf } from './denial.js';
import { processHeldForOwner, type HeldForOwnerCall, type HeldForOwnerLedger } from './held-for-owner.js';
import { runAnswersEveryQuestion, runHoldsForOwner } from './run-answerer.js';
import { MODEL_CHOICE_REASON, MODEL_PRICE_CHANGE_MODE, callActWords } from './ask-presentation.js';
import { processJevDecisions, type JevDecisionLedger, type JevDecisionRuleEffect } from './jev-decisions.js';
import { callOnlyTightens, callWritesOwnWorkingState, readModeCategory, toolCategoryOf, type ToolDecision, type ToolDefinition } from '../types/tools.js';
import { projectIdentity, type CompiledProjectRules, type UserPermissionRuleStore } from './user-rule-store.js';
import { projectOfDecision, projectRootOfDirectory } from './call-project.js';
import { projectLayerSetting, projectSettingsInForce } from '../config/project-view.js';
import type { CapabilityCommandsResolver } from './capability-commands.js';
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

/**
 * Owned fields from the already captured autonomous authority frame. The rule
 * lists are not copied into it: the frame holds their publication revisions,
 * which the admission's check compares, and the rules are matched from their
 * owners' compiled lists.
 */
interface AutonomousPermissionOwner {
  readonly directory: string | null;
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
  /** The call acts on what the daemon holds, in no project folder (hostDecides, outsideFolder): the folder's trust is not asked. */
  readonly outsideFolder?: boolean | undefined;
  /** The owner confirmed this exact call in person; their confirmation is the approval. */
  readonly ownerConfirmed?: boolean | undefined;
  /** Where the call sends as the owner (callRecipients): an answer to a new recipient covers these for the session. */
  readonly recipients?: readonly string[] | undefined;
  /** The host alternatives (revise) and resume conditions (defer) defined for this call, offered to Jev. */
  readonly choices?: AutonomousToolChoices | undefined;
}

/**
 * What the acting model is told when Jev did not let a call run: the outcome, and the
 * safety reading it rests on (the facts that reading found true), so the model can change course.
 */
function jevDecisionDetail(outcome: string, reading: Awaited<ReturnType<typeof readToolCall>> | undefined): string {
  const facts = reading === undefined ? [] : [
    reading.irreversible ? 'it cannot be undone' : '',
    reading.weakensSecurity ? 'it weakens a security protection' : '',
    reading.secrets ? 'it handles secrets' : '',
    reading.outward ? 'it sends something off this machine' : '',
    reading.beyondProject ? 'it reaches outside the project folder' : '',
    reading.obfuscated ? 'its command is obscured' : '',
    reading.uncertain.length > 0 ? `it could not be settled with confidence (${reading.uncertain.join(', ')})` : '',
  ].filter(Boolean);
  const because = facts.length > 0 ? `the safety reading found that ${facts.join(', ')}${reading?.stakes ? ` (stakes: ${reading.stakes})` : ''}`
    : reading?.stakes ? `the safety reading put its stakes at ${reading.stakes}` : 'no safety reading was available';
  if (outcome === 'act') return `Jev allowed it: ${because}.`;
  if (outcome === 'revise') return `Jev chose a narrower alternative instead of this call, because ${because}.`;
  if (outcome === 'defer') return `Jev's reason: ${because}. It may run once its condition changes.`;
  return `Jev's reason: ${because}. A narrower call that avoids this may be allowed.`;
}

/**
 * Who is asking and from where, as the permission decision is given it: the surface the instruction came from, the
 * caller outside the daemon's own programs (a paired device, a member, the outside agent, a script with the token, a
 * typed command) by the name the daemon authenticated, the project, and whether the conversation has read text from
 * outside and where. Facts for the decision; none of them asks anyone.
 */
function decisionProvenance(surface: string | undefined, attribution: PermissionAttribution | undefined, workingDirectory: string | undefined): Record<string, string> {
  const readOutside = exposureWordsNow() ?? (conversationExposedNow() ? 'this conversation has read text from outside' : undefined);
  return {
    surface: surface ?? 'owner-direct',
    caller: attribution?.kind === 'outside-caller' ? attribution.name : surface === undefined ? 'your own model, in your own conversation' : `a sender on ${surface}`,
    ...(workingDirectory ? { project: workingDirectory } : {}),
    ...(readOutside ? { readOutside } : {}),
  };
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
  /** What made it the owner's, in words, when the kind's plain words would name another cause (classify.ts `ownerOnlyCause`). */
  readonly ownerOnlyBecause?: string | undefined;
  readonly directory: string | null;
  /** What the decision's one rule lookup found (ruleFactOf). */
  readonly rule: CallRuleFact | undefined;
  readonly untrustedRead: boolean;
  /** The registry's prepared call was declared read-only by its tool's own projection. */
  readonly declaredReadOnly?: boolean | undefined;
  /** The act a door runs as already decided for its caller (`ToolRegistry.executeOwnerConfirmed`). */
  readonly ownerConfirmed?: boolean | undefined;
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
  /** Set when the answer was the owner's to an item only the owner decides. */
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

/** A manager with no rule store matches no saved rule. */
const NO_RULES: CompiledProjectRules & { readonly revision: number } = Object.freeze({
  committed: [], remembered: [], lookup: compileRules([]), revision: 0,
});

/** The owner's hand-written mode-constraint rules in a compiled list, found once per list. */
const modeConstraintsOf = new WeakMap<CompiledRules, readonly PolicyRule[]>();
function userModeConstraints(lookup: CompiledRules): readonly PolicyRule[] {
  let found = modeConstraintsOf.get(lookup);
  if (!found) {
    found = Object.freeze(lookup.rules.filter((rule) => rule.type === 'mode-constraint'));
    modeConstraintsOf.set(lookup, found);
  }
  return found;
}

/** The owner's never-run rules in a compiled list, parsed once per list. */
const neverRunOf = new WeakMap<CompiledRules, readonly NeverRunPattern[]>();
function neverRunPatterns(lookup: CompiledRules): readonly NeverRunPattern[] {
  let found = neverRunOf.get(lookup);
  if (!found) {
    found = Object.freeze(lookup.rules.flatMap((rule) => rule.type === 'never-run' && rule.effect === 'deny'
      ? rule.commands.map(parseNeverRunPattern).filter((pattern): pattern is NeverRunPattern => pattern !== undefined) : []));
    neverRunOf.set(lookup, found);
  }
  return found;
}

/**
 * A call the owner's own rule outside the gate asks about (a `Pre:tool` hook's
 * `ask`, an `ask-on-risk` MCP server called outside its scope) is the owner's to
 * decide, in every mode: it is put to them as their standing "ask me" (held for
 * them in just-vibes). A refusal still stands; nothing else settles it.
 */
/**
 * The GoodVibes home directories as this process resolves them (`<home>/.goodvibes` and the daemon's home), handed to
 * the classifier as a fact (gate/product-commands.ts reads no environment). Read per call: a test or a run may point
 * the home elsewhere while the process lives; two path resolutions, no I/O.
 */
function productHomeDirectories(): readonly string[] {
  try {
    const root = resolveGoodVibesHome();
    return [resolve(root, '.goodvibes'), resolve(resolveGoodVibesDaemonHome(root)), ...installedProductFiles()];
  } catch {
    return [];
  }
}

let installedFilesCache: readonly string[] | undefined;

/**
 * The installed product's own files, when this process runs from the installed product: its programs beside it
 * (`goodvibes`, `goodvibes-agent`, `goodvibes-daemon`) with their runtimes and the hashes the installer recorded for
 * them (`<name>.readers.json`, `daemon-installation.json`, which the daemon reads to know its programs), their kept and
 * incoming copies, and the library folder the daemon loads. A model's command or write naming one is asked each time,
 * in every mode: whoever writes these is the owner to any software on this account (docs/llms/40). Named file by
 * file, so the folder's other programs (`~/.local/bin` holds the person's own) are not touched. None from source.
 */
function installedProductFiles(): readonly string[] {
  if (installedFilesCache) return installedFilesCache;
  let exe: string;
  try { exe = realpathSync(process.execPath); } catch { exe = process.execPath; }
  const name = basenameOf(exe).replace(/\.exe$/, '');
  if (!['goodvibes', 'goodvibes-agent', 'goodvibes-daemon'].includes(name)) {
    installedFilesCache = [];
    return installedFilesCache;
  }
  const folder = resolve(exe, '..');
  const files: string[] = [];
  for (const base of ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']) {
    for (const suffix of ['', '.exe', '.bun', '.bun.json', '.bun.LICENSE.md', '.readers.json']) {
      for (const kept of ['', '.previous', '.incoming']) files.push(resolve(folder, `${base}${suffix}${kept}`));
    }
  }
  for (const kept of ['', '.previous', '.incoming']) files.push(resolve(folder, `daemon-installation.json${kept}`));
  files.push(resolve(folder, 'lib', `sqlite-vec-${process.platform}-${process.arch}`));
  installedFilesCache = files;
  return files;
}

/** Where a path really is: its real path, or its nearest existing folder's real path with the rest after it. */
function realPathOfPath(path: string): string {
  const rest: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try { return resolve(realpathSync(existing), ...rest.reverse()); } catch {
      const parent = resolve(existing, '..');
      if (parent === existing) return resolve(path);
      rest.push(basenameOf(existing));
      existing = parent;
    }
  }
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The most of a script file the classifier reads: a larger file is not known not to reach, so it counts. */
const PROBE_SCRIPT_BYTES = 256 * 1024;

/**
 * How the classifier may resolve a command's words (gate/product-commands.ts): links followed, a script file read
 * (bounded; one that cannot be read, or is larger, counts as reaching), the person's home. Read per call.
 */
function productReachProbe(sandboxSetting?: unknown): ProductReachProbe {
  return {
    realPath: realPathOfPath,
    readText: (path) => {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > PROBE_SCRIPT_BYTES) return undefined;
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    ...(process.env['HOME'] ? { home: process.env['HOME'] } : {}),
    hostNames: [hostname()],
    // The model's commands run inside a working sandbox only with the switch on and the host able to give one (the one
    // reading the exec tool makes, tools/exec/sandbox.ts); otherwise code the classifier cannot resolve counts.
    sandboxed: sandboxSetting === true && hostSandboxAvailability().available,
  };
}

/** The folders on this process's program search path. */
function searchPathFolders(): readonly string[] {
  return (process.env['PATH'] ?? '').split(delimiter).filter((folder) => isAbsolute(folder));
}

/**
 * A call something outside the permission rules asks the owner about (`ownerAsk`: a tool server set to ask before a
 * call outside its limits, their Pre:tool hook): put to them, with that as why, never as "your rule says to ask you".
 * As released it is the owner's own standing "ask me", in every mode (YOLO included; held for them in Just vibes): the
 * card offers the usual remember options. A refusal stands.
 */
function askedByOwnerRule(decided: CallClass, ownerAsk: string | undefined): CallClass {
  // As released: the owner's own rule outside the gate (a tool server's "ask on risk" level, their Pre:tool hook) puts the
  // call to them in every mode, YOLO included, as their standing "ask me" (held for them in just-vibes). A refusal stands.
  if (ownerAsk === undefined || (decided.kind === 'fact' && !decided.allow)) return decided;
  return decided.kind === 'owner-only' ? decided : { kind: 'owner-only', item: 'standing-ask', because: outsideAskBecause(ownerAsk) };
}

/**
 * Why something outside the gate asks the owner (a tool server's level, their hook), shown to them with the call: once. When it
 * is already the card's "Only you decide this" cause (askedByOwnerRule), it is not repeated among the reasons.
 */
function withOwnerAsk(analysis: PermissionRequestAnalysis, ownerAsk: string | undefined, decided: CallClass): PermissionRequestAnalysis {
  if (ownerAsk === undefined) return analysis;
  if (decided.kind === 'owner-only' && decided.because === outsideAskBecause(ownerAsk)) return analysis;
  return { ...analysis, reasons: [...analysis.reasons, ownerAsk] };
}

/** Managed policy's verdict: allowed or refused by a policy rule, or undefined when none decided the call. */
function managedVerdict(decision: LayeredPermissionDecision): boolean | undefined {
  return decision.sourceLayer === 'policy' ? decision.allowed : undefined;
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
 * The fields of the host source a decision was made for, taken when it is
 * captured (a host may change its source object in place): the goal, the
 * criteria, the transcript's length, and the last message and selected diff,
 * each kept as the value itself (its identity), a cheap size and, serialised
 * once here, its text.
 */
interface SourceFingerprint {
  readonly goal: unknown;
  readonly criteria: readonly unknown[] | undefined;
  readonly messages: number;
  readonly lastMessage: SourcePart;
  readonly diff: SourcePart;
}

/** One possibly large part of the source: the value as captured, its size, and its text serialised once at capture. */
interface SourcePart {
  readonly value: unknown;
  readonly size: number;
  readonly text: string | undefined;
}

/** A size read without walking the value: a string's or list's length, or an object's text content length and key count. */
function partSize(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return -1;
  const content = (value as { content?: unknown }).content;
  const contentSize = typeof content === 'string' || Array.isArray(content) ? content.length : -1;
  return contentSize * 1024 + Object.keys(value).length;
}

function capturePart(value: unknown): SourcePart {
  return { value, size: partSize(value), text: value === undefined ? undefined : JSON.stringify(value) };
}

/**
 * Whether a part is still the captured one. The same value (by identity) of
 * the same size is taken as unchanged without serialising it, so a check costs
 * the same for any message or diff size; only a host that hands a different
 * object is compared by its text.
 */
function samePart(now: unknown, then: SourcePart): boolean {
  if (now === then.value) return partSize(now) === then.size;
  return (now === undefined ? undefined : JSON.stringify(now)) === then.text;
}

function sourceParts(value: unknown): { readonly source: Partial<AutonomousToolSource>; readonly messages: readonly unknown[] | undefined } {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<AutonomousToolSource>;
  return { source, messages: Array.isArray(source.conversationContext) ? source.conversationContext : undefined };
}

/** Serialises the last message and the selected diff once, at capture; later checks use {@link sameSource}. */
function sourceFingerprint(value: unknown): SourceFingerprint {
  const { source, messages } = sourceParts(value);
  return {
    goal: source.goal,
    criteria: Array.isArray(source.criteria) ? [...source.criteria] : undefined,
    messages: messages?.length ?? -1,
    lastMessage: capturePart(messages && messages.length > 0 ? messages[messages.length - 1] : undefined),
    diff: capturePart(source.selectedDiffContext),
  };
}

/**
 * What a call's reading puts on the owner's own list, in every mode but yolo:
 * a confident reading that it loosens a security boundary, or that it
 * destroys something that cannot be brought back (a destructive command, or a
 * hard-to-undo change that stays on this machine). An uncertain fact stays a
 * judgment; Jev is shown it as uncertain.
 */
function ownerOnlyFromReading(reading: Pick<Awaited<ReturnType<typeof readToolCall>>,
  'weakensSecurity' | 'irreversible' | 'mutates' | 'outward' | 'family' | 'uncertain'>): OwnerOnlyKind | undefined {
  if (reading.weakensSecurity && !reading.uncertain.includes('weakensSecurity')) return 'loosen-security';
  if (reading.irreversible && !reading.uncertain.includes('irreversible')
    && (reading.family === 'shell-destructive' || (reading.mutates && !reading.outward))) return 'unrecoverable-delete';
  return undefined;
}

/**
 * Whether the host source now is the one a decision was made for: a field
 * compare against the captured fingerprint, never a copy or a schema parse of
 * the transcript, and no serialisation while the host keeps its objects.
 */
function sameSource(now: unknown, then: SourceFingerprint): boolean {
  const { source, messages } = sourceParts(now);
  const criteria = Array.isArray(source.criteria) ? source.criteria : undefined;
  return source.goal === then.goal && (messages?.length ?? -1) === then.messages
    && criteria?.length === then.criteria?.length
    && (criteria ?? []).every((criterion, index) => criterion === then.criteria?.[index])
    && samePart(messages && messages.length > 0 ? messages[messages.length - 1] : undefined, then.lastMessage)
    && samePart(source.selectedDiffContext, then.diff);
}

/**
 * A session answer to an owner-only item is kept apart, so only it settles that
 * item again, and it covers that exact call: the arguments are part of the key,
 * so trusting one MCP server does not trust another.
 */
function ownerOnlySessionKey(kind: OwnerOnlyKind, key: string, args: Record<string, unknown>): string {
  return `owner-only:${kind}|${key}|${canonicalJson(args)}`;
}

/**
 * The settings that name where the owner sends things to themselves: their mail addresses,
 * their notification webhooks and the default recipients their surfaces deliver
 * to. A recipient found here is the owner's own destination, not a new one.
 */
const OWNER_DESTINATION_KEYS: readonly string[] = [
  ...OWNER_ADDRESS_CONFIG_KEYS, 'notifications.webhookUrls', 'surfaces.googleChat.webhookUrl',
  'surfaces.signal.defaultRecipient', 'surfaces.whatsapp.defaultRecipient', 'surfaces.telephony.defaultRecipient',
];

/**
 * The recipients one value names, as they are compared: a URL whole and as
 * written; anything else split at commas into addresses, lowercased and
 * without a display name (security/owner-identity.ts).
 */
function recipientParts(value: string): string[] {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return [trimmed];
  return [...splitRecipients(trimmed)];
}

/** The reason code each boundary refusal is reported under (a judgment-input refusal has its own path). */
const BOUNDARY_REFUSAL_CODES: Readonly<Record<Exclude<BoundaryCheckName, 'judgment-input'>, PermissionDecisionReasonCode>> = {
  catastrophic: 'boundary_catastrophic',
  'surface-authority': 'boundary_surface_authority',
  'card-details': 'boundary_card_details',
  'outward-effect': 'boundary_outward_effect',
};

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
  } else if (toolName === 'capability_run' && (args.id === 'settings.set' || args.id === 'settings.reset')) {
    // The System settings capabilities (capabilities/builtin/system-settings.ts): the same direction rule, the new value
    // read as the capability reads its typed text (JSON, then true, false, a number, else the text); a reset puts the default.
    const inputs = args.inputs && typeof args.inputs === 'object' ? args.inputs as Record<string, unknown> : {};
    const key = typeof inputs.key === 'string' ? inputs.key.trim() : '';
    if (key) {
      const text = typeof inputs.value === 'string' ? inputs.value.trim() : '';
      const typed = (): unknown => {
        try { return JSON.parse(text) as unknown; } catch { return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text; }
      };
      writes.push({ key, next: args.id === 'settings.set' ? typed() : readDotPath(DEFAULT_CONFIG, key).value });
    }
  }
  return writes.some(({ key, next, ...rest }) => {
    const loosens = configKeyFacts(key).loosens;
    return loosens !== undefined && loosens('previous' in rest ? rest.previous : current(key), next);
  });
}

/**
 * A System settings change (`capability_run` settings.set / settings.reset) that only puts a protection back: moving
 * the setting from its current value to the new one does not loosen it, and the move back would (its own facts,
 * config-key-facts.ts `loosens`). It applies at once, as any act that only tightens a protection does.
 */
function settingsWriteOnlyTightens(toolName: string, args: Record<string, unknown>, current: (key: string) => unknown): boolean {
  if (toolName !== 'capability_run' || (args.id !== 'settings.set' && args.id !== 'settings.reset')) return false;
  const inputs = args.inputs && typeof args.inputs === 'object' ? args.inputs as Record<string, unknown> : {};
  const key = typeof inputs.key === 'string' ? inputs.key.trim() : '';
  const loosens = key ? configKeyFacts(key).loosens : undefined;
  if (!loosens) return false;
  let next: unknown;
  if (args.id === 'settings.reset') next = readDotPath(DEFAULT_CONFIG, key).value;
  else {
    const text = typeof inputs.value === 'string' ? inputs.value.trim() : '';
    try { next = JSON.parse(text) as unknown; } catch { next = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text; }
  }
  const now = current(key);
  return JSON.stringify(now) !== JSON.stringify(next) && !loosens(now, next) && loosens(next, now);
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
   * measured the gate's decisions on it (gate/calibration.ts). `chosen`: the
   * mode in force was chosen for this session (Shift+Tab, a hosted session's
   * mode), which counts as the owner's choice like a saved one. A set model
   * counts as working only while it answers; `assumeAnswering` takes it as
   * answering through a failure episode, for comparing modes across one
   * decision. Absent counts as ready.
   */
  isDecisionModelReady?(chosen?: boolean, assumeAnswering?: boolean): boolean;
  /** Why the mode in force differs from a chosen mode, read from the same settings (decision-model-readiness.ts). Absent: no reason is given. */
  describeModeInForce?(chosen: GatePresetName, explicitlyChosen: boolean): PermissionModeInForce;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
  /**
   * What the settings file of the project this decision is for sets for `key` itself (admitted: never looser than
   * the host's), when the decision is for a project other than the settings owner's own; undefined otherwise. A
   * session's chosen mode is held to it: the stricter of the two is in force.
   */
  projectLayerSetting?(key: string): unknown;
  /**
   * One setting's current value, for the loosening rule of a settings write
   * (undefined when unknown; the rule then reads the strictest baseline).
   */
  getSetting?(key: string): unknown;
  /**
   * The value a credential setting's `goodvibes://secrets/` reference stands
   * for, read from this machine's own secret store (no request), or null. The
   * owner's webhook destinations are kept as references, so the recipient
   * check reads what they name.
   */
  readStoredReference?(reference: string): string | null;
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
  secrets?: Pick<SecretsManager, 'resolveLocalSecretSync'> | null,
  /**
   * The project this reader's decisions are for when it is not the settings
   * owner's own folder: a session the daemon hosts in a project reads the
   * daemon's settings, and decides, keeps rules and resolves paths for its own
   * project. Absent: the settings owner's folder.
   */
  project?: string,
): PermissionConfigReader {
  const snapshotAccessor = configManager.getAutonomousPermissionSnapshot;
  const ownSnapshot = snapshotAccessor?.bind(configManager);
  // The settings in force for the project a decision is for (config/project-view.ts projectSettingsInForce: the
  // owner's settings with the project's own file over them, a protection only ever stricter), when that project is not
  // the settings owner's own: a terminal program's manager already holds its project's file, the daemon's holds none.
  // Where the project sets nothing, the owner's settings answer. One reader of them, the one the project's turns read.
  const fullManager = typeof (configManager as Partial<ConfigManager>).getCategory === 'function' ? configManager as ConfigManager : undefined;
  let ownProject: string | null | undefined;
  // One view per project, kept: a decision held over an owner's answer checks the same view at its claim, even when
  // decisions for other projects (another runner, another session) were made meanwhile.
  const views = new Map<string, ConfigManager | undefined>();
  const projectSettings = (): ConfigManager | undefined => {
    const decided = projectOfDecision() ?? project;
    if (!fullManager || decided === undefined) return undefined;
    if (views.has(decided)) return views.get(decided);
    if (ownProject === undefined) {
      const own = configManager.getWorkingDirectory();
      ownProject = own ? projectRootOfDirectory(own) : null;
    }
    const identity = projectRootOfDirectory(decided);
    // projectSettingsInForce keeps the one view of each project, so a folder dropped from this list finds the same view.
    const view = identity === ownProject ? undefined : projectSettingsInForce(fullManager, identity);
    views.set(decided, view);
    if (views.size > 64) views.delete(views.keys().next().value!);
    return view;
  };
  const settingsHere = () => projectSettings() ?? configManager;
  const permissionSnapshot = ownSnapshot
    ? () => {
      const own = ownSnapshot();
      const scoped = project !== undefined ? { ...own, directory: project } : own;
      const view = projectSettings();
      return view === undefined ? scoped : {
        ...scoped,
        permissions: structuredClone(view.getCategory('permissions')) as typeof own.permissions,
        autoApprove: view.get('behavior.autoApprove') === true,
      };
    }
    : undefined;
  const flushPendingChanges = configManager.flushConfigFileChanges?.bind(configManager);
  const reader: PermissionConfigReader = {
    ...(flushPendingChanges ? { flushPendingChanges } : {}),
    ...(permissionSnapshot ? { getAutonomousSnapshot: permissionSnapshot } : {}),
    isAutoApproveEnabled: () => isAutoApproveEnabled(settingsHere()),
    isDecisionModelReady: (chosen, assumeAnswering) => permissionDecisionModelReady(configManager,
      { ...(chosen === true ? { chosen: true } : {}), ...(assumeAnswering === true ? { assumeAnswering: true } : {}) }),
    describeModeInForce: (chosen, explicitlyChosen) => describePermissionModeInForce(settingsHere(), { chosen, explicitlyChosen }),
    getSnapshot: permissionSnapshot
      ? () => ({ permissions: permissionSnapshot().permissions })
      : () => getConfigSnapshot(settingsHere()),
    getWorkingDirectory: project !== undefined ? () => project : () => configManager.getWorkingDirectory(),
    projectLayerSetting: (key) => {
      const view = projectSettings();
      return view === undefined ? undefined : projectLayerSetting(view, key);
    },
    getSetting: (key) => {
      try { return settingsHere().get(key as ConfigKey); } catch { return undefined; }
    },
    ...(secrets ? { readStoredReference: (reference: string) => resolveNotificationWebhookLocally(reference, secrets) } : {}),
    // Read per decision, not captured: switching export on is a live change.
    getDecisionOtlpConfig: () => readDecisionOtlpConfig(configManager),
  };
  permissionConfigOwners.set(reader, configManager);
  const native = retainPermissionConfigurationOwner(configManager, snapshotAccessor);
  if (native && permissionSnapshot) {
    // The owner's one revision, and for a decision made for a project the project's own permission settings too: a
    // change to its file while a call is decided ends that decision as a change to the owner's settings does.
    const projectPermissions = (view: ConfigManager | undefined): string | undefined => view === undefined ? undefined
      : JSON.stringify([view.getCategory('permissions'), view.get('behavior.autoApprove')]);
    const owner: PermissionConfigurationOwner = Object.freeze({
      readMode: () => {
        const view = projectSettings();
        return view === undefined ? native.readMode() : { mode: view.get('permissions.mode'), autoApprove: view.get('behavior.autoApprove') === true };
      },
      captureRevision: () => {
        const unchanged = native.captureRevision();
        const view = projectSettings();
        const held = projectPermissions(view);
        return () => unchanged() && projectSettings() === view && projectPermissions(view) === held;
      },
    });
    nativePermissionConfigs.set(reader, { owner, snapshot: permissionSnapshot });
  }
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
  readonly workspaceTrust?: (Pick<import('../runtime/workspace-trust.js').WorkspaceTrustManager, 'prepareAutonomousConstraint'>
    & Partial<Pick<import('../runtime/workspace-trust.js').WorkspaceTrustManager, 'isRestricted'>>) | null | undefined;
  /**
   * The trust of another project's folder, for a decision made for that
   * project (permissions/call-project.ts): a daemon deciding for a turn in a
   * project reads that project's trust, never its own folder's. Absent: every
   * decision reads `workspaceTrust`.
   */
  readonly workspaceTrustFor?: ((projectRoot: string) => GateOptions['workspaceTrust']) | undefined;
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
   * The owner confirmed this exact call in person: a form they filled in and
   * answered yes to (`ToolRegistry.executeOwnerConfirmed`). A fact (a deny
   * rule, plan mode, a refused decision) still decides; nobody is asked again.
   */
  readonly ownerConfirmed?: boolean | undefined;
  /**
   * The session the call belongs to. Every remembered answer, owner-only key
   * and allowed recipient the admission reads or writes is kept under it, so
   * "allow for this session" holds in that session and nowhere else. Absent
   * for a call that belongs to no session.
   */
  readonly sessionId?: string | undefined;
}

interface AuthenticAutonomousAdmission {
  readonly issuer: PermissionManager;
  readonly registry?: ToolRegistry | undefined;
  readonly call?: PreparedToolCall | undefined;
  readonly claim: () => void;
  readonly assertCurrent: () => void;
  readonly assertWorkspace: () => void;
  readonly assertEffect: (effect: ToolExecutionEffect) => void;
  /** The owner approved this call in person on a channel request's card: it runs as the owner's own call (`isOwnerDirectedAdmission`). */
  readonly ownerDirected?: true | undefined;
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
const ownerDirectedGuards = new WeakSet<() => void>();

/** @internal Whether the consumed admission behind this call's guard was the owner's approval of a channel request, given in person. */
export function isOwnerDirectedAdmission(guard: (() => void) | undefined): boolean {
  return guard !== undefined && ownerDirectedGuards.has(guard);
}

/** @internal Original recorded source retained only by consumed execution guards. */
export interface AutonomousNestedOwner {
  readonly manager: PermissionManager;
  readonly source: AutonomousToolSource;
  readonly decoratePort: AutonomousPermissionOptions['decoratePort'];
  /** The session of the admitted call; a call it runs inside is admitted under the same session. */
  readonly sessionId: string | undefined;
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
  if (record.ownerDirected === true) ownerDirectedGuards.add(record.assertCurrent);
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

/** Files whose text steers a model in later conversations: instruction files, skills, agent definitions, VIBE files. */
const STEERING_FILE_NAMES = new Set(['agents.md', 'claude.md', 'goodvibes.md', 'vibe.md', 'hermes.md', '.hermes.md', '.cursorrules', 'skill.md', 'soul.md', 'system.md']);
function steersAModelPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return STEERING_FILE_NAMES.has(name) || /\/\.goodvibes\/(?:[^/]+\/)?(?:skills|agents)\//.test(normalized) || /\/\.cursor\/rules\//.test(normalized);
}

/** The session the permission decision being made is for, when its caller named one: an ask raised in it is that session's. */
export function sessionOfPermissionDecision(): string | undefined {
  return sessionOfCheck.getStore();
}

const OWNER_REVISION_CAPACITY = 10_000;
/**
 * Settled calls whose claim is still remembered so a replay of the same call is
 * refused. A source id is one (session, turn, call) tuple, so it can only be
 * presented again within its own turn; a claim is forgotten only after this many
 * LATER calls have settled, far more than any one turn can issue.
 */
const RETIRED_CLAIM_RETENTION = 4_096;

/** The tasks an agent call would start, in order, as the key the delegation check asks by; undefined for any other call. */
function delegatedTasks(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'agent') return undefined;
  if (args.mode === 'spawn' && typeof args.task === 'string') return JSON.stringify([args.task]);
  if (args.mode !== 'batch-spawn' || !Array.isArray(args.tasks)) return undefined;
  const tasks = args.tasks.map((entry: unknown) => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).task : undefined));
  return tasks.every((task): task is string => typeof task === 'string') ? JSON.stringify(tasks) : undefined;
}

export class PermissionManager {
  /** The commands a capability call runs in the project (capability-commands.ts); null: decided as the capability. */
  private capabilityCommands: CapabilityCommandsResolver | null = null;
  private readonly autonomousChoiceProjections = new AutonomousChoiceProjectionOwner();
  private readonly autonomousPending = new Set<string>();
  private readonly autonomousEpochs = new Map<string, number>();
  private readonly autonomousClaims = new Set<string>();
  /** The settings baseline of a source whose call the owner answered in person, taken when they answered (admitAutonomous). */
  private readonly ownerAnsweredRevisions = new Map<string, { readonly assertOwners: () => void; readonly assertSettings: () => void }>();
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
  /** Recipients the owner allowed for the rest of a session, keyed `<session>|<recipient>`. */
  private readonly allowedRecipients = new Set<string>();
  /**
   * The owner's answer to an agent call the gate put to them, keyed by its tasks,
   * until the delegation check of that call takes it (askDelegation): the owner is asked
   * about one delegation once, not by the gate and then again by the check.
   */
  private readonly answeredDelegations = new Map<string, { readonly approved: boolean; readonly reason?: string }>();
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
    // A guest's turn reads as the guest form of its surface: the guest is the turn's actor (turn-boundary.ts).
    this.gate = { surfaceOf: () => currentTurnAuthoritySurface(), ...gate };
  }

  /** Settle the existing rule/config owners before taking a new authority snapshot. */
  async prepareAutonomousOwner(signal?: AbortSignal): Promise<void> {
    assertPermissionActive(signal);
    const owner = this.userRuleStore;
    // Production stores distinguish load failure from their legacy empty-rule
    // fallback. Older embedding stores retain their existing init contract.
    // Yolo consults no remembered rule but does keep the owner's never-run
    // rules, so the file is read in every mode and an unreadable one refuses.
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
    // Another process's rule write is taken in first (committedRevision), so the publication is current.
    const rulePublication = this.userRuleStore?.committedRevision?.() ?? this.userRuleStore?.getPublicationRevision?.() ?? 0;
    const policyPublication = this.policyRuntimeState.getRegistry().getPublicationRevision?.() ?? 0;
    const policyEnabled = this.featureFlags?.isEnabled('permissions-policy-engine') === true;
    const ledger = this.gate.ledger ?? getProcessUntrustedContentLedger();
    const exposure = ledger.ingestedThisTurn();
    const coverage = ledger.captureTaintEvidence('turn');
    const scope = this.configReader.getAutonomousSnapshot?.();
    if (!scope) throw new Error('Autonomous execution requires a coherent permission owner snapshot');
    assertAutonomousData(scope);
    const executionOwner = currentExecutionModeOwner();
    // The frame is compared whole across one call's projection and admission, so it holds the mode
    // a decision-model failure cannot move; the decision applies the failure itself (failureAware).
    const mode = this.steady(() => executionOwner ? this.ownerMode(executionOwner)
      : effectivePermissionMode(scope.permissions.mode, scope.autoApprove, this.decisionModelWorks()));
    // The folder of the project this decision is for (call-project.ts), else the settings owner's.
    const frame = { ...scope, directory: projectOfDecision() ?? scope.directory, permissions: { ...scope.permissions, mode }, autoApprove: false,
      executionOwnerRevision: executionOwner?.getRevision(), source, surface, rulePublication, policyPublication, policyEnabled,
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
   * fields; the source's last message and selected diff are serialised once at
   * capture and, while the host keeps those objects, never again, so a check
   * costs the same with 0 or 500 remembered rules and any transcript or diff size.
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
    // The settings owner's folder (a workspace move changes it); the project a decision is for is held by its frame.
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
    this.ownerAnsweredRevisions.delete(sourceId);
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
      // Once the owner answered this source's call in person, the settings in force when they answered are the ones held to.
      const held = this.ownerAnsweredRevisions.get(sourceId) ?? revisions;
      held.assertOwners(); held.assertSettings();
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
      // One key space for the whole decision: rule facts, remembered answers,
      // queued asks, owner-only keys and recipients all read the call's session.
      return await sessionOfCheck.run(options.sessionId, () => this.decideAutonomous(sourceId, toolName, preparedArgs, options, epoch));
    }
    finally { this.autonomousPending.delete(sourceId); }
  }

  private async autonomousWorkspaceConstraint(category: PermissionCategory, signal?: AbortSignal): Promise<() => void> {
    if (!Object.prototype.hasOwnProperty.call(this.gate, 'workspaceTrust')) return () => {};
    // The trust of the project this decision is for (call-project.ts), read once: a check made later reads the same owner.
    const resolver = projectOfDecision() !== undefined ? this.gate.workspaceTrustFor : undefined;
    const owner = this.trustHere();
    const prepare = owner?.prepareAutonomousConstraint;
    if (owner === undefined && category !== 'read') throw new Error('Autonomous execution requires an explicit workspace trust capability');
    if (owner != null && typeof prepare !== 'function') throw new Error('Workspace trust capability cannot enforce current policy');
    const guard = await prepare?.call(owner, category, signal);
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if ((resolver !== undefined ? this.gate.workspaceTrustFor !== resolver : this.gate.workspaceTrust !== owner)
        || owner?.prepareAutonomousConstraint !== prepare) throw new Error('Workspace trust capability changed');
      assertProjectionCurrent(guard);
    };
    assertCurrent();
    return assertCurrent;
  }

  private async decideAutonomous(sourceId: string, toolName: string, preparedArgs: Record<string, unknown>, options: AutonomousPermissionOptions, epoch: number): Promise<AutonomousPermissionAdmission> {
    const signal = options.signal;
    assertPermissionActive(signal);
    let args = captureOwnedJson(preparedArgs) as Record<string, unknown>;
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
    let definition = preparedCall?.registry.readPreparedDefinition(preparedCall.call);
    // A model's code.test or worktree.setup is decided as the commands it runs (useCapabilityCommands): the exec
    // classifier, rules and mode decide it, once; the call that runs stays the one prepared.
    const asCommands = await this.capabilityCommandsOf(toolName, args, signal);
    if (asCommands !== undefined) { toolName = 'exec'; args = { commands: asCommands }; definition = undefined; }
    const category = admissionEvidence?.kind === 'agent-settings' ? 'write'
      : asCommands === undefined && preparedCall?.registry.isPreparedReadOnly(preparedCall.call) ? 'read' : this.getCategory(toolName, args, definition);
    // A call the daemon it is sent to decides (`hostDecides`), or one that acts on what the daemon holds
    // (`outsideFolder`: a daemon capability), does not act in this folder: its trust does not hold it.
    const assertWorkspace = await this.autonomousWorkspaceConstraint(hostDecidesCall(args, definition) || outsideFolderCall(args, definition) ? 'read' : category, signal);
    const settingsMutation = preparedCall?.registry.readPreparedSettingsMutation(preparedCall.call);
    // The one deep capture: what the decision reads and records. Currentness
    // afterwards is the owners' revisions, compared as integers.
    const rawAuthority = this.autonomousAuthority(sourceId, sourceOf);
    let revisions = this.authorityRevisions(sourceOf);
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
    const projectedAsk = projectionProperty(options, 'ownerAsk');
    const ownerAsk = typeof projectedAsk === 'string' ? projectedAsk : undefined;
    const baseAnalysis = analyzePermissionRequest(toolName, args, category);
    this.policyRuntimeState.recordPermissionRequest({ callId: sourceId, tool: toolName, category, analysis: withOwnerAsk(baseAnalysis, ownerAsk, { kind: 'judgment' }), project: this.directoryHere() ?? undefined });
    const permissions = capturedAuthority.permissions;
    // The frame holds the mode in force with the model taken as answering (owner choice and calibration applied).
    const mode = this.failureAware(effectivePermissionMode(permissions?.mode, capturedAuthority.autoApprove === true));
    const preset = presetForMode(mode);
    // Plan mode's read-only effect guard restricts the model, not the person: an act the owner confirmed in person writes.
    const effectReadOnly = preset.readOnly && options.ownerConfirmed !== true;
    // Plan mode admits a call whose category is a read (gate/classify.ts): its own request out (a `fetch` reads a page
    // with one GET, its effect `send`) is that read, never a change, so the guard holds only what writes. Before, plan mode
    // admitted the fetch and its guard then held it, answering "Tool input projection held" for a read the mode allows.
    const sendIsTheRead = category === 'read';
    const effectSurface = capturedAuthority.surface;
    const effectWriteDenied = mode !== 'yolo' && permissions.tools?.write === 'deny';
    const owner = { frame: capturedAuthority, assertCurrent };
    // The owner's never-run rules decide first, in every mode: nothing below may run what they forbid.
    const neverRun = await this.neverRunMatch(callShellTexts(toolName, args, definition), capturedAuthority.directory ?? undefined, signal);
    if (neverRun) {
      const refused = this.neverRunResult(neverRun, withOwnerAsk(baseAnalysis, ownerAsk, { kind: 'judgment' }));
      this.policyRuntimeState.recordPermissionDecision({ callId: sourceId, tool: toolName, category, result: refused, project: this.directoryHere() ?? undefined });
      assertCurrent();
      return Object.freeze({ result: refused, revisionIds: Object.freeze([]), claim: () => { throw new Error('Owner policy denied this tool call'); } });
    }
    const ownerFacts = this.ownerOnlyFacts(toolName, args, definition, category, capturedAuthority.directory ?? undefined, admissionEvidence);
    const cause = ownerOnlyCause(toolName, args, definition, ownerFacts, capturedAuthority.directory ?? undefined);
    const ownerOnly = cause?.kind;
    const rule = await this.ruleFactOf({
      toolName, args, category, mode, tools: permissions.tools, ownerOnly, subjects: callSubjects(args, definition),
      policyEnabled: capturedAuthority.policyEnabled, options: { signal, assertCurrent }, owner,
    });
    const exposure = (rawAuthority as Readonly<Record<string, unknown>>)['exposure'];
    const decided = askedByOwnerRule(classifyCall(mode, this.callFacts({
      toolName, args, category, mode, surface: effectSurface, definition, ownerOnly, ownerOnlyBecause: cause?.because,
      directory: capturedAuthority.directory, rule,
      // A turn whose reads were evicted before they could be checked still read something untrusted.
      // Or any earlier turn of this conversation did: what a conversation read stays read (security/conversation-exposure.ts).
      untrustedRead: (Array.isArray(exposure) && exposure.length > 0)
        || (rawAuthority as { readonly exposureCoverage?: { readonly complete?: unknown } }).exposureCoverage?.complete === false
        || conversationExposedNow(),
      declaredReadOnly: asCommands === undefined && preparedCall?.registry.isPreparedReadOnly(preparedCall.call) === true,
      ...(options.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    })), ownerAsk);
    const analysis = withOwnerAsk(baseAnalysis, ownerAsk, decided);
    const policyResult = this.policyResultOf(decided, analysis);
    const safety = await this.assessExecutionSafety({
      callId: sourceId, toolName, args, category, policyResult, decided, mode, signal, assertCurrent,
      workingDirectory: capturedAuthority.directory ?? undefined, source,
      sourceId, actionRevision: `action-${epoch.toString(36)}`, authorityRevision, authoritySnapshot,
      supportingIds: options.preparationDecisionIds ?? [], decoratePort: options.decoratePort, recipients: ownerFacts.recipients,
      outsideFolder: hostDecidesCall(args, definition) || outsideFolderCall(args, definition),
      choices: capturedAuthority.autonomousChoices,
      ...(options.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    });
    // The owner's yes is to the call as they saw it, under the rules then: a rule put in force while the question waited that
    // refuses it (a never-run rule, a deny rule, the tool set to refuse) still refuses it.
    const answeredYes = safety.result.approved && safety.result.sourceLayer === 'user_prompt';
    const result = (answeredYes ? await this.refusedSinceAsked({ toolName, args, definition, category, mode, ownerOnly,
      directory: capturedAuthority.directory ?? undefined, analysis, signal }) : undefined) ?? safety.result;
    // The owner answered this call in person: a question waits as long as they take, and a setting written meanwhile (a
    // call they approved elsewhere, a change made anywhere) is not a reason to fail their answer. Their answer is the decision;
    // the settings it holds against from here on are the ones in force when they gave it.
    if (result.sourceLayer === 'user_prompt') {
      revisions = this.authorityRevisions(sourceOf);
      this.ownerAnsweredRevisions.set(sourceId, revisions);
    }
    // The owner answered a channel's request in person: their approval is the authority the channel lacked.
    const ownerDirected = decided.kind === 'owner-only' && decided.item === 'channel-request' && result.approved && result.sourceLayer === 'user_prompt';
    this.policyRuntimeState.recordPermissionDecision({ callId: sourceId, tool: toolName, category, result, project: this.directoryHere() ?? undefined });
    this.noteJevDecision(toolName, args, category, result);
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
        ...(ownerDirected ? { ownerDirected: true as const } : {}),
        nestedOwner: Object.freeze({ manager: this, source, decoratePort: options.decoratePort, sessionId: options.sessionId }),
        assertEffect: effect => {
          if ((effect !== 'write' && effect !== 'send') || (effectReadOnly && !(effect === 'send' && sendIsTheRead)) || effectWriteDenied
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
    // As released: a set model that fails under Decision Model Only refuses this one call; otherwise (Hybrid, or no
    // model set) the classic path decides.
    }, (failure) => failure !== undefined && decisionModelPolicyState().policy === 'Decision Model Only'
      ? this.refusedWithoutDecision(input, failure)
      : this.assessClassicExecutionSafety(input));
  }

  /**
   * Under Decision Model Only the owner chose that a call the decision model
   * could not decide is not asked about or held: this one call is refused,
   * saying why, and the turn goes on.
   */
  private refusedWithoutDecision(input: SafetyInput, failure: unknown): SafetyOutcome {
    input.assertCurrent();
    const why = failure instanceof Error ? failure.message : String(failure);
    return { result: this.result(false, false, 'safety_check', 'jev_defer', input.policyResult.analysis, {
      detail: `Not run: the decision model could not decide this call (${why}), and "When the decision model is missing or fails" is set to Decision Model Only. Fix the decision model, or choose Hybrid for "When the decision model is missing or fails" in the decision model settings to have such calls decided without it.` }) };
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
    const because = input.decided.kind === 'owner-only' ? input.decided.because : undefined;
    if (ownerOnly === undefined) {
      const tools = this.configReader.getSnapshot().permissions.tools;
      const toolConfigKey = TOOL_CONFIG_KEYS[input.toolName];
      const configured = toolConfigKey === undefined ? undefined : tools?.[toolConfigKey];
      if (configured === 'allow' || input.category === 'read' && configured !== 'prompt') {
        input.assertCurrent();
        return { result: this.result(true, false, 'config_policy', 'config_allow', analysis,
          { detail: 'No decision model: authorized by owner configuration and deterministic tool category; no semantic safety reading.' }) };
      }
    }
    if (this.takeOwnerRevision(input)) return { result: this.result(true, false, 'user_prompt', 'user_approved', analysis) };
    if (input.ownerConfirmed === true) return this.ownerConfirmedOutcome(input);
    // just-vibes interrupts no one: with no decision model to answer, what needs the owner is held for the end of the run
    // (as released). Jev decides reaches here as Ask me (effectivePermissionMode) and asks below.
    if (input.mode === 'just-vibes') {
      const approvedOnce = this.heldOnceApproved(input);
      if (approvedOnce) return approvedOnce;
      return this.queuedForOwner(input, analysis,
        ownerOnly ? `held for you: ${ownerOnlyWords(ownerOnly, because)}` : 'held for you: this needs a decision and no decision model can answer', ownerOnly);
    }
    return this.askOwner(input, analysis, {
      reasons: ownerOnly ? [`Only you decide this: ${ownerOnlyWords(ownerOnly, because)}.`] : [],
      ownerOnly, ownerOnlyBecause: because, revisedDetail: 'Prepare the exact action revised and approved by the owner without a decision model.',
      ...(input.decided.kind === 'owner-only' && input.decided.once === true ? { single: true } : {}),
    });
  }

  /**
   * just-vibes held an owner-only call that is answered each time (what runs later, made after the turn read text anyone
   * can write; a card's detail), and the owner approved that exact held call: good once, for the same call made again
   * (as the boundary's held send is). Never remembered past that one call. Without this the owner's yes could never take effect:
   * such a call reads no session answer, so it was held again each time it was made.
   */
  private heldOnceApproved(input: SafetyInput): SafetyOutcome | undefined {
    const decided = input.decided;
    if (decided.kind !== 'owner-only' || decided.once !== true) return undefined;
    const heldKey = ownerOnlySessionKey(decided.item, this.getApprovalKey(input.toolName, input.args), input.args);
    if (this.sessionApprovals.get(heldKey) !== true) return undefined;
    this.sessionApprovals.delete(heldKey);
    this.sessionApprovalRevision++;
    return { result: this.result(true, false, 'user_prompt', 'user_approved', input.policyResult.analysis,
      { detail: 'The owner approved this exact call after just-vibes held it; good for this one call.' }) };
  }

  /** A call the owner confirmed in person in a form: their yes is the approval, recorded as theirs. */
  private ownerConfirmedOutcome(input: SafetyInput): SafetyOutcome {
    input.assertCurrent();
    return { result: this.result(true, false, 'user_prompt', 'user_approved', input.policyResult.analysis,
      { detail: 'The owner confirmed this exact action in a form they filled in.' }) };
  }

  /**
   * An ask a layer below the gate settled without the owner (the exec sandbox
   * ran the command inside its boundary): recorded as that layer's decision,
   * never as the owner's, and only for an ask the gate offered it. Nothing is
   * remembered from it.
   */
  private settledBelow(input: SafetyInput, analysis: PermissionRequestAnalysis, reply: PermissionPromptDecision,
    offered: boolean, boundary: GateBoundaryRecord | undefined): PermissionCheckResult {
    const extra = boundary ? { boundary } : {};
    if (!offered) {
      return this.result(false, false, 'safety_check', 'safety_guardrail', analysis, { ...extra,
        detail: `The ${reply.settledBy} layer answered an ask only the owner answers, so nothing ran; ask again for the owner's answer.` });
    }
    if (!reply.approved) {
      return this.result(false, false, 'stakes_preset', 'preset_deny', analysis, { ...extra, preset: { preset: input.mode, action: 'deny' },
        detail: reply.reason ?? `The ${reply.settledBy} layer refused this call.` });
    }
    return this.result(true, false, 'stakes_preset', 'preset_allow', analysis, { ...extra, preset: { preset: input.mode, action: 'allow' },
      detail: 'Not asked: the command runs inside the exec sandbox (workspace writable, no network, no host privilege), '
        + 'which contains what this call would otherwise be asked about. The owner did not answer it.' });
  }

  /**
   * Ask the owner about one call and keep what they asked to be remembered. An
   * answer to an owner-only item is remembered as covering that item, so the owner is
   * asked once. Revised arguments become a revision the caller prepares again.
   */
  private async askOwner(input: SafetyInput, analysis: PermissionRequestAnalysis, o: {
    readonly reasons: readonly string[];
    readonly ownerOnly?: OwnerOnlyKind | undefined;
    /** What really made it the owner's, in words (the card says it instead of the kind's plain words). */
    readonly ownerOnlyBecause?: string | undefined;
    readonly boundary?: GateBoundaryRecord | undefined;
    readonly preset?: GatePresetRecord | undefined;
    readonly revisedDetail: string;
    /** Asked only for what a real containment boundary answers: a layer running the call inside one may settle it. */
    readonly containable?: boolean | undefined;
    /** The answer covers this one call only: nothing is offered to remember. */
    readonly single?: boolean | undefined;
  }): Promise<SafetyOutcome> {
    // A channel's request is approved one call at a time: no remembered answer can stand in for the owner there.
    // What code or a confident reading says cannot be undone is asked about every time: an answer to it is never kept.
    const rememberOptions = o.ownerOnly === 'channel-request' || o.single === true
      || undoFactOf(input.toolName, input.args, analysis.reading, o.ownerOnly, input.workingDirectory).cannotUndo
      ? [] : buildRememberOptions(input.toolName, input.args, this.rememberedRulesHere());
    // A command asked about while the sandbox is switched on but cannot start runs on this computer on a yes: the
    // question says so, and why it could not start, first (tools/exec/sandbox.ts hostSandboxAvailability).
    const unsandboxed = input.category === 'execute' || input.toolName === 'exec' ? sandboxNotWorkingSentence(this.configReader.getSetting?.('sandbox.enabled')) : undefined;
    const asked = await awaitPermission(() => this.requestPermission({
      callId: input.callId, tool: input.toolName, args: input.args, category: input.category,
      analysis: { ...analysis, ...(unsandboxed ? { summary: `${unsandboxed} ${analysis.summary}` } : {}),
        reasons: [...(unsandboxed ? [unsandboxed] : []), ...analysis.reasons, ...o.reasons] },
      workingDirectory: input.workingDirectory,
      ...(input.attribution ? { attribution: input.attribution } : {}),
      rememberOptions,
      ...(o.ownerOnly ? { ownerOnly: o.ownerOnly } : {}),
      ...(o.ownerOnly && o.ownerOnlyBecause !== undefined ? { ownerOnlyBecause: o.ownerOnlyBecause } : {}),
      ...(o.containable === true && o.ownerOnly === undefined ? { containable: true as const } : {}),
      ...(input.outsideFolder === true ? { outsideFolder: true as const } : {}),
    }, { signal: input.signal }), input.signal);
    // A question waits as long as the owner takes, and a setting written meanwhile (another call they approved, a change
    // made anywhere) moves the configuration this decision was read under. Their recorded answer is the decision: it is
    // not failed for that, and what they asked to be remembered is kept. Only the call's own end (its signal) stops it.
    const answered = (): void => assertPermissionActive(input.signal);
    answered();
    // Nobody where the call was made can answer (a headless run with nobody answering it): held for the owner, said
    // where it waits; not the owner's refusal, and nothing is remembered from it.
    if (asked.heldForOwner === true) {
      const reason = asked.reason ?? 'held for you: nobody in this run can answer it';
      return { result: this.result(false, false, 'runtime_mode', 'mode_queued_for_owner', analysis, {
        detail: reason, decision: { state: 'queued-for-owner', decidedBy: 'mode', reason, next: ['carry on with the work that does not need this call'] },
      }) };
    }
    // Only a tier the ask offered is kept: a reply asking to remember anything else stands for this call alone.
    const askedTier = asked.rememberTier ?? (asked.remember === true ? 'session' : undefined);
    const reply: PermissionPromptDecision = askedTier === undefined || rememberOptions.some((option) => option.tier === askedTier)
      ? asked : { ...asked, remember: false, rememberTier: undefined };
    if (reply.settledBy !== undefined) return { result: this.settledBelow(input, analysis, reply, o.containable === true && o.ownerOnly === undefined, o.boundary) };
    const modified = reply.modifiedArgs === undefined ? undefined : captureOwnedJson(reply.modifiedArgs) as Record<string, unknown>;
    const notSaved = await this.rememberReply(input.toolName, input.args, reply, modified, o.ownerOnly);
    answered();
    // The owner just answered for these agents: the delegation check of the same call takes this answer instead of asking again.
    const delegated = delegatedTasks(input.toolName, modified ?? input.args);
    if (delegated !== undefined) this.answeredDelegations.set(delegated, { approved: reply.approved, ...(reply.reason ? { reason: reply.reason } : {}) });
    // A new recipient the owner allowed and asked to be remembered is theirs for the rest of the session, whatever is sent there next.
    if (o.ownerOnly === 'new-recipient' && reply.approved && (reply.rememberTier ?? (reply.remember === true ? 'session' : undefined)) !== undefined
      && (modified === undefined || isDeepStrictEqual(modified, input.args))) {
      const session = `${this.projectKeyPrefix()}${sessionOfCheck.getStore() ?? ''}`;
      for (const recipient of input.recipients ?? []) for (const part of recipientParts(recipient)) this.allowedRecipients.add(`${session}|${part}`);
    }
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
      { ...extra, userReason: reply.reason, ...(modified ? { modifiedArgs: modified } : {}), ...(notSaved ? { detail: notSaved } : {}),
        ...(!reply.approved && reply.unanswered !== undefined ? { unanswered: reply.unanswered } : {}) }) };
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
    // An item of the owner's list (classify.ts), as released: asked in every mode that reaches here, held for the end of
    // the run in Just vibes; Jev is never asked to decide it.
    if (decided.kind === 'owner-only') {
      if (input.mode === 'just-vibes') {
        const approvedOnce = this.heldOnceApproved(input);
        if (approvedOnce) return approvedOnce;
        return this.queuedForOwner(input, input.policyResult.analysis, `held for you: ${ownerOnlyWords(decided.item, decided.because)}`, decided.item);
      }
      return this.askOwner(input, input.policyResult.analysis, {
        reasons: [`Only you decide this: ${ownerOnlyWords(decided.item, decided.because)}.`], ownerOnly: decided.item, ownerOnlyBecause: decided.because,
        revisedDetail: 'Prepare the exact action revised and approved by the owner.',
        // A card's detail the owner types is answered each time: nothing is offered to remember.
        ...(decided.once === true ? { single: true } : {}),
      });
    }
    // Plan mode reached here only for a read the defaults did not settle (outside the directories).
    if (input.mode === 'plan') return { result: input.policyResult };
    // just-vibes with no decision model set up: nobody can decide now without interrupting the owner.
    // A set model that is failing is still asked (it is how its recovery is seen); a failure holds the call below.
    if (input.mode === 'just-vibes' && !this.steady(() => this.decisionModelWorks())) {
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
      // The decision waits for the model: each request ends when it answers, errors or the
      // connection fails. A failure takes the decision's fallback like any other decision: under
      // Hybrid the no-model path decides with a notice; under Decision Model Only this one call is
      // refused with that reason (assessExecutionSafety), and the turn goes on.
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
      // The operation moved to no decision model while this call was in flight: the gate's own
      // no-model path (owner configuration, then the owner) decides, as for a call that started there.
      if (reading.unassessed) return this.assessClassicExecutionSafety(input);
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
    // A refusal by the boundary is not Jev's to overrule in any mode. Wholesale destruction and
    // card details are refused outright; a refusal the boundary marks approvable (card details it
    // is unsure of, content that may repeat untrusted text) is cleared only by the owner's answer
    // for these exact arguments: asked now, or held for the owner in just-vibes (as released).
    if (!boundary.passed && boundary.refusedBy !== 'judgment-input') {
      if (!boundary.approvable) {
        return { result: this.result(false, false, 'boundary', BOUNDARY_REFUSAL_CODES[boundary.refusedBy], analysis, { boundary: boundaryResult, detail: boundary.reason }) };
      }
      const heldKey = ownerOnlySessionKey('untrusted-derived-send', this.getApprovalKey(input.toolName, input.args), input.args);
      if (this.sessionApprovals.get(heldKey) === true) {
        // The owner approved this exact held call at the end of a run: good for that one run.
        this.sessionApprovals.delete(heldKey);
        this.sessionApprovalRevision++;
        return { result: this.result(true, false, 'user_prompt', 'owner_approved_outward', analysis,
          { boundary: boundaryResult, detail: 'The owner approved this exact call after the boundary held it.' }) };
      }
      if (input.mode === 'just-vibes') return this.queuedForOwner(input, analysis, `held for you: ${boundary.reason}`, 'untrusted-derived-send');
      return this.askOwner(input, analysis, {
        reasons: [boundary.reason], boundary: boundaryResult, single: true,
        preset: { preset: input.mode, action: 'ask' }, revisedDetail: 'Prepare the exact action revised and approved by the owner.',
      });
    }
    // A shell command the boundary could not tell from wholesale destruction is the owner's in every
    // mode the gate reads: Jev is never offered to run it. Asked for this one call (nothing is
    // offered to remember), or held for the end of the run in just-vibes (as released).
    if (reading?.boundary.catastrophic === 'uncertain') {
      const item: OwnerOnlyKind = 'unrecoverable-delete';
      const reason = 'This command may destroy the machine or your data wholesale, and the reading could not rule it out.';
      const answered = this.sessionApprovals.get(ownerOnlySessionKey(item, this.getApprovalKey(input.toolName, input.args), input.args));
      if (answered !== undefined) {
        return { result: this.result(answered, false, 'session_override', answered ? 'session_cached_allow' : 'session_cached_deny', analysis,
          { boundary: boundaryResult, detail: `Your answer earlier in this session for this exact command: ${ownerOnlyReason(item)}.` }) };
      }
      if (input.mode === 'just-vibes') return this.queuedForOwner(input, analysis, `held for you: ${reason}`, item);
      return this.askOwner(input, analysis, {
        reasons: [reason], ownerOnly: item, boundary: boundaryResult, single: true,
        preset: { preset: input.mode, action: 'ask' }, revisedDetail: 'Prepare the exact action revised and approved by the owner.',
      });
    }
    // What the reading puts on the owner's own list goes to them as an item code recognizes does:
    // asked in ask-me and jev-decides, held for the end of the run in just-vibes; Jev is not asked (as released).
    const readingItem = reading ? ownerOnlyFromReading(reading) : undefined;
    if (readingItem !== undefined) {
      const answered = this.sessionApprovals.get(ownerOnlySessionKey(readingItem, this.getApprovalKey(input.toolName, input.args), input.args));
      if (answered !== undefined) {
        return { result: this.result(answered, false, 'session_override', answered ? 'session_cached_allow' : 'session_cached_deny', analysis,
          { boundary: boundaryResult, detail: `Your answer earlier in this session: ${ownerOnlyReason(readingItem)}.` }) };
      }
      if (input.mode === 'just-vibes') return this.queuedForOwner(input, analysis, `held for you: ${ownerOnlyReason(readingItem)}`, readingItem);
      return this.askOwner(input, analysis, {
        reasons: [`Only you decide this: ${ownerOnlyReason(readingItem)}.`], ownerOnly: readingItem, boundary: boundaryResult,
        preset: { preset: input.mode, action: 'ask' }, revisedDetail: 'Prepare the exact action revised and approved by the owner.',
      });
    }
    if (input.mode === 'ask-me') {
      if (boundary.passed && reading?.stakes !== 'critical' && reading?.irreversible !== true && reading?.weakensSecurity !== true) {
        return { result: this.result(true, false, 'stakes_preset', 'preset_allow', analysis,
          { boundary: boundaryResult, preset: { preset: 'ask-me', action: 'allow' } }) };
      }
      return this.askOwner(input, analysis, {
        reasons: !boundary.passed ? [boundary.reason] : [], boundary: boundaryResult,
        preset: { preset: 'ask-me', action: 'ask' }, revisedDetail: 'Prepare the exact action revised and approved by the owner.',
        // Asked only for where the call could reach (secrets sent out): a real boundary answers that.
        containable: boundary.passed && reading !== undefined && !reading.irreversible && !reading.weakensSecurity
          && !reading.obfuscated && reading.catastrophicUncertain !== true,
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
        // Facts for the existing decision: the surface, who is asking, the project and the outside read.
        provenance: decisionProvenance(this.gate.surfaceOf?.(), input.attribution, input.workingDirectory) }) as unknown as EntryType,
      evidence: [{ id: 'requested-tool-input', revision: input.actionRevision }, { id: 'live-authority', revision: input.authorityRevision }],
      // The host alternatives and resume conditions defined for this call are offered, so Jev can revise or defer.
      supportingDecisionIds: supportingIds, choices: input.choices ?? {}, allowAct: input.policyResult.approved,
      assertCurrent: input.assertCurrent, signal: input.signal,
    });
    input.assertCurrent();
    const receipt = decision.decision;
    // What the acting model reads: the outcome and the reading it rests on.
    const detail = jevDecisionDetail(receipt.outcome, reading);
    // just-vibes does not refuse what Jev would not run: the owner decides it at the end of the run (as released).
    if (input.mode === 'just-vibes' && receipt.outcome !== 'act') {
      return { ...this.queuedForOwner(input, analysis, `held for you: ${detail}`), recordClaim: () => decision.recordClaim() };
    }
    return {
      result: this.result(receipt.outcome === 'act', false, 'jev_decision', `jev_${receipt.outcome}`, analysis,
        { boundary: boundaryResult, autonomousDecision: receipt, detail: receipt.outcome === 'act' ? receipt.summary : detail,
          preset: { preset: input.mode, action: receipt.outcome === 'act' ? 'allow' : 'deny' } }),
      recordClaim: () => decision.recordClaim(),
      ...(decision.revision ? { revision: decision.revision } : {}),
    };
  }

  /** The facts one call is classified by, from values this decision already holds. */
  private callFacts(i: CallFactInput): CallFacts {
    const paths = declaredValues(i.args, i.definition?.subjects?.paths);
    // Whose input the turn acts on, read where it is decided (security/turn-input-party.ts): someone else's turn runs
    // reads only, for every tool, whatever the mode (gate/classify.ts); a tool that holds such a call to the real
    // sandbox boundary itself (exec) is decided as usual and refused there when no boundary applies.
    // A caller's own request over the wire (a paired device's direct call; security/turn-input-party.ts
    // `asCallOutsideTurn`) is no turn: its door decided it by the one owner decision, and the act that door runs for it
    // as decided is not refused here as someone else's turn. Every turn, and every other call in that scope, is.
    const party = i.ownerConfirmed === true && inDirectCall() ? { party: 'owner' as const } : turnInputParty();
    // A call refused whatever anyone answers is refused before any question (gate/classify.ts): a channel conversation
    // with no project changing something.
    const channelWithoutProject = channelWithoutProjectRefusalFor(i.toolName);
    // What runs by itself later (a schedule, a trigger, a watcher, a task, work), from a turn that read text anyone can
    // write: the owner's, asked in every mode (yolo included), each time; never made unasked from what the turn read.
    const runsLaterFromRead = i.untrustedRead && i.ownerOnly !== 'owner-act' && runsLaterCall(i.args, i.definition);
    // The same rule for sending, spending and loosening, after a read in this turn or any earlier turn of the
    // conversation (security/conversation-exposure.ts): an owner-only call of those kinds, and a capability that sends or
    // spends, is asked each time in every mode, never settled by a remembered yes or by the mode.
    // And a file write of what steers a model in a later conversation (a project's instruction file, a skill, an agent
    // definition): the owner's acceptance before it exists, not after (security/conversation-exposure.ts).
    const sendsSpendsLoosensFromRead = !runsLaterFromRead && i.untrustedRead && i.ownerOnly !== 'owner-act'
      && ((i.ownerOnly !== undefined && EXPOSED_ASKED_KINDS.has(i.ownerOnly)) || sendsOrSpendsCall(i.args, i.definition)
        || (i.category === 'write' && (paths ?? []).some(steersAModelPath)));
    const ownerOnly = runsLaterFromRead ? 'loosen-security' as const
      : sendsSpendsLoosensFromRead ? (i.ownerOnly ?? 'untrusted-derived-send') : i.ownerOnly;
    // The owner's card says the conversation read text from outside, and where (the line the owner is asked with).
    const exposedWords = runsLaterFromRead || sendsSpendsLoosensFromRead ? exposureWordsNow() : undefined;
    const ownerOnlyBecause = runsLaterFromRead ? [RUNS_LATER_FROM_READ_BECAUSE, exposedWords].filter(Boolean).join('. ')
      : sendsSpendsLoosensFromRead ? [i.ownerOnlyBecause ?? SENDS_FROM_READ_BECAUSE, exposedWords].filter(Boolean).join('. ') : i.ownerOnlyBecause;
    return {
      ...(party.party === 'other' ? { otherParty: party.who, ...(i.definition?.heldToBoundary === true ? { heldToBoundary: true } : {}) } : {}),
      ...(channelWithoutProject !== undefined ? { channelWithoutProject } : {}),
      tool: i.toolName, category: i.category, sideEffects: i.definition?.sideEffects, surface: i.surface,
      rule: i.mode === 'yolo' ? undefined : i.rule,
      paths: paths === undefined ? undefined : classifyPaths(paths, i.directory),
      recoverable: declaredRecoverable(i.definition, i.args),
      ownerOnly, untrustedRead: i.untrustedRead, declaredReadOnly: i.declaredReadOnly,
      ...(ownerOnlyBecause !== undefined ? { ownerOnlyBecause } : {}),
      ...(runsLaterFromRead || sendsSpendsLoosensFromRead ? { ownerOnlyOnce: true } : {}),
      ...(i.ownerOnly === 'owner-act' ? { ownerActWords: ownerActWordsOf(i.args, i.definition), ownerActAsked: ownerActAsked(i.args, i.definition),
        ownerActOnce: ownerActOnce(i.args, i.definition) } : {}),
      // A command that runs one of the product's own programs or touches the GoodVibes home: answered each time.
      ...(i.ownerOnly === 'loosen-security' && reachesProductPastGate(i.toolName, i.args, i.definition, i.directory ?? undefined, productHomeDirectories(), productReachProbe(this.configReader.getSetting?.('sandbox.enabled')))
        ? { ownerOnlyOnce: true } : {}),
      // A project whose trust cannot be read or resolved counts as restricted (fail closed), as on the autonomous path.
      workspaceRestricted: this.restrictedHere(),
      // A run that answers every question itself (`--answer-permissions`) decides such a call here, by its script, and
      // sends it saying so: the daemon does not ask the owner again (permissions/run-answerer.ts). A run nobody answers
      // decides it here too, so one the owner must decide is held for them instead of waited on.
      hostDecides: hostDecidesCall(i.args, i.definition) && !runAnswersEveryQuestion() && !runHoldsForOwner(),
      onlyTightens: (i.definition?.tightens ? callOnlyTightens(i.definition.tightens, i.args) : false)
        || settingsWriteOnlyTightens(i.toolName, i.args, (key) => this.configReader.getSetting?.(key)),
      ownWorkingState: i.definition?.ownWorkingState ? callWritesOwnWorkingState(i.definition.ownWorkingState, i.args) : false,
    };
  }

  /**
   * The one rule lookup of a decision, reported as the rule fact the
   * classifier reads: the owner's per-tool setting, managed policy, their answers
   * this session and their saved rules (the rule store's compiled list, handed
   * over by reference), and where a path's link leads. A deny is reported over
   * an ask or an allow: a tool setting, then managed policy, then a denying
   * answer or rule (including where a link leads), then an answer or rule, then
   * a managed allow. Yolo and plan mode's refusal of a change read no rule.
   */
  private async ruleFactOf(i: {
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly category: PermissionCategory;
    readonly mode: GatePresetName;
    readonly tools: PermissionsToolConfig | undefined;
    readonly ownerOnly: OwnerOnlyKind | undefined;
    readonly subjects: CallSubjects | undefined;
    readonly policyEnabled: boolean;
    readonly options: JudgmentReadingOptions;
    readonly owner?: AutonomousPermissionReading | undefined;
    readonly sessionId?: string | undefined;
  }): Promise<CallRuleFact | undefined> {
    if (i.mode === 'yolo' || (i.mode === 'plan' && i.category !== 'read')) return undefined;
    if (this.ownerDeniesTool(i.toolName, i.category, i.tools)) {
      const key = TOOL_CONFIG_KEYS[i.toolName] ?? 'delegate';
      return { effect: 'deny', source: 'tool-setting',
        description: i.tools?.[key] === 'deny' ? `the setting permissions.tools.${key} = deny` : 'the setting permissions.tools.write = deny' };
    }
    const managed = i.policyEnabled
      ? managedVerdict(await this.evaluateRuntimePolicy(i.toolName, i.args, i.mode, this.policyClassification(i.category), i.options, i.owner, i.subjects))
      : undefined;
    if (managed === false) return { effect: 'deny', source: 'managed-policy', description: 'managed permission policy' };
    const fact = (answer: RememberedDecision, where = ''): CallRuleFact => ({
      effect: answer.effect, source: answer.source === 'session_override' ? 'session' : 'user-rule', description: `${answer.description}${where}`,
      ...(answer.ownerOnly ? { ownerOnly: answer.ownerOnly } : {}),
    });
    const sessionId = i.sessionId ?? sessionOfCheck.getStore();
    const remembered = await this.rememberedDecision(this.getApprovalKey(i.toolName, i.args, sessionId), i.toolName, i.args, i.options, i.owner, i.ownerOnly, i.subjects);
    if (remembered?.effect !== 'deny') {
      // A link inside an allowed folder can lead to a path the owner denied: that denial applies too.
      const landed = await this.deniedWhereLinksLead(i.toolName, i.args, i.options, i.owner, sessionId);
      if (landed) return fact(landed, ', where this path\'s link leads');
    }
    if (remembered) return fact(remembered);
    if (managed === true) return { effect: 'allow', source: 'managed-policy', description: 'managed permission policy' };
    return undefined;
  }

  /** The gate result a classification stands for; owner-only and judgment calls continue as not refused. */
  private policyResultOf(decided: CallClass, analysis: PermissionRequestAnalysis): PermissionCheckResult {
    if (decided.kind !== 'fact') return this.result(true, false, 'config_policy', 'config_allow', analysis);
    const decision = decided.decision;
    switch (decided.basis) {
      case 'surface': return this.result(false, false, 'boundary', 'boundary_surface_authority', analysis, { decision, detail: decision.reason });
      case 'owner-act': return this.result(false, false, 'safety_check', 'owner_act', analysis, { decision, detail: decision.reason });
      case 'plan': return this.result(false, false, 'runtime_mode', 'plan_mode', analysis, { decision });
      case 'mode': return this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis, { decision, preset: { preset: 'yolo', action: 'allow' } });
      case 'declared-effect': return this.result(true, false, 'config_policy', 'config_allow', analysis, { decision, detail: decision.reason });
      case 'host': return this.result(true, false, 'config_policy', 'config_allow', analysis, { decision, detail: decision.reason });
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
   * http hook sends each event's tool arguments and results to its URL, so a change is the owner's grant
   * of access (owner-only `grant-access`), classified like any call: plan mode refuses it (it is a
   * write), yolo allows it, a surface that cannot direct changes cannot direct this one, a deny (a
   * setting that denies the tool the hook would use, or a remembered deny) refuses it, and otherwise the
   * owner is asked. The owner is asked once: an answer they chose to remember is their answer to this kind, so the
   * same change is not asked again for as long as they chose (this exact change for the session, or a rule).
   * just-vibes holds it for them at the end of the run.
   */
  async checkHookChange(request: import('../tools/state/index.js').HookChangeRequest, options?: PermissionExecutionOptions): Promise<{ approved: boolean; reason?: string }> {
    this.assertSelectedModeCurrent();
    assertPermissionActive(options?.signal);
    // A session answer belongs to the hosted session that gave it, as for every gated call.
    return sessionOfCheck.run(options?.hookOwner?.sessionId, () => this.decideHookChange(request, options?.signal));
  }

  private async decideHookChange(request: import('../tools/state/index.js').HookChangeRequest, signal: AbortSignal | undefined): Promise<{ approved: boolean; reason?: string }> {
    const hook = request.hook;
    const mode = this.getMode();
    const { args, analysis } = describeHookChange(request);
    // A command hook runs its command on every event it matches: the owner's never-run rules apply to it in every mode.
    if (request.action === 'add' || request.action === 'enable') {
      const command = hook.type === 'command' && typeof (hook as { readonly command?: unknown }).command === 'string' ? (hook as { readonly command: string }).command : undefined;
      const neverRun = command === undefined ? undefined
        : await this.neverRunMatch({ commands: [{ text: command }], argv: [], code: [], pieces: [] }, this.directoryHere() ?? undefined, signal);
      if (neverRun) return { approved: false, reason: this.neverRunResult(neverRun, analysis).detail ?? `the never-run rule "${neverRun.rule}" refuses this hook` };
    }
    const configured = (this.configReader.getAutonomousSnapshot?.() ?? this.configReader.getSnapshot()).permissions?.tools;
    const underlying = hook.type === 'command' || hook.type === 'ts' ? 'exec' : hook.type === 'http' ? 'fetch' : 'agent';
    const ownerOnly: OwnerOnlyKind = 'grant-access';
    // The setting that denies the tool the hook would use denies the hook too; otherwise the one rule lookup.
    const rule: CallRuleFact | undefined = mode === 'yolo' || mode === 'plan' ? undefined
      : this.ownerDeniesTool(underlying, 'write', configured)
        ? { effect: 'deny', source: 'tool-setting',
          description: `the setting ${configured?.write === 'deny' ? 'permissions.tools.write' : `permissions.tools.${TOOL_CONFIG_KEYS[underlying] ?? 'delegate'}`} = deny, which this ${hook.type} hook would use` }
        : await this.ruleFactOf({
          toolName: 'state', args, category: 'write', mode, tools: undefined, ownerOnly, subjects: undefined,
          policyEnabled: this.featureFlags?.isEnabled('permissions-policy-engine') === true, options: { signal },
        });
    assertPermissionActive(signal);
    if (rule?.effect === 'deny') return { approved: false, reason: `refused by ${rule.description}` };
    // As released: the change is classified as a call of its own (a grant of access), and no decision model reads it: Ask me
    // and Jev decides put it to the owner on its own card, Just vibes holds it for the end of the run, YOLO runs it, plan
    // refuses it.
    const decided = classifyCall(mode, this.callFacts({
      toolName: 'the hook change', args, category: 'write', mode, surface: this.gate.surfaceOf?.(), definition: undefined, ownerOnly,
      directory: this.directoryHere(), rule,
      untrustedRead: (this.gate.ledger ?? getProcessUntrustedContentLedger()).hasIngestedThisTurn(),
    }));
    const refusal = (decision: ToolDecision): string => [decision.reason, ...(decision.next ?? []).slice(0, 1)].join('; ');
    if (decided.kind === 'fact') return decided.allow ? { approved: true } : { approved: false, reason: refusal(decided.decision) };
    // The owner-only kind it is put to them as: grant-access, or a channel's request, or their own "always ask me" rule.
    const item: OwnerOnlyKind = decided.kind === 'owner-only' ? decided.item : ownerOnly;
    // A just-vibes run does not stop for it: it is held for the owner at the end of the run.
    if (mode === 'just-vibes') {
      const held = this.queuedForOwner({ toolName: 'state', args }, analysis, `held for you: ${ownerOnlyReason(item)}`, item);
      return { approved: false, reason: held.result.decision ? refusal(held.result.decision) : (held.result.detail ?? 'held for the owner') };
    }
    const reply = await awaitPermission(() => this.requestPermission({
      callId: crypto.randomUUID(), tool: 'state', args, category: 'write',
      analysis: { ...analysis, reasons: [...analysis.reasons, `Only you decide this: ${ownerOnlyReason(item)}.`] },
      workingDirectory: this.directoryHere() ?? undefined,
      // A channel's request is approved one call at a time: no remembered answer can stand in for the owner there.
      rememberOptions: item === 'channel-request' ? [] : buildRememberOptions('state', args, this.rememberedRulesHere()),
      ownerOnly: item,
    }, { signal }), signal);
    assertPermissionActive(signal);
    // The change itself cannot be edited on the card: an answer that edited it remembers nothing.
    const modified = reply.modifiedArgs === undefined ? undefined : captureOwnedJson(reply.modifiedArgs) as Record<string, unknown>;
    const notSaved = item === 'channel-request' ? undefined : await this.rememberReply('state', args, reply, modified, item);
    assertPermissionActive(signal);
    if (reply.approved) return { approved: true };
    return { approved: false, reason: reply.reason ?? `the ${hook.type} hook change was not approved${notSaved ? `. ${notSaved}` : ''}` };
  }

  /**
   * Puts a delegation to the owner when nothing they said settles it and the
   * decision model could not read it (agents/delegation-authority.ts): which
   * agents, how many, to do what, yes or no. yolo and just-vibes run without
   * asking, so they start it; plan mode starts nothing; ask-me and jev-decides
   * ask, in the ordinary approval prompt. Nothing is offered to remember here:
   * the agent tool keeps the answer for the rest of the conversation.
   */
  async askDelegation(question: { readonly tasks: readonly string[]; readonly reason: string }, options?: { readonly signal?: AbortSignal | undefined }): Promise<{ approved: boolean; asked: boolean; reason?: string }> {
    this.assertSelectedModeCurrent();
    const signal = options?.signal;
    assertPermissionActive(signal);
    const mode = this.getMode();
    if (mode === 'yolo' || mode === 'just-vibes') return { approved: true, asked: false };
    if (mode === 'plan') return { approved: false, asked: false, reason: 'plan mode is on, and agents are not started while planning' };
    // The gate put this very call to the owner a moment ago: their answer is the answer.
    const key = JSON.stringify(question.tasks);
    const answered = this.answeredDelegations.get(key);
    if (answered !== undefined) {
      this.answeredDelegations.delete(key);
      return { ...answered, asked: true };
    }
    const args: Record<string, unknown> = question.tasks.length === 1
      ? { mode: 'spawn', task: question.tasks[0] } : { mode: 'batch-spawn', tasks: question.tasks.map((task) => ({ task })) };
    const category = this.getCategory('agent', args);
    const analysis = analyzePermissionRequest('agent', args, category);
    const reply = await awaitPermission(() => this.requestPermission({
      callId: crypto.randomUUID(), tool: 'agent', args, category,
      analysis: { ...analysis, reasons: [...analysis.reasons, question.reason] },
      workingDirectory: this.directoryHere() ?? undefined,
      rememberOptions: [],
    }, { signal }), signal);
    assertPermissionActive(signal);
    return reply.approved ? { approved: true, asked: true } : { approved: false, asked: true, ...(reply.reason ? { reason: reply.reason } : {}) };
  }

  /**
   * Puts a model whose price moved away from free since it was chosen to the
   * owner before the first send to it (providers/model-price-changes.ts), in
   * the ordinary approval prompt, when their mode has them decide (Ask me, Plan,
   * and Jev decides without a working decision model; core/orchestrator.ts
   * decidePriceChange routes the other modes). With no one to answer (a headless
   * run that answers no prompts) it is refused, as every such ask is. Nothing
   * is offered to remember: the provider registry keeps a yes for this change.
   */
  async askModelPriceChange(question: { readonly registryKey: string; readonly name: string; readonly provider: string; readonly price?: string | undefined },
    options?: { readonly signal?: AbortSignal | undefined }): Promise<'keep' | 'refuse' | 'choose-model'> {
    const signal = options?.signal;
    assertPermissionActive(signal);
    const args: Record<string, unknown> = { mode: MODEL_PRICE_CHANGE_MODE, registryKey: question.registryKey, model: question.name, provider: question.provider,
      ...(question.price ? { price: question.price } : {}) };
    const reply = await awaitPermission(() => this.requestPermission({
      callId: crypto.randomUUID(), tool: 'model', args, category: 'execute',
      analysis: { classification: 'model-price-change', riskLevel: 'high', summary: `${question.name} is no longer free`,
        reasons: ['The model catalog no longer lists this model as free, so sending to it is charged.'] },
      workingDirectory: this.directoryHere() ?? undefined,
      rememberOptions: [],
    }, { signal }), signal);
    assertPermissionActive(signal);
    if (reply.approved) return 'keep';
    return reply.reason === MODEL_CHOICE_REASON ? 'choose-model' : 'refuse';
  }

  /**
   * Puts enabling a Google API on the owner's Cloud project to them, in the
   * ordinary approval prompt on its normal default, when their mode has them
   * decide (google/connection-repair.ts decideGoogleApiEnable routes the other
   * modes). A request of theirs was refused because the API is off; a yes runs
   * `gcloud services enable` as the signed-in gcloud account and the request
   * is sent again. With no one to answer it is refused, as every such ask is.
   */
  async askEnableGoogleApis(question: { readonly services: readonly string[]; readonly project: string; readonly account: string },
    options?: { readonly signal?: AbortSignal | undefined }): Promise<boolean> {
    const signal = options?.signal;
    assertPermissionActive(signal);
    const command = `gcloud services enable ${question.services.join(' ')} --project=${question.project}`;
    const args: Record<string, unknown> = { mode: 'enable-apis', command, services: [...question.services], project: question.project, account: question.account };
    const reply = await awaitPermission(() => this.requestPermission({
      callId: crypto.randomUUID(), tool: 'google', args, category: 'execute',
      analysis: { classification: 'google-enable-apis', riskLevel: 'medium', summary: `Turn on ${question.services.join(' and ')} on Google Cloud project ${question.project}`,
        reasons: [`A Google request was refused because the API is off on the project. GoodVibes runs ${command} as ${question.account}, then sends the request again.`] },
      workingDirectory: this.directoryHere() ?? undefined,
      rememberOptions: [],
    }, { signal }), signal);
    assertPermissionActive(signal);
    return reply.approved;
  }

  /**
   * Runs one call through the gate.
   *
   * @param attribution When present, rides on the brokered ask so a surface can
   * render which background agent (or server, or sandbox) is asking.
   */
  /**
   * Decide a model's call of a capability that runs the project's own commands (`code.test`, `worktree.setup`) as an
   * `exec` of exactly those commands: the same classifier, rules and mode, one decision for the call.
   */
  useCapabilityCommands(resolver: CapabilityCommandsResolver | null): void {
    this.capabilityCommands = resolver;
  }

  /** The commands a `capability_run` of code.test or worktree.setup runs here, as `exec` takes them; undefined otherwise. */
  private async capabilityCommandsOf(toolName: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Record<string, unknown>[] | undefined> {
    if (toolName !== 'capability_run' || this.capabilityCommands === null || (args['id'] !== 'code.test' && args['id'] !== 'worktree.setup')) return undefined;
    const commands = await this.capabilityCommands(args, this.directoryHere() ?? undefined).catch(() => undefined);
    assertPermissionActive(signal);
    return commands !== undefined && commands.length > 0 ? commands.map((command) => ({ ...command })) : undefined;
  }

  async checkDetailed(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<PermissionCheckResult> {
    this.assertSelectedModeCurrent();
    // A model's capability call that runs the project's commands is decided as those commands, once. A caller the daemon
    // put to the owner (`outside-caller`) is decided as the capability, as every other act of theirs.
    const asCommands = attribution?.kind === 'outside-caller' ? undefined : await this.capabilityCommandsOf(toolName, args, options?.signal);
    if (asCommands !== undefined) return this.checkDetailed('exec', { commands: asCommands }, attribution, { ...(options ?? {}), definition: undefined });
    const signal = options?.signal;
    const owner = options?.hookOwner;
    const definition = options?.definition;
    const ownerAsk = options?.ownerAsk;
    const check = () => sessionOfCheck.run(owner?.sessionId, () => withExecutionMode(this.getMode(), () => this.checkActive(toolName, args, attribution, signal, owner, definition, ownerAsk)));
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

  private async checkActive(toolName: string, borrowedArgs: Record<string, unknown>, attribution: PermissionAttribution | undefined, signal?: AbortSignal, hookOwner?: TurnHookOwner, definition?: ToolDefinition, ownerAsk?: string): Promise<PermissionCheckResult> {
    assertPermissionActive(signal);
    const duplicate = isInvocationAdmitted(toolName, borrowedArgs);
    const args = captureOwnedJson(borrowedArgs) as Record<string, unknown>;
    const category = this.getCategory(toolName, args, definition);
    const baseAnalysis = analyzePermissionRequest(toolName, args, category);
    // Until the call is classified, with the outside ask among its reasons; after, said once (withOwnerAsk).
    const analysis = withOwnerAsk(baseAnalysis, ownerAsk, { kind: 'judgment' });
    const callId = crypto.randomUUID();
    const mode = this.getMode();
    // isInvocationAdmitted already revalidates the exact private invocation's
    // source, policy, mode owner and lifetime; this is not a new mode approval.
    if (duplicate) return this.result(true, false, 'invocation_admission', 'invocation_already_admitted', analysis);
    const owner = currentExecutionModeOwner();
    const ownerRevision = owner?.getRevision();
    const surface = this.gate.surfaceOf?.();
    // A call the daemon it is sent to decides (`hostDecides`: a daemon method on what the daemon keeps, a schedule or a
    // channel route), or one that acts on what the daemon holds (`outsideFolder`: a daemon capability), does not act in
    // this program's folder, so the folder's trust does not hold it: it is held as a read.
    const assertWorkspace = await this.autonomousWorkspaceConstraint(hostDecidesCall(args, definition) || outsideFolderCall(args, definition) ? 'read' : category, signal);
    const exposure = (this.gate.ledger ?? getProcessUntrustedContentLedger()).captureTaintEvidence('turn');
    const authoritySnapshot = () => this.configReader.getAutonomousSnapshot?.() ?? {
      permissions: this.configReader.getSnapshot().permissions,
      autoApprove: this.configReader.isAutoApproveEnabled(), directory: this.configReader.getWorkingDirectory(),
    };
    const config = authoritySnapshot();
    const assertConfiguration = capturePermissionConfiguration(this.configReader, authoritySnapshot, config);
    // The project this call was asked about (call-project.ts), else the settings owner's folder.
    const directory = projectOfDecision() ?? config.directory;
    // The call names its owned immutable capture; owner revisions enforce freshness.
    const authorityRevision = callId;
    const assertCurrent = () => {
      assertPermissionActive(signal);
      exposure.assertCurrent(); assertWorkspace();
      if (this.gate.surfaceOf?.() !== surface) throw new Error('Execution source authority changed while deciding');
      assertConfiguration();
      if (!this.sameModeInForce(mode, () => this.getMode()) || owner?.getRevision() !== ownerRevision) throw new Error('Execution mode or owner changed while deciding');
    };
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', { callId, toolName, category, analysis }, hookOwner);
    assertCurrent();
    this.policyRuntimeState.recordPermissionRequest({ callId, tool: toolName, category, analysis, project: this.directoryHere() ?? undefined });
    // The owner's never-run rules decide first, in every mode: nothing below may run what they forbid.
    const neverRun = await this.neverRunMatch(callShellTexts(toolName, args, definition), directory ?? undefined, signal);
    if (neverRun) {
      assertCurrent();
      return this.emitAndReturn(callId, toolName, category, this.neverRunResult(neverRun, analysis), hookOwner);
    }
    const ownerFacts = this.ownerOnlyFacts(toolName, args, definition, category, directory ?? undefined);
    const cause = ownerOnlyCause(toolName, args, definition, ownerFacts, directory ?? undefined);
    const ownerOnly = cause?.kind;
    const rule = await this.ruleFactOf({
      toolName, args, category, mode, tools: config.permissions?.tools, ownerOnly, subjects: callSubjects(args, definition),
      policyEnabled: this.featureFlags?.isEnabled('permissions-policy-engine') === true, options: { signal, assertCurrent },
    });
    const decided = askedByOwnerRule(classifyCall(mode, this.callFacts({
      toolName, args, category, mode, surface, definition, ownerOnly, ownerOnlyBecause: cause?.because,
      directory, rule,
      untrustedRead: (this.gate.ledger ?? getProcessUntrustedContentLedger()).hasIngestedThisTurn() || conversationExposedNow(),
    })), ownerAsk);
    const policyResult = this.policyResultOf(decided, withOwnerAsk(baseAnalysis, ownerAsk, decided));
    const safety = await this.assessExecutionSafety({
      callId, sourceId: callId, toolName, args, category, policyResult, decided, mode, signal, assertCurrent,
      workingDirectory: directory ?? undefined, authorityRevision, authoritySnapshot: captureJsonEntry({ ...config, directory }),
      actionRevision: callId, attribution, recipients: ownerFacts.recipients,
      outsideFolder: hostDecidesCall(args, definition) || outsideFolderCall(args, definition),
    });
    assertCurrent();
    // The owner's yes, after a wait, never outweighs a refusal put in force meanwhile (refusedSinceAsked).
    const answeredYes = safety.result.approved && safety.result.sourceLayer === 'user_prompt';
    const result = (answeredYes ? await this.refusedSinceAsked({ toolName, args, definition, category, mode, ownerOnly,
      directory: directory ?? undefined, analysis: policyResult.analysis, signal }) : undefined) ?? safety.result;
    this.noteJevDecision(toolName, args, category, result);
    return this.emitAndReturn(callId, toolName, category, result, hookOwner);
  }

  /**
   * The owner's `Pre:tool:<tool>` hooks on a call one tool makes inside
   * another (the registry's nested and ordinary on-behalf calls): the same
   * point a model's own call fires, in every permission mode. A deny or a
   * failing hook refuses the call; an ask is handed to the gate (`ownerAsk`)
   * so the owner decides; a rewrite is what is admitted and run. Nothing is
   * fired when no hook dispatcher is wired.
   */
  async preToolHooks(callId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
    readonly args: Record<string, unknown>; readonly refusal?: string; readonly ask?: string;
  }> {
    const dispatcher = this.hookDispatcher;
    if (!dispatcher) return { args };
    let result: Awaited<ReturnType<HookDispatcher['fire']>>;
    // The call's effect as the gate classes it, so a hook bound to an effect fires for nested calls too.
    const effects = [this.getCategory(toolName, args)];
    try {
      result = await dispatcher.fire({
        path: `Pre:tool:${toolName}`, phase: 'Pre', category: 'tool', specific: toolName,
        sessionId: sessionOfCheck.getStore() ?? 'nested', timestamp: Date.now(), effects,
        payload: { callId, tool: toolName, args, nested: true, effects },
      });
    } catch (error) {
      assertPermissionActive(signal);
      return { args, refusal: `Tool '${toolName}' was not run because its Pre hook failed (${summarizeError(error)}). Fix or remove the hook, then retry.` };
    }
    assertPermissionActive(signal);
    if (result.decision === 'deny') return { args, refusal: result.reason ?? `Tool '${toolName}' was refused by its Pre hook.` };
    const next = result.updatedInput ? captureOwnedJson(result.updatedInput) as Record<string, unknown> : args;
    return { args: next, ...(result.decision === 'ask' ? { ask: `Your Pre:tool:${toolName} hook asks you about this call${result.reason ? `: ${result.reason}` : '.'}` } : {}) };
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
    const neverRun = await this.neverRunMatch(callShellTexts(toolName, captured, definition), this.directoryHere() ?? undefined, signal);
    if (neverRun) {
      const description = `your never-run rule "${neverRun.rule}" (${neverRun.why})`;
      return { mode, category, decided: { kind: 'fact', allow: false, basis: 'owner-rule',
        rule: { effect: 'deny', source: 'user-rule', description },
        decision: { state: 'refused', decidedBy: 'rule', reason: `refused by ${description}`, limit: description,
          next: ['carry on without this call and report that it was not run', 'only the owner can remove the rule'] } } };
    }
    const directory = this.directoryHere() ?? undefined;
    const ownerOnly = recognizeOwnerOnly(toolName, captured, definition, this.ownerOnlyFacts(toolName, captured, definition, category, directory), directory);
    const rule = await this.ruleFactOf({
      toolName, args: captured, category, mode, tools: config.permissions?.tools, ownerOnly, subjects: callSubjects(captured, definition),
      policyEnabled: this.featureFlags?.isEnabled('permissions-policy-engine') === true, options: signal ? { signal } : {},
    });
    const decided = classifyCall(mode, this.callFacts({
      toolName, args: captured, category, mode, surface: this.gate.surfaceOf?.(), definition, ownerOnly,
      directory: this.directoryHere(), rule,
      untrustedRead: (this.gate.ledger ?? getProcessUntrustedContentLedger()).hasIngestedThisTurn() || conversationExposedNow(),
    }));
    return { mode, category, decided };
  }

  /**
   * The facts the owner-only list reads from this process's settings and the
   * owner's answers: whether the call is a settings write that loosens its key,
   * and whether it sends to a recipient that is neither one of the owner's configured
   * destinations nor one they allowed this session. The recipients are the ones
   * the tool declares (callRecipients) and the ones code reads from a call no
   * declaration covers: a shell command that mails or posts a message, a
   * `fetch` to a messaging service, an MCP or plugin tool's recipient
   * arguments (gate/send-recipients.ts). Cost per call: one parse of each
   * command a call runs (and a read of each shell script it runs, from
   * `directory`), a walk of an undeclared tool's arguments, and a few settings
   * reads only when a recipient was found.
   */
  private ownerOnlyFacts(toolName: string, args: Record<string, unknown>, definition: ToolDefinition | undefined,
    category: PermissionCategory, directory: string | undefined, evidence?: ToolOwnedAdmissionEvidence): { readonly loosensSetting: boolean; readonly newRecipient: boolean; readonly recipients: readonly string[]; readonly productHomes: readonly string[];
      readonly productProbe?: ProductReachProbe; readonly searchPath: readonly string[] } {
    const declared = callRecipients(args, definition);
    const commands = callCommands(toolName, args, definition);
    const read = undeclaredSendRecipients(toolName, args, definition, commands, category === 'read', directory);
    const recipients = declared === undefined || read === undefined ? undefined : [...declared, ...read];
    const known = recipients === undefined || recipients.length === 0 ? undefined : this.knownRecipients();
    // A tool that writes files reaches the GoodVibes homes and the installed product's files too (gate/classify.ts).
    const reaches = commands.length > 0 || toolName === 'write' || toolName === 'edit' || definition?.sideEffects?.includes('write_fs') === true;
    return {
      loosensSetting: settingsWriteLoosens(toolName, args, evidence, key => this.configReader.getSetting?.(key)),
      newRecipient: recipients === undefined || (known !== undefined && recipients.some((recipient) => recipientParts(recipient).some((part) => !known.has(part)))),
      recipients: recipients ?? [],
      // Where the GoodVibes home is, read here (the classifier is pure): a command naming a file there reaches past the gate.
      productHomes: reaches ? productHomeDirectories() : [],
      // How its words resolve (links, script files, the person's home), and where programs are found: read here too.
      ...(reaches ? { productProbe: productReachProbe(this.configReader.getSetting?.('sandbox.enabled')) } : {}),
      searchPath: searchPathFolders(),
    };
  }

  /**
   * Where the owner sends things to themselves: their mail addresses, their notification
   * webhooks and the default recipients their surfaces are set up with, read
   * from settings now, and the recipients they allowed earlier in this session.
   */
  private knownRecipients(): ReadonlySet<string> {
    const session = `${this.projectKeyPrefix()}${sessionOfCheck.getStore() ?? ''}|`;
    const known = new Set<string>();
    for (const entry of this.allowedRecipients) if (entry.startsWith(session)) known.add(entry.slice(session.length));
    for (const key of OWNER_DESTINATION_KEYS) {
      let value: unknown;
      try { value = this.configReader.getSetting?.(key); } catch { continue; }
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry !== 'string') continue;
        // A webhook destination is stored as a reference to its URL: the URL is what a send names.
        const named = isSecretReferenceValue(entry) ? this.configReader.readStoredReference?.(entry) ?? null : entry;
        if (named !== null) for (const part of recipientParts(named)) known.add(part);
      }
    }
    return known;
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
    const ownerAnswer = ownerOnly === undefined ? undefined : this.sessionApprovals.get(ownerOnlySessionKey(ownerOnly, key, args));
    const session = ownerAnswer ?? this.sessionApprovals.get(key);
    if (session !== undefined) {
      return { approved: session, effect: session ? 'allow' : 'deny', source: 'session_override', reason: session ? 'session_cached_allow' : 'session_cached_deny',
        description: 'your answer earlier in this session', ...(ownerAnswer !== undefined ? { ownerOnly } : {}), assertCurrent: current };
    }
    // The store's compiled list: committed rules, then rules remembered from an
    // answer this process (matched live until the store loads them as committed
    // on restart). An admission's frame holds the publication it was read
    // under, which `current` compares, so the list here is the one it captured.
    const projectRoot = owner ? owner.frame.directory : this.directoryHere();
    const durable = this.userRuleStore
      ? await view.lookup.match(toolName, args, { signal: options.signal, assertCurrent: current, projectRoot: projectRoot ?? undefined, subjects })
      : null;
    current();
    if (!durable) return null;
    const approved = durable.effect === 'allow';
    const rule = durable.rule;
    return { approved, effect: durable.effect, source: 'user_rule', reason: approved ? 'user_rule_allow' : 'user_rule_deny',
      description: `the saved rule "${rule.description ?? durable.ruleId}"`,
      ...(rule.ownerOnly ? { ownerOnly: rule.ownerOnly } : {}), assertCurrent: current };
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
    const directory = this.directoryHere();
    return directory ? resolve(directory, path) : path;
  }

  /**
   * The folder of the project this decision is for: the one the turn or call
   * named (call-project.ts), else the settings owner's own. Rules are listed,
   * kept and matched for it, relative paths resolve in it, and asks name it.
   */
  private directoryHere(): string | null {
    return projectOfDecision() ?? this.configReader.getWorkingDirectory();
  }

  /**
   * Whether the project this decision is for is restricted: its trust's own answer, and restricted too when a project
   * was named and its trust could not be resolved or read (an unreadable store never reads as "not restricted").
   */
  private restrictedHere(): boolean | undefined {
    const trust = this.trustHere();
    if (trust === undefined) return projectOfDecision() !== undefined && this.gate.workspaceTrustFor !== undefined ? true : undefined;
    // A gate composed with no folder trust at all (null: a daemon comparison's, a capability gate's) holds no folder.
    return trust?.isRestricted?.();
  }

  /** The folder trust of the project this decision is for; a project whose trust cannot be resolved has none (non-reads refuse). */
  private trustHere(): GateOptions['workspaceTrust'] {
    const project = projectOfDecision();
    const resolver = this.gate.workspaceTrustFor;
    if (project === undefined || resolver === undefined) return this.gate.workspaceTrust;
    try { return resolver(project); }
    catch (error) {
      logger.warn('PermissionManager: the folder trust of a project could not be read; it is decided as having none', { project, error: summarizeError(error) });
      return undefined;
    }
  }

  /**
   * The project part of a session-answer key: "allow for this session" is kept
   * for one session in one project, so a session id shared by mistake, or none,
   * never carries an answer into another project.
   */
  private projectKeyPrefix(): string {
    const project = projectOfDecision();
    return project === undefined ? '' : `project:${projectIdentity(project)}|`;
  }

  /**
   * Whether a session answer denied this read key. With a session id only that
   * session's answer counts; without one (the caller does not know its session)
   * a denial from any session restricts, so an answer is never lost to a missing id.
   */
  private sessionDeniesRead(key: string, sessionId: string | undefined): boolean {
    const project = this.projectKeyPrefix();
    if (sessionId !== undefined) return this.sessionApprovals.get(`${project}session:${sessionId}|${key}`) === false;
    for (const [stored, approved] of this.sessionApprovals) {
      // Only this project's answers: a denial given in another project says nothing here.
      const own = project === '' ? stored : stored.startsWith(project) ? stored.slice(project.length) : undefined;
      if (approved === false && own !== undefined && (own === key || (own.startsWith('session:') && own.endsWith(`|${key}`)))) return true;
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
      const managed = managedVerdict(await this.evaluateRuntimePolicy('read', args, mode, 'read'));
      assertWorkspace();
      if (managed !== undefined) return managed ? 'allow' : 'restricted';
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
      this.sessionApprovals.set(ownerOnly === undefined ? key : ownerOnlySessionKey(ownerOnly, key, args), approved);
      // Search and map tools ask about one absolute path at a time (readAccess),
      // so a read answer is also kept for each file it covered.
      if (toolName === 'read') for (const path of extractPathArgs(args)) this.sessionApprovals.set(this.getApprovalKey('read', { path: this.absoluteReadPath(path) }), approved);
      this.sessionApprovalRevision++;
      return undefined;
    }
    const rule = buildDurableRuleForDecision({ toolName, args, tier, effect: approved ? 'allow' : 'deny', ...(ownerOnly && approved ? { ownerOnly } : {}) });
    const store = this.userRuleStore;
    // The project the call was asked about (call-project.ts): "in this project" is that one, never the daemon's folder.
    const project = this.directoryHere();
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
      const session = sessionOfCheck.getStore();
      await store.remember({ rule, tier, tool: toolName, createdAt: Date.now(), project: projectIdentity(project), ...(session !== undefined ? { session } : {}) });
      return undefined;
    } catch (error: unknown) {
      return notSaved(summarizeError(error));
    }
  }

  /**
   * The owner's never-run rule this call's shell texts match, read in every
   * mode (yolo included). The rule store is loaded first; a file that cannot
   * be read refuses, since a never-run rule in it cannot be checked. Costs
   * nothing beyond a list read when no never-run rule exists.
   */
  private async neverRunMatch(texts: CallShellTexts, directory: string | undefined, signal: AbortSignal | undefined): Promise<NeverRunMatch | undefined> {
    const store = this.userRuleStore;
    if (!store) return undefined;
    if (texts.commands.length === 0 && texts.argv.length === 0 && texts.code.length === 0 && texts.pieces.length === 0) return undefined;
    // Not loaded yet (nothing published): wait for the load, which throws while the file cannot be read.
    if ((store.committedRevision?.() ?? store.getPublicationRevision?.() ?? 1) === 0) {
      const ready = store.awaitReady ?? store.init;
      if (ready) await awaitPermission(() => ready.call(store), signal);
    }
    return neverRunMatchIn(texts, neverRunPatterns(this.ruleView().lookup), directory);
  }

  /**
   * After the owner's yes to a call that waited on them: the refusal of a rule in force now (a never-run rule, a deny rule
   * kept or remembered, the tool set to refuse in the settings as they are now), or undefined when none refuses it. Their
   * yes settles what they were asked; it never outweighs a refusal put in force while they were asked.
   */
  private async refusedSinceAsked(i: {
    readonly toolName: string; readonly args: Record<string, unknown>; readonly definition: ToolDefinition | undefined;
    readonly category: PermissionCategory; readonly mode: GatePresetName; readonly ownerOnly: OwnerOnlyKind | undefined;
    readonly directory: string | undefined; readonly analysis: PermissionRequestAnalysis; readonly signal: AbortSignal | undefined;
  }): Promise<PermissionCheckResult | undefined> {
    const neverRun = await this.neverRunMatch(callShellTexts(i.toolName, i.args, i.definition), i.directory, i.signal);
    if (neverRun) return this.neverRunResult(neverRun, i.analysis);
    // The settings as written now, another process's write included (the daemon writes this program's settings file).
    this.configReader.flushPendingChanges?.();
    const permissions = this.configReader.getAutonomousSnapshot?.()?.permissions ?? this.configReader.getSnapshot().permissions;
    const rule = await this.ruleFactOf({ toolName: i.toolName, args: i.args, category: i.category, mode: i.mode, tools: permissions?.tools,
      ownerOnly: i.ownerOnly, subjects: callSubjects(i.args, i.definition), policyEnabled: false,
      options: { ...(i.signal ? { signal: i.signal } : {}), assertCurrent: () => assertPermissionActive(i.signal) } });
    if (rule?.effect !== 'deny') return undefined;
    const [layer, , denyCode, persisted] = RULE_LAYERS[rule.source];
    return this.result(false, persisted, layer, denyCode, i.analysis, { detail: `Refused after your yes: ${rule.description} refuses it, put in force while the question waited.` });
  }

  /** The refusal a never-run match gives, recorded as the owner's rule. */
  private neverRunResult(match: NeverRunMatch, analysis: PermissionRequestAnalysis): PermissionCheckResult {
    return this.result(false, true, 'user_rule', 'user_rule_deny', analysis, {
      detail: `Your never-run rule "${match.rule}" refuses this call: ${match.why} (${match.command}). It applies in every permission mode, YOLO included; `
        + 'only you can remove it, in Permissions and safety, Rules.',
    });
  }

  /** The rules kept from the owner's answers that apply in this project. */
  private rememberedRulesHere(): readonly PolicyRule[] {
    const project = this.directoryHere();
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
      // A setting written during the invocation (a call the owner approved while another waited on them, a change made
      // anywhere) does not end it while the mode in force is the one it started under; a changed mode still does.
      try {
        assertConfiguration();
      } catch (error) {
        if (!this.sameModeInForce(mode, () => this.getMode())) throw error;
      }
      if (currentExecutionModeOwner() !== owner || owner?.getRevision() !== ownerRevision
        || (owner && !this.sameModeInForce(mode, () => this.ownerMode(owner)))) {
        throw new Error('Execution mode owner or configuration changed during the invocation');
      }
    } });
  }

  private assertSelectedModeCurrent(): void {
    const selected = currentExecutionMode();
    if (selected !== undefined && !this.sameModeInForce(selected, () => this.getMode())) throw new Error('Execution mode changed during the invocation');
  }

  /**
   * Whether `captured` is still the mode in force `now` reads, either side of a
   * decision-model failure episode: the first failure turns jev-decides into
   * ask-me and an answer turns it back, for the next call. A call already being
   * decided keeps the mode it started under; a settings or owner change still
   * counts. Synchronous reads only.
   */
  private sameModeInForce(captured: GatePresetName, now: () => GatePresetName): boolean {
    if (captured === now()) return true;
    const steady = this.steady(now);
    return steady === captured || (steady === 'jev-decides' && captured === 'ask-me');
  }

  /** Reads `read` with a set decision model taken as answering through its failure episode. */
  private steady<T>(read: () => T): T {
    const prior = this.assumeAnswering;
    this.assumeAnswering = true;
    try { return read(); } finally { this.assumeAnswering = prior; }
  }

  /**
   * The mode in force for a mode settled with the decision model taken as
   * answering: jev-decides is ask-me while the set model is failing, until it
   * answers again.
   */
  private failureAware(mode: GatePresetName): GatePresetName {
    if (mode !== 'jev-decides' || this.decisionModelWorks(true)) return mode;
    return this.steady(() => this.decisionModelWorks(true)) ? 'ask-me' : mode;
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
  getCategory(toolName: string, args: Record<string, unknown> = {}, definition?: Pick<ToolDefinition, 'category' | 'readModes' | 'tightens' | 'ownWorkingState'>): PermissionCategory {
    // A call that only tightens a protection (plan mode on, a folder restricted, a "never" rule) is classed a read:
    // a restricted folder lets it through and classifyCall allows it as a fact; plan mode still refuses it (as released).
    if (definition?.tightens && callOnlyTightens(definition.tightens, args)) return 'read';
    // So is a write of the model's own checklist: its working state, not the person's things (classifyCall allows it).
    if (definition?.ownWorkingState && callWritesOwnWorkingState(definition.ownWorkingState, args)) return 'read';
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
    return `${this.projectKeyPrefix()}${sessionId === undefined ? key : `session:${sessionId}|${key}`}`;
  }

  /**
   * Whether Jev can decide now: the decision-model settings, read when a
   * decision is made. `chosen`: the mode was chosen for this session rather
   * than read from settings.
   */
  private decisionModelWorks(chosen = false): boolean {
    return this.configReader.isDecisionModelReady?.(chosen, this.assumeAnswering) ?? true;
  }

  /** Set only inside {@link steady}: a set decision model is taken as answering. */
  private assumeAnswering = false;

  /**
   * The mode in force for a mode a session or surface chose: jev-decides is
   * ask-me while no decision model works, the same rule the configured mode
   * follows, so judgments go to the owner rather than to a model that cannot
   * answer. Read per call: setting up a decision model takes effect at once.
   * `explicitlyChosen`: the mode was chosen for this session or channel (a
   * Shift+Tab, a hosted session's mode, a channel profile), which counts as the
   * owner's choice like a saved one. Otherwise whether the saved setting is
   * the owner's or the shipped default decides, as for the configured mode.
   */
  modeInForce(chosen: unknown, explicitlyChosen = false): GatePresetName {
    return effectivePermissionMode(chosen, false, this.decisionModelWorks(explicitlyChosen));
  }

  /**
   * The mode in force for a chosen mode, as {@link modeInForce} decides it,
   * with the chosen mode and why they differ, for the surfaces that report it
   * (sessions.permissionMode.get). A few settings reads; no request.
   */
  describeModeInForce(chosen: unknown, explicitlyChosen = false): PermissionModeInForce {
    const selected = normalizePermissionMode(chosen);
    const mode = this.modeInForce(selected, explicitlyChosen);
    if (mode === selected) return { chosen: selected, mode };
    const reason = this.configReader.describeModeInForce?.(selected, explicitlyChosen).reason;
    return { chosen: selected, mode, ...(reason !== undefined ? { reason } : {}) };
  }

  /** A session owner's mode in force; the owner holds the mode the session chose, or the settings' when it chose none. */
  private ownerMode(owner: ExecutionModeOwner): GatePresetName {
    // A session in a project whose own settings file sets a stricter mode runs under that one: the stricter wins.
    const chosen = owner.getMode();
    const project = this.configReader.projectLayerSetting?.('permissions.mode');
    const held = project !== undefined && configKeyFacts('permissions.mode').loosens?.(project, chosen) === true;
    return this.modeInForce(held ? project : chosen, owner.isChosen?.() === true);
  }

  /**
   * A call held for the owner in just-vibes: not run, the work carries on, and
   * the agent lists it for the owner at the end of the run.
   */
  private queuedForOwner(input: Pick<SafetyInput, 'toolName' | 'args'>, analysis: PermissionRequestAnalysis, reason: string, ownerOnly?: OwnerOnlyKind): SafetyOutcome {
    const key = this.getApprovalKey(input.toolName, input.args);
    const approvalKey = ownerOnly === undefined ? key : ownerOnlySessionKey(ownerOnly, key, input.args);
    // Approving it later is the owner's session answer for this exact call, as if they had been asked now.
    // Held with the project and session it was made in: the list says where, and an approval settles it there only.
    const project = projectOfDecision(), session = sessionOfCheck.getStore();
    const held = this.heldForOwner().hold({ key: approvalKey, toolName: input.toolName, summary: analysis.summary, reason, ...(ownerOnly !== undefined ? { ownerOnly } : {}),
      ...(project !== undefined ? { project } : {}), ...(session !== undefined ? { sessionId: session } : {}) }, () => {
      this.sessionApprovals.set(approvalKey, true);
      this.sessionApprovalRevision++;
    });
    return { result: this.result(false, false, 'runtime_mode', 'mode_queued_for_owner', analysis, {
      detail: reason,
      decision: { state: 'queued-for-owner', decidedBy: 'mode', reason, heldId: held.id,
        next: ['carry on with the work that does not need this call',
          `the owner is shown it at the end of the run and can approve it (${held.id}) in Waiting for you, under Held calls; after that the same call runs`] },
    }) };
  }

  /**
   * Keep a decision Jev made for the owner (Waiting for you, Decisions), with
   * what the call does in words and what the owner can do about it: the standing
   * rules a choice would save, at the narrowest tier this call allows (built
   * now, so the call's arguments are not kept). Nothing when another layer decided.
   */
  private noteJevDecision(toolName: string, args: Record<string, unknown>, category: PermissionCategory, result: PermissionCheckResult): void {
    const receipt = result.autonomousDecision;
    if (result.sourceLayer !== 'jev_decision' || !receipt) return;
    const directory = this.directoryHere();
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
    this.jevDecisions().record({
      // Jev's reason in words (jevDecisionDetail: what the safety reading found), never the receipt's own summary.
      toolName, summary: result.analysis.summary, approved: result.approved, reason: result.detail ?? receipt.summary, decisionId: receipt.decisionId,
      // What the call does, in the words its ask would have used ("Change notes.md"): the decision is said in them.
      act: callActWords({ tool: toolName, args, category, workingDirectory: directory ?? undefined }),
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
      ...(policy.operation === 'no-decision-model' ? { decisionPolicy: policy } : {}),
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
    // Managed (registry) rules, by reference. The owner's saved rules are
    // matched once, by the store's compiled list (rememberedDecision); only a
    // hand-written mode-constraint rule, which that matcher does not read, is
    // evaluated here, between managed denies and managed allows as before.
    const managed = this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? [];
    const modeRules = userModeConstraints(view.lookup);
    const rules = modeRules.length === 0 ? managed : [...managed, ...modeRules];
    const evaluator = new LayeredPolicyEvaluator({
      mode:
        mode === 'yolo' ? 'allow-all'
        : mode === 'plan' ? 'plan'
        : 'default',
      projectRoot: (owner ? owner.frame.directory : this.directoryHere()) ?? undefined,
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
  private ruleView(): CompiledProjectRules & { readonly revision: number } {
    const store = this.userRuleStore;
    const project = this.directoryHere();
    if (!store) return NO_RULES;
    if (store.evaluationRules) return store.evaluationRules(project);
    // An embedding store without compiled lists: compiled for this check.
    const committed = store.rules(project), remembered = store.rememberedRules?.(project) ?? [];
    return { committed, remembered, lookup: compileRules([...committed, ...remembered]),
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
      // The project the call was decided for: a candidate policy's preview decides it again against that project.
      project: this.directoryHere() ?? undefined,
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
