import { factsFor } from '@goodvibes-jev/engine/platform/platform/routing';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { readTierPromptSupplement } from '@goodvibes-jev/engine/platform/platform/providers';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import { describeMemoryPromptEligibility, isPromptActiveMemory, MIN_PROMPT_MEMORY_CONFIDENCE } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentPersonaRegistry, buildActivePersonaPrompt } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { buildProjectContextPrompt, discoverProjectContextFiles } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentRoutineRegistry, buildEnabledRoutinesPrompt, evaluateAgentRoutineReadiness } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentSkillRegistry, buildEnabledSkillsPrompt, evaluateAgentSkillBundleReadiness, evaluateAgentSkillReadiness } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { buildVibePrompt, discoverVibeFiles } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { buildCapabilitySummaryPrompt } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { PromptContextReceipt } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { capabilitySnapshot } from '../capabilities/capability-snapshot.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface PromptContextArgs {
  readonly includeParameters?: unknown;
  readonly receiptId?: unknown;
  readonly turnId?: unknown;
  readonly outcomeStatus?: unknown;
  readonly limit?: unknown;
}

type PromptContextSegmentStatus = 'active' | 'attention' | 'empty' | 'unavailable';
type PromptContextReceiptOutcomeFilter = 'completed' | 'error' | 'cancelled' | 'pending';

interface PromptContextSegment {
  readonly id: string;
  readonly label: string;
  readonly status: PromptContextSegmentStatus;
  readonly order: number;
  readonly activeCount: number;
  readonly suppressedCount: number;
  readonly promptChars: number;
  readonly approxTokens: number;
  readonly route?: string;
  readonly selected?: readonly Record<string, unknown>[];
  readonly suppressed?: readonly Record<string, unknown>[];
  readonly note?: string;
  readonly preview?: string;
}

type PromptMemoryApi = Pick<MemoryApi, 'getAll'>;

interface PromptModelInfo {
  readonly model: unknown;
  readonly label: string;
  /** null when nothing states the window. */
  readonly contextWindow: number | null;
}

interface CompactPromptContextReceipt {
  readonly receiptId: string;
  readonly turnId: string | null;
  readonly source: string;
  readonly createdAt: number;
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly turnOutcome?: {
    readonly status: string;
    readonly terminalEvent: string;
    readonly stopReason: string;
    readonly completedAt: number;
    readonly detail?: string;
  };
  readonly promptChars?: number;
  readonly approxPromptTokens?: number;
  readonly activeRecords?: number;
  readonly suppressedRecords?: number;
  readonly segments?: readonly {
    readonly id: string;
    readonly status: string;
    readonly activeCount: number;
    readonly suppressedCount: number;
    readonly promptChars: number;
    readonly approxTokens: number;
  }[];
}

function readPromptString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPromptLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

function readOutcomeStatus(value: unknown): PromptContextReceiptOutcomeFilter | null {
  if (value === 'completed' || value === 'error' || value === 'cancelled' || value === 'pending') return value;
  return null;
}

function promptContextReceiptOutcomeStatus(receipt: PromptContextReceipt): PromptContextReceiptOutcomeFilter {
  return receipt.turnOutcome?.status ?? 'pending';
}

function promptContextQuote(value: string): string {
  return JSON.stringify(value);
}

function promptContextReceiptRoute(receiptId: string): string {
  return `context action:"receipt" receiptId:${promptContextQuote(receiptId)} includeParameters:true`;
}

function promptContextTurnRoute(turnId: string): string {
  return `context action:"receipt" turnId:${promptContextQuote(turnId)} includeParameters:true`;
}

function promptContextOutcomeRoute(status: PromptContextReceiptOutcomeFilter): string {
  return `context action:"receipts" outcomeStatus:${promptContextQuote(status)} includeParameters:true`;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function modelLabel(model: unknown): string {
  if (typeof model === 'string' && model.trim()) return model.trim();
  if (typeof model === 'object' && model !== null) {
    const candidate = model as { readonly registryKey?: unknown; readonly id?: unknown; readonly modelId?: unknown };
    for (const value of [candidate.registryKey, candidate.id, candidate.modelId]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return 'unknown';
}

function promptModelInfo(context: CommandContext): PromptModelInfo {
  const registry = context.provider.providerRegistry as {
    readonly getCurrentModel?: () => unknown;
    readonly getContextWindowForModel?: (model: unknown) => number;
    readonly getKnownContextWindowForModel?: (model: unknown) => number | null;
  };
  let model: unknown = context.session.runtime.model ?? 'unknown';
  if (typeof registry.getCurrentModel === 'function') {
    try {
      model = registry.getCurrentModel();
    } catch {
      model = context.session.runtime.model ?? model;
    }
  }
  // null: nothing states the window (the tier is then standard, not free).
  let contextWindow: number | null = 0;
  if (typeof registry.getKnownContextWindowForModel === 'function') {
    const value = registry.getKnownContextWindowForModel(model);
    contextWindow = value !== null && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  } else if (typeof registry.getContextWindowForModel === 'function') {
    const value = registry.getContextWindowForModel(model);
    contextWindow = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  return { model, label: modelLabel(model), contextWindow };
}

/**
 * Where a turn's prompt reads memory from. With the memory spine wired, that is
 * its recall snapshot, the same records an attached turn carries; otherwise the
 * local registry. Naming the source keeps the segment from describing a copy
 * the turn does not use.
 */
function promptMemorySource(context: CommandContext): { readonly memory: PromptMemoryApi | undefined; readonly fromSpine: boolean } {
  const spine = context.clients?.memorySpine;
  if (spine && typeof spine.recallSnapshot === 'function') return { memory: { getAll: () => spine.recallSnapshot().records }, fromSpine: true };
  return { memory: promptMemoryApi(context.clients?.agentKnowledgeApi?.memory), fromSpine: false };
}

function promptMemoryApi(value: unknown): PromptMemoryApi | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { readonly getAll?: unknown };
  return typeof candidate.getAll === 'function' ? candidate as PromptMemoryApi : undefined;
}

function segment(
  input: Omit<PromptContextSegment, 'approxTokens'> & { readonly promptText?: string | null },
  includeParameters: boolean,
): PromptContextSegment {
  const promptChars = input.promptText?.length ?? input.promptChars;
  return {
    id: input.id,
    label: input.label,
    status: input.status,
    order: input.order,
    activeCount: input.activeCount,
    suppressedCount: input.suppressedCount,
    promptChars,
    approxTokens: approxTokens(input.promptText ?? ''),
    ...(input.route ? { route: input.route } : {}),
    ...(input.selected ? { selected: input.selected } : {}),
    ...(input.suppressed ? { suppressed: input.suppressed } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(includeParameters && input.promptText ? { preview: previewHarnessText(input.promptText, 360) } : {}),
  };
}

function memorySort(left: MemoryRecord, right: MemoryRecord): number {
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
  return right.updatedAt - left.updatedAt;
}

function formatMemoryLine(record: MemoryRecord): string {
  const tags = record.tags.length > 0 ? ` tags=${record.tags.join(',')}` : '';
  const provenance = record.provenance.length > 0
    ? ` source=${record.provenance.slice(0, 2).map((entry) => `${entry.kind}:${entry.ref}`).join(',')}`
    : '';
  return `- [${record.scope}/${record.cls} ${record.confidence}% ${record.reviewState}${tags}${provenance}] ${record.summary}`;
}

// The turn prompt carries at most this many memory records; the segment, its suppressed reasons and the text agree on it.
const PROMPT_MEMORY_LIMIT = 10;

function promptMemoryRecords(memory: PromptMemoryApi | undefined): readonly MemoryRecord[] {
  if (!memory) return [];
  // Bound to one arg, see prompt-context-receipts.ts for why a bare
  // `.filter(isPromptActiveMemory)` leaks the array index in as `now`.
  return memory.getAll().filter((record) => isPromptActiveMemory(record)).sort(memorySort).slice(0, PROMPT_MEMORY_LIMIT);
}

function buildMemoryPromptFromRecords(records: readonly MemoryRecord[]): string {
  return [
    '## GoodVibes Agent Memory',
    `Use these local, non-secret memory records (each at confidence >= ${MIN_PROMPT_MEMORY_CONFIDENCE}%, none marked stale or contradicted; each line shows whether the owner reviewed it) to avoid asking repeat questions and to preserve durable user preferences, constraints, and operating facts.`,
    ...records.map(formatMemoryLine),
  ].join('\n');
}

function memorySegment(memory: PromptMemoryApi | undefined, includeParameters: boolean, fromSpine = false): PromptContextSegment {
  if (!memory) {
    return segment({
      id: 'memory',
      label: 'Reviewed memory',
      status: 'unavailable',
      order: 4,
      activeCount: 0,
      suppressedCount: 0,
      promptChars: 0,
      route: 'memory action:"status"',
      note: 'Agent-local memory API is unavailable in this runtime.',
    }, includeParameters);
  }
  const all = memory.getAll();
  const active = promptMemoryRecords(memory);
  const activeIds = new Set(active.map((record) => record.id));
  const suppressed = all.filter((record) => !activeIds.has(record.id));
  const promptText = active.length > 0 ? buildMemoryPromptFromRecords(active) : '';
  return segment({
    id: 'memory',
    label: 'Reviewed memory',
    status: suppressed.length > 0 ? 'attention' : active.length > 0 ? 'active' : 'empty',
    order: 4,
    activeCount: active.length,
    suppressedCount: suppressed.length,
    promptChars: promptText.length,
    promptText,
    // F7c: this segment orders the eligible set by stored confidence/recency
    // (memorySort), NOT by relevance to the current turn. The `context
    // action:"receipt"` surface (prompt-context-receipts.ts) additionally
    // ranks the same eligible set by per-turn semantic relevance when that
    // scoring succeeds. Stating the ordering basis here up front keeps the
    // two memory surfaces from reading as contradictory when their orders
    // differ for the same eligible records.
    note: fromSpine
      ? 'Read from the memory spine\'s recall snapshot (the daemon\'s records when attached, the local registry otherwise), ordered by stored confidence/recency, not by relevance to the current turn. See context action:"receipt" for what a turn actually carried and its per-turn relevance scoring.'
      : 'Read from this process\'s local memory registry, ordered by stored confidence/recency, not by relevance to the current turn. When attached to a daemon, a turn\'s prompt uses the daemon\'s recall snapshot instead: see context action:"receipt" for what a turn actually carried and its per-turn relevance scoring.',
    route: 'memory action:"status"',
    selected: active.map((record) => ({
      id: record.id,
      scope: record.scope,
      class: record.cls,
      confidence: record.confidence,
      inspectRoute: `agent_local_registry domain:"memory" action:"get" recordId:"${record.id}"`,
    })),
    suppressed: suppressed.slice(0, 12).map((record) => {
      // Honest, per-record reason straight from describeMemoryPromptEligibility,
      // the same wording source prompt-context-receipts.ts uses, never a
      // locally invented "not reviewed"/"outside prompt limit" guess. A record here
      // either genuinely failed eligibility, or passed it but was cut by the top-10
      // prompt slice, those read differently.
      const eligibility = describeMemoryPromptEligibility(record);
      return {
        id: record.id,
        reviewState: record.reviewState,
        confidence: record.confidence,
        reason: eligibility.eligible
          ? `eligible (${eligibility.reason}) but outside the top-${PROMPT_MEMORY_LIMIT} prompt slice, budget-limited, not a trust problem`
          : eligibility.reason,
        inspectRoute: `agent_local_registry domain:"memory" action:"get" recordId:"${record.id}"`,
      };
    }),
  }, includeParameters);
}

function promptStatus(active: number, suppressed: number): PromptContextSegmentStatus {
  if (suppressed > 0) return 'attention';
  if (active > 0) return 'active';
  return 'empty';
}

function compactPromptContextReceipt(
  receipt: PromptContextReceipt,
  includeParameters: boolean,
): CompactPromptContextReceipt {
  return {
    receiptId: receipt.receiptId,
    turnId: receipt.turnId,
    source: receipt.source,
    createdAt: receipt.createdAt,
    provider: receipt.provider,
    model: receipt.model,
    contextWindow: receipt.contextWindow,
    ...(receipt.turnOutcome ? {
      turnOutcome: {
        status: receipt.turnOutcome.status,
        terminalEvent: receipt.turnOutcome.terminalEvent,
        stopReason: receipt.turnOutcome.stopReason,
        completedAt: receipt.turnOutcome.completedAt,
        ...(receipt.turnOutcome.detail ? { detail: receipt.turnOutcome.detail } : {}),
      },
    } : {}),
    ...(includeParameters ? {
      promptChars: receipt.promptChars,
      approxPromptTokens: receipt.approxPromptTokens,
      activeRecords: receipt.activeRecords,
      suppressedRecords: receipt.suppressedRecords,
      segments: receipt.segments.map((segment) => ({
        id: segment.id,
        status: segment.status,
        activeCount: segment.activeCount,
        suppressedCount: segment.suppressedCount,
        promptChars: segment.promptChars,
        approxTokens: segment.approxTokens,
      })),
    } : {}),
  };
}

function promptContextReceiptSummary(context: CommandContext, args: PromptContextArgs, includeParameters: boolean): Record<string, unknown> {
  const store = context.clients?.promptContextReceipts;
  if (!store) {
    return {
      status: 'unavailable',
      count: 0,
      latestReceiptId: null,
      latestTurnId: null,
      latestCreatedAt: null,
      note: 'Prompt-context receipt storage is unavailable in this runtime.',
    };
  }
  const receiptId = readPromptString(args.receiptId);
  const turnId = readPromptString(args.turnId);
  const outcomeStatus = readOutcomeStatus(args.outcomeStatus);
  const hasFilter = Boolean(receiptId || turnId || outcomeStatus);
  const limit = readPromptLimit(args.limit, includeParameters ? 5 : 3);
  const latest = store.latest();
  const allReceipts = store.list(Math.max(store.count(), limit));
  const baseReceipts = receiptId ? allReceipts.filter((receipt) => receipt.receiptId === receiptId) : allReceipts;
  const matchingReceipts = baseReceipts.filter((receipt) => {
    if (turnId && receipt.turnId !== turnId) return false;
    if (outcomeStatus && promptContextReceiptOutcomeStatus(receipt) !== outcomeStatus) return false;
    return true;
  });
  const recent = matchingReceipts.slice(0, limit);
  const selected = hasFilter ? recent[0] ?? null : null;
  const filters = {
    ...(receiptId ? { receiptId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(outcomeStatus ? { outcomeStatus } : {}),
    limit,
  };
  return {
    status: latest ? hasFilter && recent.length === 0 ? 'not_found' : 'ready' : 'empty',
    count: store.count(),
    latestReceiptId: latest?.receiptId ?? null,
    latestTurnId: latest?.turnId ?? null,
    latestCreatedAt: latest?.createdAt ?? null,
    inspectRoute: 'context action:"prompt" includeParameters:true',
    matchingCount: matchingReceipts.length,
    ...(hasFilter ? { filters } : {}),
    selected: selected ? compactPromptContextReceipt(selected, includeParameters) : null,
    recent: recent.map((receipt) => compactPromptContextReceipt(receipt, includeParameters)),
    routes: {
      latestReceipt: latest ? promptContextReceiptRoute(latest.receiptId) : null,
      filterCompleted: promptContextOutcomeRoute('completed'),
      filterErrors: promptContextOutcomeRoute('error'),
      filterCancelled: promptContextOutcomeRoute('cancelled'),
      filterPending: promptContextOutcomeRoute('pending'),
      ...(latest?.turnId ? { latestTurn: promptContextTurnRoute(latest.turnId) } : {}),
      ...(selected ? { selectedReceipt: promptContextReceiptRoute(selected.receiptId) } : {}),
    },
    ...(includeParameters ? { latest: latest ? compactPromptContextReceipt(latest, true) : null } : {}),
  };
}

async function promptContextSegments(context: CommandContext, includeParameters: boolean, modelInfo: PromptModelInfo, signal?: AbortSignal): Promise<readonly PromptContextSegment[]> {
  const shellPaths = context.workspace.shellPaths;
  const runtimePrompt = context.session.runtime.systemPrompt ?? '';
  const { label: currentModel, contextWindow } = modelInfo;
  const registry = context.provider.providerRegistry;
  let registryModel: ReturnType<typeof registry.getCurrentModel> | null = null;
  try {
    registryModel = registry.getCurrentModel();
  } catch {
    // promptModelInfo already fell back to the session's model label; with no registry model there is no tier supplement to read.
  }
  const tierPrompt = registryModel === null ? '' : await readTierPromptSupplement(
    factsFor({ catalog: registry }, registryModel), registry.modelTiers,
    'agent.prompt-context-inspection', { audience: 'conversation', signal },
  );
  signal?.throwIfAborted();
  if (!shellPaths) {
    return [
      segment({
        id: 'base_system_prompt',
        label: 'Base system prompt',
        status: runtimePrompt ? 'active' : 'empty',
        order: 1,
        activeCount: runtimePrompt ? 1 : 0,
        suppressedCount: 0,
        promptChars: runtimePrompt.length,
        promptText: runtimePrompt,
      }, includeParameters),
      segment({
        id: 'agent_local_context',
        label: 'Agent-local context',
        status: 'unavailable',
        order: 2,
        activeCount: 0,
        suppressedCount: 0,
        promptChars: 0,
        note: 'Agent shell paths are unavailable, so VIBE.md, project context, personas, skills, routines, and local registry files cannot be inspected.',
      }, includeParameters),
    ];
  }

  // Mirror the runtime: the VIBE prompt is the files on disk, read once for both the prompt and the receipt.
  const vibe = discoverVibeFiles(shellPaths);
  const vibePrompt = buildVibePrompt(shellPaths, vibe) ?? '';
  const projectContext = discoverProjectContextFiles(shellPaths);
  const projectContextPrompt = buildProjectContextPrompt(shellPaths) ?? '';
  const personaSnapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
  const activePersona = personaSnapshot.activePersona;
  const personaPrompt = buildActivePersonaPrompt(shellPaths) ?? '';
  const routineSnapshot = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot();
  const activeRoutines = routineSnapshot.enabledRoutines.filter((routine) => routine.reviewState === 'reviewed' && evaluateAgentRoutineReadiness(routine).ready);
  const suppressedRoutines = routineSnapshot.enabledRoutines.filter((routine) => !activeRoutines.some((active) => active.id === routine.id));
  const routinePrompt = buildEnabledRoutinesPrompt(shellPaths) ?? '';
  const skillSnapshot = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot();
  const activeBundles = skillSnapshot.enabledBundles.filter((bundle) => {
    if (bundle.reviewState !== 'reviewed') return false;
    const readiness = evaluateAgentSkillBundleReadiness(bundle, skillSnapshot.skills);
    return readiness.ready && readiness.includedSkills.every((skill) => skill.reviewState === 'reviewed');
  });
  const activeSkillIds = new Set([
    ...skillSnapshot.enabledSkills.map((skill) => skill.id),
    ...activeBundles.flatMap((bundle) => bundle.skillIds),
  ]);
  const activeSkills = skillSnapshot.skills.filter((skill) => activeSkillIds.has(skill.id) && skill.reviewState === 'reviewed' && evaluateAgentSkillReadiness(skill).ready);
  const candidateSkillIds = new Set([
    ...skillSnapshot.enabledSkills.map((skill) => skill.id),
    ...skillSnapshot.enabledBundles.flatMap((bundle) => bundle.skillIds),
  ]);
  const suppressedSkills = skillSnapshot.skills.filter((skill) => candidateSkillIds.has(skill.id) && !activeSkills.some((active) => active.id === skill.id));
  const suppressedBundles = skillSnapshot.enabledBundles.filter((bundle) => !activeBundles.some((active) => active.id === bundle.id));
  const skillPrompt = buildEnabledSkillsPrompt(shellPaths) ?? '';
  const { memory, fromSpine: memoryFromSpine } = promptMemorySource(context);

  const capabilityIndex = capabilitySnapshot();
  const capabilityText = buildCapabilitySummaryPrompt(capabilityIndex) ?? '';

  return [
    segment({
      id: 'capabilities',
      label: 'Capability index',
      status: capabilityIndex ? 'active' : 'attention',
      order: 0,
      activeCount: capabilityIndex?.ready.length ?? 0,
      suppressedCount: (capabilityIndex?.needsSetup.length ?? 0) + (capabilityIndex?.unavailable.length ?? 0),
      promptChars: capabilityText.length,
      promptText: capabilityText,
      note: capabilityIndex
        ? `${capabilityIndex.ready.length} ready, ${capabilityIndex.needsSetup.length} need setup, ${capabilityIndex.unavailable.length} unavailable, ${capabilityIndex.disagreements.length} configured but not wired up.`
        : 'The capability index has not been resolved for this session, so the model is told the list is unknown rather than empty.',
    }, includeParameters),
    segment({
      id: 'base_system_prompt',
      label: 'Base system prompt',
      status: runtimePrompt ? 'active' : 'empty',
      order: 1,
      activeCount: runtimePrompt ? 1 : 0,
      suppressedCount: 0,
      promptChars: runtimePrompt.length,
      promptText: runtimePrompt,
      note: 'Runtime-owned base instructions are applied before Agent-local context.',
    }, includeParameters),
    segment({
      id: 'vibe',
      label: 'VIBE.md personality',
      status: promptStatus(vibe.files.length, vibe.blocked.length + vibe.files.filter((file) => file.truncated).length),
      order: 2,
      activeCount: vibe.files.length,
      suppressedCount: vibe.blocked.length,
      promptChars: vibePrompt.length,
      promptText: vibePrompt,
      route: 'vibe action:"status"',
      selected: vibe.files.map((file) => ({ path: file.path, scope: file.scope, truncated: file.truncated })),
      suppressed: vibe.blocked.map((file) => ({ path: file.path, scope: file.scope, reason: file.reason })),
    }, includeParameters),
    segment({
      id: 'project_context',
      label: 'Project context files',
      status: promptStatus(projectContext.files.length, projectContext.blocked.length + projectContext.files.filter((file) => file.truncated).length),
      order: 3,
      activeCount: projectContext.files.length,
      suppressedCount: projectContext.blocked.length,
      promptChars: projectContextPrompt.length,
      promptText: projectContextPrompt,
      route: 'context action:"files"',
      selected: projectContext.files.map((file) => ({
        id: file.id,
        source: file.source,
        scope: file.scope,
        truncated: file.truncated,
        inspectRoute: `context action:"file" contextFileId:"${file.id}"`,
      })),
      suppressed: projectContext.blocked.map((file) => ({ id: file.id, source: file.source, reason: file.reason })),
    }, includeParameters),
    memorySegment(memory, includeParameters, memoryFromSpine),
    segment({
      id: 'routines',
      label: 'Reviewed setup-ready routines',
      status: promptStatus(activeRoutines.length, suppressedRoutines.length),
      order: 5,
      activeCount: activeRoutines.length,
      suppressedCount: suppressedRoutines.length,
      promptChars: routinePrompt.length,
      promptText: routinePrompt,
      route: 'memory action:"curator" query:"routine"',
      selected: activeRoutines.map((routine) => ({ id: routine.id, name: routine.name, inspectRoute: `agent_local_registry domain:"routine" action:"get" recordId:"${routine.id}"` })),
      suppressed: suppressedRoutines.slice(0, 12).map((routine) => ({
        id: routine.id,
        reviewState: routine.reviewState,
        missingRequirements: evaluateAgentRoutineReadiness(routine).missing.length,
      })),
    }, includeParameters),
    segment({
      id: 'skills',
      label: 'Reviewed setup-ready skills and bundles',
      status: promptStatus(activeSkills.length + activeBundles.length, suppressedSkills.length + suppressedBundles.length),
      order: 6,
      activeCount: activeSkills.length + activeBundles.length,
      suppressedCount: suppressedSkills.length + suppressedBundles.length,
      promptChars: skillPrompt.length,
      promptText: skillPrompt,
      route: 'memory action:"curator" query:"skill"',
      selected: [
        ...activeBundles.map((bundle) => ({ id: bundle.id, domain: 'skill_bundle', name: bundle.name, inspectRoute: `agent_local_registry domain:"skill_bundle" action:"get" recordId:"${bundle.id}"` })),
        ...activeSkills.map((skill) => ({ id: skill.id, domain: 'skill', name: skill.name, inspectRoute: `agent_local_registry domain:"skill" action:"get" recordId:"${skill.id}"` })),
      ],
      suppressed: [
        ...suppressedBundles.slice(0, 6).map((bundle) => ({ id: bundle.id, domain: 'skill_bundle', reviewState: bundle.reviewState })),
        ...suppressedSkills.slice(0, 12).map((skill) => ({
          id: skill.id,
          domain: 'skill',
          reviewState: skill.reviewState,
          missingRequirements: evaluateAgentSkillReadiness(skill).missing.length,
        })),
      ],
    }, includeParameters),
    segment({
      id: 'persona',
      label: 'Active persona',
      status: activePersona && activePersona.reviewState !== 'reviewed' ? 'attention' : activePersona ? 'active' : 'empty',
      order: 7,
      activeCount: activePersona?.reviewState === 'reviewed' ? 1 : 0,
      suppressedCount: activePersona && activePersona.reviewState !== 'reviewed' ? 1 : 0,
      promptChars: personaPrompt.length,
      promptText: personaPrompt,
      route: 'memory action:"curator" query:"persona"',
      selected: activePersona?.reviewState === 'reviewed' ? [{ id: activePersona.id, name: activePersona.name, inspectRoute: `agent_local_registry domain:"persona" action:"get" recordId:"${activePersona.id}"` }] : [],
      suppressed: activePersona && activePersona.reviewState !== 'reviewed' ? [{ id: activePersona.id, name: activePersona.name, reviewState: activePersona.reviewState }] : [],
    }, includeParameters),
    segment({
      id: 'context_window_supplement',
      label: 'Context-window supplement',
      status: tierPrompt ? 'active' : 'empty',
      order: 8,
      activeCount: tierPrompt ? 1 : 0,
      suppressedCount: 0,
      promptChars: tierPrompt.length,
      promptText: tierPrompt,
      note: contextWindow === null
        ? `Model ${currentModel} has an unknown context window; guidance comes from the registered model-tier reading.`
        : `Model ${currentModel} has context window ${contextWindow}; guidance comes from the registered model-tier reading.`,
    }, includeParameters),
  ];
}

export async function promptContextSummary(context: CommandContext, args: PromptContextArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  // One reading of the model feeds both the segments and the budget, so they cannot name different models or windows.
  const modelInfo = promptModelInfo(context);
  const segments = [...await promptContextSegments(context, includeParameters, modelInfo, signal)].sort((left, right) => left.order - right.order);
  const activeRecords = segments.reduce((total, entry) => total + entry.activeCount, 0);
  const suppressedRecords = segments.reduce((total, entry) => total + entry.suppressedCount, 0);
  const promptChars = segments.reduce((total, entry) => total + entry.promptChars, 0);
  const approxPromptTokens = segments.reduce((total, entry) => total + entry.approxTokens, 0);
  const { label: currentModel, contextWindow } = modelInfo;
  const status = segments.some((entry) => entry.status === 'unavailable')
    ? 'unavailable'
    : suppressedRecords > 0 || segments.some((entry) => entry.status === 'attention')
      ? 'attention'
      : activeRecords > 0
        ? 'ready'
        : 'empty';
  return {
    status,
    order: segments.map((entry) => entry.id),
    model: currentModel,
    provider: context.session.runtime.provider,
    contextWindow,
    activeSegments: segments.filter((entry) => entry.status === 'active' || entry.status === 'attention').length,
    activeRecords,
    suppressedRecords,
    promptChars,
    approxPromptTokens,
    budget: {
      approxPromptTokens,
      contextWindow,
      percentOfWindow: contextWindow !== null && contextWindow > 0 ? Math.round((approxPromptTokens / contextWindow) * 1000) / 10 : null,
      note: 'Counts the segments listed here. A turn receipt also counts the operator policy text, so use context action:"receipt" for a turn\'s exact totals.',
    },
    receipts: promptContextReceiptSummary(context, args, includeParameters),
    segments,
    routes: {
      promptPlan: 'memory action:"curator" includeParameters:true',
      memoryPosture: 'memory action:"status"',
      projectContext: 'context action:"files"',
      vibeStatus: 'vibe action:"status"',
      learningCurator: 'memory action:"curator"',
    },
    policy: 'Read-only prompt context inspection. It reports current prompt composition, selected records, suppressed review/setup work, and approximate token budget without creating memory, mutating behavior, or dumping raw secrets.',
  };
}

export async function promptContextCatalogStatus(context: CommandContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const summary = await promptContextSummary(context, {}, signal);
  const receipts = context.clients?.promptContextReceipts;
  const latestReceipt = receipts?.latest() ?? null;
  return {
    modes: ['prompt_context'],
    status: summary.status,
    activeRecords: summary.activeRecords,
    suppressedRecords: summary.suppressedRecords,
    approxPromptTokens: summary.approxPromptTokens,
    receiptCount: receipts?.count() ?? 0,
    latestReceiptId: latestReceipt?.receiptId ?? null,
    modelRoute: 'context action:"prompt" includeParameters:true',
  };
}
