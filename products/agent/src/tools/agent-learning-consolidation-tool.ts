import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { MemoryBundle, MemoryRecord, MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { createLocalMemoryAccess, type MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { MEMORY_CLASSES, MEMORY_REVIEW_STATES, MEMORY_SCOPES, MODES, cloneRecord, deleteDuplicate, domainForCandidate, failure, getRecord, markDuplicateStale, nextGeneratedId, output, readLimit, readMode, readReceiptFile, readString, receiptId, receiptIdFromReceipt, receiptPath, requireConfirmedWrite, resolveCandidate, updateSurvivor, writeReceipt, type AgentLearningConsolidationDomain, type AgentLearningConsolidationToolArgs, type ConsolidationMemory, type LearningConsolidationReceipt } from './agent-learning-consolidation-core.ts';
import type { LearningCandidate } from './agent-harness-learning-curator.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';
import { createHarnessCatalogInputProjector, protectHarnessCatalogTool } from './agent-harness-catalog-ingress.ts';
import { confirmParameter, requestParameter } from './agent-harness-effect-admission.ts';
function arrayField(snapshot: Record<string, unknown>, key: string): string[] {
  const value = snapshot[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringField(snapshot: Record<string, unknown>, key: string): string | undefined {
  const value = snapshot[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(snapshot: Record<string, unknown>, key: string): number | undefined {
  const value = snapshot[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(snapshot: Record<string, unknown>, key: string): boolean | undefined {
  const value = snapshot[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requirementsFromSnapshot(snapshot: Record<string, unknown>): readonly { readonly kind: 'env' | 'command'; readonly name: string; readonly description?: string }[] {
  const value = snapshot.requirements;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    .map((entry) => {
      const kind = entry.kind === 'command' ? 'command' as const : 'env' as const;
      const name = readString(entry.name);
      const description = readString(entry.description);
      return {
        kind,
        name,
        ...(description ? { description } : {}),
      };
    })
    .filter((entry) => entry.name);
}

function requirementNames(snapshot: Record<string, unknown>, kind: 'env' | 'command'): readonly string[] {
  return requirementsFromSnapshot(snapshot)
    .filter((requirement) => requirement.kind === kind)
    .map((requirement) => requirement.name);
}

function localRecordSource(snapshot: Record<string, unknown>): 'user' | 'agent' | 'imported' | 'system' {
  const source = stringField(snapshot, 'source');
  return source === 'agent' || source === 'imported' || source === 'system' ? source : 'user';
}

function memoryScope(snapshot: Record<string, unknown>): 'session' | 'project' | 'team' {
  const scope = stringField(snapshot, 'scope');
  return scope && MEMORY_SCOPES.has(scope) ? scope as 'session' | 'project' | 'team' : 'project';
}

function memoryClass(snapshot: Record<string, unknown>): MemoryRecord['cls'] {
  const cls = stringField(snapshot, 'cls');
  return cls && MEMORY_CLASSES.has(cls) ? cls as MemoryRecord['cls'] : 'fact';
}

function memoryReviewState(snapshot: Record<string, unknown>): MemoryRecord['reviewState'] {
  const reviewState = stringField(snapshot, 'reviewState');
  return reviewState && MEMORY_REVIEW_STATES.has(reviewState) ? reviewState as MemoryRecord['reviewState'] : 'fresh';
}

function memoryRecordFromSnapshot(snapshot: Record<string, unknown>): MemoryRecord {
  const id = stringField(snapshot, 'id');
  const summary = stringField(snapshot, 'summary');
  if (!id || !summary) throw new Error('Delete receipt memory snapshot is missing id or summary.');
  return {
    id,
    scope: memoryScope(snapshot),
    cls: memoryClass(snapshot),
    summary,
    detail: stringField(snapshot, 'detail'),
    tags: arrayField(snapshot, 'tags'),
    provenance: Array.isArray(snapshot.provenance)
      ? snapshot.provenance.filter((entry): entry is MemoryRecord['provenance'][number] => (
        typeof entry === 'object'
        && entry !== null
        && !Array.isArray(entry)
        && ['session', 'turn', 'task', 'event', 'file'].includes(String((entry as Record<string, unknown>).kind))
        && typeof (entry as Record<string, unknown>).ref === 'string'
      ))
      : [],
    reviewState: memoryReviewState(snapshot),
    confidence: numberField(snapshot, 'confidence') ?? 60,
    reviewedAt: numberField(snapshot, 'reviewedAt'),
    reviewedBy: stringField(snapshot, 'reviewedBy'),
    staleReason: stringField(snapshot, 'staleReason'),
    createdAt: numberField(snapshot, 'createdAt') ?? Date.now(),
    updatedAt: numberField(snapshot, 'updatedAt') ?? Date.now(),
  };
}

/**
 * Puts back the review state a snapshot recorded and nothing else: content and
 * provenance stay as they are now, so an edit made after the stale mark survives.
 * Returns the state that was restored.
 */
async function restoreReviewState(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  domain: AgentLearningConsolidationDomain,
  id: string,
  snapshot: Record<string, unknown>,
): Promise<string> {
  const reviewState = stringField(snapshot, 'reviewState') ?? 'fresh';
  const staleReason = stringField(snapshot, 'staleReason') ?? 'Restored by learning curator rollback.';
  if (domain === 'memory') {
    const confidence = typeof snapshot.confidence === 'number' ? snapshot.confidence : undefined;
    const state = reviewState === 'stale' || reviewState === 'reviewed' || reviewState === 'contradicted' ? reviewState : 'fresh';
    const reviewed = await memory.updateReview(id, { state, confidence, staleReason, reviewedBy: 'agent' });
    if (!reviewed) throw new Error(`Unknown Agent-local memory ${id}`);
    return state;
  }
  const registry: { markReviewed(id: string): unknown; markStale(id: string, reason: string): unknown; update(id: string, input: Record<string, never>): unknown } =
    domain === 'persona' ? AgentPersonaRegistry.fromShellPaths(shellPaths)
      : domain === 'skill' ? AgentSkillRegistry.fromShellPaths(shellPaths)
        : AgentRoutineRegistry.fromShellPaths(shellPaths);
  if (reviewState === 'reviewed') { registry.markReviewed(id); return 'reviewed'; }
  if (reviewState === 'stale') { registry.markStale(id, staleReason); return 'stale'; }
  // An update with no fields is the registry's "mark fresh": it clears the review mark and keeps every field.
  registry.update(id, {});
  return 'fresh';
}

async function restoreSurvivor(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  receipt: LearningConsolidationReceipt,
): Promise<Record<string, unknown>> {
  const snapshot = receipt.beforeSurvivor;
  if (!snapshot) throw new Error(`Receipt ${receipt.id} has no survivor snapshot.`);
  if (!receipt.afterSurvivor) {
    // Without the survivor as the merge left it there is no way to tell whether it was edited since, and restoring the old fields would discard those edits.
    throw new Error(`Rollback refused: receipt ${receipt.id} is a merge recorded without the survivor's post-merge state, so it cannot be checked for later edits to ${receipt.survivorId}. Nothing was restored; compare the receipt's beforeSurvivor with the current record and edit it by hand if the old fields are wanted.`);
  }
  // Restoring the old fields over a survivor that was edited after the merge would silently discard those edits.
  const fields = receipt.domain === 'memory' ? ['detail', 'tags'] : ['description', 'tags', 'triggers'];
  const current = cloneRecord(await getRecord(shellPaths, memory, receipt.domain, receipt.survivorId));
  const changed = fields.filter((field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(receipt.afterSurvivor?.[field] ?? null));
  if (changed.length > 0) {
    throw new Error(`Rollback refused: survivor ${receipt.survivorId} was changed after the merge (${changed.join(', ')}), so restoring it would discard those edits. Nothing was restored.`);
  }
  if (receipt.domain === 'memory') {
    const record = await memory.update(receipt.survivorId, {
      detail: stringField(snapshot, 'detail') ?? '',
      tags: arrayField(snapshot, 'tags'),
    });
    if (!record) throw new Error(`Unknown Agent-local memory ${receipt.survivorId}`);
    await restoreReviewState(shellPaths, memory, receipt.domain, receipt.survivorId, snapshot);
    return cloneRecord(await memory.get(receipt.survivorId));
  }
  await updateSurvivor(shellPaths, memory, receipt.domain, receipt.survivorId, {
    description: stringField(snapshot, 'description') ?? '',
    tags: arrayField(snapshot, 'tags'),
    triggers: arrayField(snapshot, 'triggers'),
  }, stringField(snapshot, 'provenance'));
  await restoreReviewState(shellPaths, memory, receipt.domain, receipt.survivorId, snapshot);
  return cloneRecord(await getRecord(shellPaths, memory, receipt.domain, receipt.survivorId));
}

function recreateArguments(receipt: LearningConsolidationReceipt, snapshot: Record<string, unknown>): Record<string, unknown> {
  if (receipt.domain === 'memory') {
    return {
      action: 'create',
      scope: memoryScope(snapshot),
      cls: memoryClass(snapshot),
      summary: stringField(snapshot, 'summary') ?? '',
      detail: stringField(snapshot, 'detail') ?? '',
      tags: arrayField(snapshot, 'tags'),
      confidence: numberField(snapshot, 'confidence') ?? 60,
      provenance: `recreated-from-learning-consolidation:${receipt.id}:${stringField(snapshot, 'id') ?? 'unknown'}`,
    };
  }
  if (receipt.domain === 'persona') {
    return {
      domain: 'persona',
      action: 'create',
      name: stringField(snapshot, 'name') ?? '',
      description: stringField(snapshot, 'description') ?? '',
      body: stringField(snapshot, 'body') ?? '',
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
    };
  }
  if (receipt.domain === 'skill') {
    return {
      domain: 'skill',
      action: 'create',
      name: stringField(snapshot, 'name') ?? '',
      description: stringField(snapshot, 'description') ?? '',
      procedure: stringField(snapshot, 'procedure') ?? '',
      tags: arrayField(snapshot, 'tags'),
      triggers: arrayField(snapshot, 'triggers'),
      requiresEnv: requirementNames(snapshot, 'env'),
      requiresCommands: requirementNames(snapshot, 'command'),
      enabled: booleanField(snapshot, 'enabled') === true,
      provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
    };
  }
  return {
    domain: 'routine',
    action: 'create',
    name: stringField(snapshot, 'name') ?? '',
    description: stringField(snapshot, 'description') ?? '',
    steps: stringField(snapshot, 'steps') ?? '',
    tags: arrayField(snapshot, 'tags'),
    triggers: arrayField(snapshot, 'triggers'),
    requiresEnv: requirementNames(snapshot, 'env'),
    requiresCommands: requirementNames(snapshot, 'command'),
    enabled: booleanField(snapshot, 'enabled') === true,
    provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${receipt.id}`,
  };
}

/** The ids and names in use now: one read of the domain's store. */
async function currentLocalOccupancy(shellPaths: ShellPathService, memory: ConsolidationMemory, domain: AgentLearningConsolidationDomain): Promise<{ ids: Set<string>; names: Set<string> }> {
  if (domain === 'memory') return { ids: new Set((await memory.list()).map((record) => record.id)), names: new Set() };
  const records: readonly { readonly id: string; readonly name: string }[] = domain === 'persona' ? AgentPersonaRegistry.fromShellPaths(shellPaths).list()
    : domain === 'skill' ? AgentSkillRegistry.fromShellPaths(shellPaths).list()
      : AgentRoutineRegistry.fromShellPaths(shellPaths).list();
  return { ids: new Set(records.map((record) => record.id)), names: new Set(records.map((record) => record.name.toLowerCase())) };
}

async function recreateGuidance(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  receipt: LearningConsolidationReceipt,
): Promise<Record<string, unknown> | null> {
  if (receipt.phase !== 'delete') return null;
  const { ids: occupiedIds, names: occupiedNames } = await currentLocalOccupancy(shellPaths, memory, receipt.domain);
  const records = receipt.beforeDuplicates.map((snapshot) => {
    const previousId = stringField(snapshot, 'id') ?? '(unknown)';
    const name = stringField(snapshot, 'name') ?? stringField(snapshot, 'summary') ?? previousId;
    const expectedId = receipt.domain === 'memory'
      ? previousId
      : nextGeneratedId(name, occupiedIds, receipt.domain);
    const nameConflict = receipt.domain !== 'memory' && occupiedNames.has(name.toLowerCase());
    const idConflict = occupiedIds.has(previousId);
    const possible = receipt.domain === 'memory'
      ? !idConflict
      : expectedId === previousId && !nameConflict;
    occupiedIds.add(expectedId);
    if (receipt.domain !== 'memory') occupiedNames.add(name.toLowerCase());
    return {
      previousId,
      name,
      expectedId,
      exactId: {
        supported: true,
        possible,
        method: receipt.domain === 'memory'
          ? 'platform memory bundle import preserves record ids.'
          : 'Agent-local registry ids are deterministic from name when the old generated id and name are still free.',
        reason: possible
          ? 'Exact-id recreation is currently available.'
          : idConflict
            ? `A current ${receipt.domain} record already uses ${previousId}.`
            : nameConflict
              ? `A current ${receipt.domain} record already uses the name ${name}.`
              : `The next generated id would be ${expectedId}, not ${previousId}.`,
      },
      fallbackCreateRoute: receipt.domain === 'memory'
        ? 'memory action:"create"'
        : `agent_local_registry domain:"${receipt.domain}" action:"create"`,
      createArguments: recreateArguments(receipt, snapshot),
    };
  });
  return {
    automaticRollback: false,
    recreateRoute: `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" `,
    policy: 'Delete remains the final phase. Recreate is a separate admitted recovery action and refuses when exact ids are not currently safe.',
    records,
  };
}

/** Ids, phase, date and routes: no store is read. Recovery guidance is asked for by receiptId. */
function receiptSummary(receipt: LearningConsolidationReceipt): Record<string, unknown> {
  return {
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    domain: receipt.domain,
    candidateId: receipt.candidateId,
    phase: receipt.phase,
    survivorId: receipt.survivorId,
    duplicateIds: receipt.duplicateIds,
    rollbackRoute: receipt.phase === 'merge' || receipt.phase === 'stale'
      ? `agent_learning_consolidation mode:"rollback" receiptId:"${receipt.id}" `
      : null,
    recreateRoute: receipt.phase === 'delete'
      ? `agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}" `
      : null,
    ...(receipt.phase === 'delete' ? { recoveryRoute: `agent_learning_consolidation mode:"receipts" receiptId:"${receipt.id}"` } : {}),
  };
}

function previewCandidate(candidate: LearningCandidate): Record<string, unknown> {
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  return {
    status: 'preview',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    label: candidate.label,
    domain: candidate.domain,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    diffFields: plan.diffs.map((diff) => diff.field),
    diffs: plan.diffs,
    phases: [
      {
        id: 'stale',
        route: `agent_learning_consolidation mode:"stale" candidateId:"${candidate.id}" `,
        effect: 'Mark duplicates stale before deletion and write a rollback receipt.',
      },
      {
        id: 'delete',
        route: `agent_learning_consolidation mode:"delete" candidateId:"${candidate.id}" `,
        effect: 'Delete only duplicates that are already stale. Exact-id rollback is not automatic after delete.',
      },
    ],
    inspectRoute: `memory action:"candidate" candidateId:"${candidate.id}"`,
    policy: 'Preview is read-only. Every mutation requires current recorded effect admission.',
  };
}

/**
 * A failure after a phase began changing records. It is returned to the agent as a result, not rethrown as a
 * host hold, because the agent must be told what already changed and where the earlier state is kept.
 */
class PartWayError extends Error {}

function causeText(cause: unknown): string {
  if (cause instanceof ToolInputProjectionError) return `the host stopped the call (${cause.problem}).`;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** A phase that failed after its receipt was written: say what is already changed and where the old state is. */
function stoppedPhase(phase: string, receiptId: string, cause: unknown, changedIds: readonly string[]): Error {
  // Nothing changed yet: a host hold is reported as itself.
  if (cause instanceof ToolInputProjectionError && changedIds.length === 0) return cause;
  const changed = changedIds.length > 0 ? `Already changed: ${changedIds.join(', ')}.` : 'No record was changed.';
  return new PartWayError(`${phase} stopped part-way: ${causeText(cause)} ${changed} Receipt ${receiptId} was written first and holds the earlier state; inspect the records before retrying.`);
}

function stoppedRecreate(deleteReceiptId: string, cause: unknown, recreatedIds: readonly string[]): Error {
  if (cause instanceof ToolInputProjectionError && recreatedIds.length === 0) return cause;
  return new PartWayError(`Recreate stopped part-way: ${causeText(cause)} Already recreated: ${recreatedIds.join(', ') || 'none'}. The delete receipt ${deleteReceiptId} is unchanged and still lists every record; inspect current records before retrying.`);
}

async function applyStale(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  candidate: LearningCandidate,
  explicitUserRequest: string,
  beforeWrite: () => void,
  record: (receipt: LearningConsolidationReceipt) => void,
): Promise<Record<string, unknown>> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  const beforeDuplicates = await Promise.all(plan.duplicateIds.map(async (id) => cloneRecord(await getRecord(shellPaths, memory, domain, id))));
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'stale'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    phase: 'stale',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeDuplicates,
  };
  record(receipt);
  const afterDuplicates: Record<string, unknown>[] = [];
  const staled: string[] = [];
  try {
    for (const id of plan.duplicateIds) {
      beforeWrite();
      afterDuplicates.push(await markDuplicateStale(shellPaths, memory, domain, id, plan.survivorId));
      staled.push(id);
    }
  } catch (error) { throw stoppedPhase('stale', receipt.id, error, staled); }
  return {
    status: 'applied',
    phase: 'stale',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt),
    afterDuplicates,
    next: 'Re-run the curator and delete only after current recorded effect admission approves deleting the stale duplicates.',
  };
}

async function applyDelete(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  candidate: LearningCandidate,
  explicitUserRequest: string,
  beforeWrite: () => void,
  record: (receipt: LearningConsolidationReceipt) => void,
): Promise<Record<string, unknown>> {
  const domain = domainForCandidate(candidate);
  const plan = candidate.consolidation;
  if (!plan) throw new Error(`Candidate ${candidate.id} is not a duplicate consolidation candidate.`);
  const beforeDuplicates = await Promise.all(plan.duplicateIds.map(async (id) => cloneRecord(await getRecord(shellPaths, memory, domain, id))));
  const unstaled = beforeDuplicates.filter((record) => record.reviewState !== 'stale').map((record) => String(record.id ?? '(unknown)'));
  if (unstaled.length > 0) {
    throw new Error(`Delete refused. Stage duplicates stale first: ${unstaled.join(', ')}.`);
  }
  if (domain === 'skill') {
    const bundles = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot().bundles;
    const references = plan.duplicateIds.flatMap((duplicateId) => (
      bundles
        .filter((bundle) => bundle.skillIds.includes(duplicateId))
        .map((bundle) => `${duplicateId} in ${bundle.id}`)
    ));
    if (references.length > 0) {
      throw new Error(`Delete refused. Duplicate skill records are still referenced by bundles: ${references.join(', ')}. Inspect or update bundles before deleting.`);
    }
  }
  const receipt: LearningConsolidationReceipt = {
    id: receiptId(candidate, 'delete'),
    createdAt: new Date().toISOString(),
    domain,
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    phase: 'delete',
    explicitUserRequest,
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds,
    beforeDuplicates,
  };
  // The snapshots in this receipt are the only copy of the records, so it exists before the first delete.
  record(receipt);
  const deleted: string[] = [];
  try {
    for (const id of plan.duplicateIds) { beforeWrite(); await deleteDuplicate(shellPaths, memory, domain, id); deleted.push(id); }
  } catch (error) { throw stoppedPhase('delete', receipt.id, error, deleted); }
  return {
    status: 'applied',
    phase: 'delete',
    candidateId: candidate.id,
    judgmentDecisionIds: candidate.judgmentDecisionIds,
    survivorId: plan.survivorId,
    deletedDuplicateIds: plan.duplicateIds,
    receipt: receiptSummary(receipt),
    recreateGuidance: await recreateGuidance(shellPaths, memory, receipt),
    next: 'Deletion is intentionally last. The receipt stores deleted record snapshots and exposes a separate admitted recreate route when exact ids are still safe.',
  };
}

async function applyRecreate(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  args: AgentLearningConsolidationToolArgs,
  explicitUserRequest: string,
  beforeWrite: () => void,
  record: (receipt: LearningConsolidationReceipt) => void,
): Promise<Record<string, unknown>> {
  const deleteReceipt = findDeleteReceipt(shellPaths, args);
  if (deleteReceipt.phase !== 'delete') {
    throw new Error(`Recreate requires a delete receipt. Receipt ${deleteReceipt.id} is phase ${deleteReceipt.phase}.`);
  }
  const guidance = await recreateGuidance(shellPaths, memory, deleteReceipt) as {
    readonly records?: readonly {
      readonly previousId?: string;
      readonly expectedId?: string;
      readonly exactId?: { readonly possible?: boolean; readonly reason?: string };
    }[];
  } | null;
  const records = guidance?.records ?? [];
  const unsafe = records.filter((record) => record.exactId?.possible !== true);
  if (unsafe.length > 0) {
    throw new Error(`Exact-id recreate refused. ${unsafe.map((record) => `${record.previousId ?? '(unknown)'}: ${record.exactId?.reason ?? 'not currently safe'}`).join('; ')}`);
  }

  if (deleteReceipt.domain === 'memory') {
    const memoryRecords = deleteReceipt.beforeDuplicates.map(memoryRecordFromSnapshot);
    const present = await Promise.all(memoryRecords.map(async (record) => await memory.get(record.id) !== null));
    const conflicts = memoryRecords.filter((_record, index) => present[index]).map((record) => record.id);
    if (conflicts.length > 0) throw new Error(`Exact-id recreate refused. Current memory records already use: ${conflicts.join(', ')}.`);
    const bundle: MemoryBundle = {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: 'all',
      recordCount: memoryRecords.length,
      linkCount: 0,
      records: memoryRecords,
      links: [],
    };
    beforeWrite();
    const importResult = await memory.importBundle(bundle);
    if (importResult.importedRecords !== memoryRecords.length) {
      throw new Error(`Recreate imported ${importResult.importedRecords} of ${memoryRecords.length} memory records, so it is not reported as applied. The delete receipt ${deleteReceipt.id} is unchanged; inspect current memory records before retrying.`);
    }
    const recreatedIds = memoryRecords.map((entry) => entry.id);
    let receipt: LearningConsolidationReceipt;
    try {
      beforeWrite();
      receipt = {
        id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
        createdAt: new Date().toISOString(),
        domain: deleteReceipt.domain,
        candidateId: deleteReceipt.candidateId,
        judgmentDecisionIds: deleteReceipt.judgmentDecisionIds,
        phase: 'recreate',
        explicitUserRequest,
        survivorId: deleteReceipt.survivorId,
        duplicateIds: deleteReceipt.duplicateIds,
        beforeDuplicates: deleteReceipt.beforeDuplicates,
      };
      record(receipt);
    } catch (error) { throw stoppedRecreate(deleteReceipt.id, error, recreatedIds); }
    return {
      status: 'applied',
      phase: 'recreate',
      recreatedFromReceiptId: deleteReceipt.id,
      recreatedIds: memoryRecords.map((entry) => entry.id),
      exactIdsPreserved: true,
      importResult,
      receipt: receiptSummary(receipt),
      next: 'Inspect recreated memory records, then re-run the learning curator before applying another consolidation phase.',
    };
  }

  const recreated: Record<string, unknown>[] = [];
  // Recorded as soon as the registry created the record, so a stop before the review state is restored still names it.
  const createdIds: string[] = [];
  try {
    for (const snapshot of deleteReceipt.beforeDuplicates) {
      const previousId = stringField(snapshot, 'id');
      if (!previousId) throw new Error('Delete receipt snapshot is missing id.');
      if (deleteReceipt.domain === 'persona') {
        const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
        beforeWrite();
        const created = registry.create({
          name: stringField(snapshot, 'name') ?? '',
          description: stringField(snapshot, 'description') ?? '',
          body: stringField(snapshot, 'body') ?? '',
          tags: arrayField(snapshot, 'tags'),
          triggers: arrayField(snapshot, 'triggers'),
          source: localRecordSource(snapshot),
          provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
        });
        createdIds.push(created.id);
        if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
        if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); await restoreReviewState(shellPaths, memory, deleteReceipt.domain, created.id, snapshot); }
        recreated.push(cloneRecord(await getRecord(shellPaths, memory, deleteReceipt.domain, created.id)));
      } else if (deleteReceipt.domain === 'skill') {
        const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
        beforeWrite();
        const created = registry.create({
          name: stringField(snapshot, 'name') ?? '',
          description: stringField(snapshot, 'description') ?? '',
          procedure: stringField(snapshot, 'procedure') ?? '',
          tags: arrayField(snapshot, 'tags'),
          triggers: arrayField(snapshot, 'triggers'),
          requirements: requirementsFromSnapshot(snapshot),
          enabled: booleanField(snapshot, 'enabled') === true,
          source: localRecordSource(snapshot),
          provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
        });
        createdIds.push(created.id);
        if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
        if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); await restoreReviewState(shellPaths, memory, deleteReceipt.domain, created.id, snapshot); }
        recreated.push(cloneRecord(await getRecord(shellPaths, memory, deleteReceipt.domain, created.id)));
      } else {
        const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
        beforeWrite();
        const created = registry.create({
          name: stringField(snapshot, 'name') ?? '',
          description: stringField(snapshot, 'description') ?? '',
          steps: stringField(snapshot, 'steps') ?? '',
          tags: arrayField(snapshot, 'tags'),
          triggers: arrayField(snapshot, 'triggers'),
          requirements: requirementsFromSnapshot(snapshot),
          enabled: booleanField(snapshot, 'enabled') === true,
          source: localRecordSource(snapshot),
          provenance: stringField(snapshot, 'provenance') ?? `recreated-from-learning-consolidation:${deleteReceipt.id}`,
        });
        createdIds.push(created.id);
        if (created.id !== previousId) throw new Error(`Exact-id recreate failed for ${previousId}; created ${created.id}.`);
        if (stringField(snapshot, 'reviewState') !== 'fresh') { beforeWrite(); await restoreReviewState(shellPaths, memory, deleteReceipt.domain, created.id, snapshot); }
        recreated.push(cloneRecord(await getRecord(shellPaths, memory, deleteReceipt.domain, created.id)));
      }
    }
  } catch (error) {
    throw stoppedRecreate(deleteReceipt.id, error, createdIds);
  }

  let receipt: LearningConsolidationReceipt;
  try {
    beforeWrite();
    receipt = {
      id: receiptIdFromReceipt(deleteReceipt, 'recreate'),
      createdAt: new Date().toISOString(),
      domain: deleteReceipt.domain,
      candidateId: deleteReceipt.candidateId,
      judgmentDecisionIds: deleteReceipt.judgmentDecisionIds,
      phase: 'recreate',
      explicitUserRequest,
      survivorId: deleteReceipt.survivorId,
      duplicateIds: deleteReceipt.duplicateIds,
      beforeDuplicates: deleteReceipt.beforeDuplicates,
    };
    record(receipt);
  } catch (error) { throw stoppedRecreate(deleteReceipt.id, error, createdIds); }
  return {
    status: 'applied',
    phase: 'recreate',
    recreatedFromReceiptId: deleteReceipt.id,
    recreatedIds: recreated.map((record) => stringField(record, 'id')).filter(Boolean),
    exactIdsPreserved: true,
    recreatedRecords: recreated,
    receipt: receiptSummary(receipt),
    next: 'Inspect recreated records, then re-run the learning curator before applying another consolidation phase.',
  };
}

function findReceipt(shellPaths: ShellPathService, args: AgentLearningConsolidationToolArgs): LearningConsolidationReceipt {
  const receiptIdArg = readString(args.receiptId);
  const candidateId = readString(args.candidateId);
  const receipts = readReceiptFile(shellPaths).receipts;
  const receipt = receiptIdArg
    ? receipts.find((entry) => entry.id === receiptIdArg)
    : receipts.find((entry) => entry.candidateId === candidateId && (entry.phase === 'merge' || entry.phase === 'stale') && !receipts.some((later) => later.phase === 'rollback' && later.rollbackOf === entry.id));
  if (!receipt) throw new Error(receiptIdArg ? `Unknown learning consolidation receipt ${receiptIdArg}` : 'rollback requires receiptId or candidateId with a non-delete receipt.');
  if (receipt.phase === 'recreate' || receipt.phase === 'rollback') {
    throw new Error(`Receipt ${receipt.id} is a ${receipt.phase} receipt; only merge and stale receipts can be rolled back.`);
  }
  const alreadyRolledBack = receipts.find((entry) => entry.phase === 'rollback' && entry.rollbackOf === receipt.id);
  if (alreadyRolledBack) throw new Error(`Receipt ${receipt.id} was already rolled back by ${alreadyRolledBack.id}.`);
  return receipt;
}

function findDeleteReceipt(shellPaths: ShellPathService, args: AgentLearningConsolidationToolArgs): LearningConsolidationReceipt {
  const receiptIdArg = readString(args.receiptId);
  const candidateId = readString(args.candidateId);
  const receipts = readReceiptFile(shellPaths).receipts;
  const receipt = receiptIdArg
    ? receipts.find((entry) => entry.id === receiptIdArg)
    : receipts.find((entry) => entry.candidateId === candidateId && entry.phase === 'delete');
  if (!receipt) throw new Error(receiptIdArg ? `Unknown learning consolidation receipt ${receiptIdArg}` : 'recreate requires receiptId or candidateId with a delete receipt.');
  return receipt;
}

async function applyRollback(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  args: AgentLearningConsolidationToolArgs,
  explicitUserRequest: string,
  beforeWrite: () => void,
  record: (receipt: LearningConsolidationReceipt) => void,
): Promise<Record<string, unknown>> {
  const receipt = findReceipt(shellPaths, args);
  const recordRollback = (): Record<string, unknown> => {
    // Audit trail and the guard against rolling the same receipt back twice. The restore has already happened.
    try {
      record({ id: receiptIdFromReceipt(receipt, 'rollback'), createdAt: new Date().toISOString(), domain: receipt.domain, candidateId: receipt.candidateId,
        phase: 'rollback', explicitUserRequest, survivorId: receipt.survivorId, duplicateIds: receipt.duplicateIds, rollbackOf: receipt.id, beforeDuplicates: [] });
      return {};
    } catch (error) {
      return { auditNote: `The rollback was applied but its receipt could not be written: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  if (receipt.phase === 'delete') {
    throw new Error(`Receipt ${receipt.id} is from a delete phase. Automatic rollback is unavailable after delete; use agent_learning_consolidation mode:"recreate" receiptId:"${receipt.id}"  to recreate deleted records only when the user asks and exact ids are still safe.`);
  }
  if (receipt.phase === 'merge') {
    beforeWrite();
    const restoredSurvivor = await restoreSurvivor(shellPaths, memory, receipt);
    return {
      status: 'applied',
      phase: 'rollback',
      rollbackOf: receiptSummary(receipt),
      restoredSurvivor,
      ...recordRollback(),
      next: 'Re-run the learning curator and inspect the candidate before applying another consolidation phase.',
    };
  }
  // Check every record before restoring any, so a missing one cannot leave a half-restored set.
  const restorable = receipt.beforeDuplicates.flatMap((snapshot) => { const id = stringField(snapshot, 'id'); return id ? [{ id, snapshot }] : []; });
  const gone = await Promise.all(restorable.map(async ({ id }) => { try { await getRecord(shellPaths, memory, receipt.domain, id); return false; } catch { return true; } }));
  const missing = restorable.filter((_entry, index) => gone[index]).map(({ id }) => id);
  if (missing.length > 0) throw new Error(`Rollback refused: ${missing.join(', ')} no longer exist (deleted since). Nothing was restored; use mode:"recreate" with the delete receipt if one exists.`);
  const restored: { readonly id: string; readonly reviewState: string }[] = [];
  for (const { id, snapshot } of restorable) {
    beforeWrite();
    restored.push({ id, reviewState: await restoreReviewState(shellPaths, memory, receipt.domain, id, snapshot) });
  }
  return {
    status: 'applied',
    phase: 'rollback',
    rollbackOf: receiptSummary(receipt),
    restoredDuplicateIds: restorable.map(({ id }) => id),
    restored: 'review state only; content and provenance were left as they are now',
    restoredReviewStates: restored,
    ...recordRollback(),
    next: 'Re-run the learning curator and inspect the candidate before applying another consolidation phase.',
  };
}

function isConsolidationCandidateCall(args: Record<string, unknown>): boolean {
  const mode = readMode(captureCatalogData(args).mode);
  return mode === 'preview' || mode === 'stale' || mode === 'delete';
}

/**
 * `memorySpine` is the process's memory access: once a daemon is adopted it is the
 * single writer of the shared store, so consolidation reads and changes records
 * through it. Without one, the local registry is used directly.
 */
export function createAgentLearningConsolidationTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, registry?: ToolRegistry, memorySpine?: MemoryAccess): Tool {
  const memory: ConsolidationMemory = memorySpine ?? createLocalMemoryAccess(memoryRegistry);
  const tool: Tool = {
    definition: {
      name: 'agent_learning_consolidation',
      activity: { doing: 'Consolidating', did: 'consolidated', object: 'what I learned' },
      description: 'Manage admitted local duplicate learning phases.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'preview, stale, delete, rollback, recreate, or receipts.',
          },
          candidateId: {
            type: 'string',
            description: 'Learning curator duplicate-consolidation candidate id.',
          },
          query: {
            type: 'string',
            description: 'Candidate search text when candidateId is unknown.',
          },
          receiptId: {
            type: 'string',
            description: 'Receipt id for rollback or recreate; with mode receipts, shows that receipt with its recreate guidance.',
          },
          limit: {
            type: 'number',
            description: 'Receipt list limit.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('kept as audit text for the phase'),
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs, options) => {
      const args = captureCatalogData(rawArgs);
      const originalJson = JSON.stringify(args);
      const signal = options?.signal;
      const sourceOwner = agentResearchSourceOwner(registry);
      const workingDirectory = shellPaths.workingDirectory;
      const homeDirectory = shellPaths.homeDirectory;
      const homeReal = realpathSync(homeDirectory);
      const resolveUserPath = shellPaths.resolveUserPath;
      const store = memoryRegistry.getStore();
      const databasePath = store.dbPath;
      const storagePaths = [receiptPath(shellPaths),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'skills', 'skills.json'),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'personas', 'personas.json'),
        shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'routines.json'),
        ...(databasePath ? [databasePath] : [])];
      const assertStorageCurrent = () => {
        if (shellPaths.homeDirectory !== homeDirectory || shellPaths.resolveUserPath !== resolveUserPath
          || realpathSync(homeDirectory) !== homeReal || memoryRegistry.getStore() !== store || store.dbPath !== databasePath) throw new ToolInputProjectionError('stale');
        for (const path of storagePaths) {
          const target = resolveAndValidatePath(path, homeDirectory);
          const parts = relative(homeReal, target).split(sep);
          let component = homeReal;
          for (const part of parts) {
            component = join(component, part);
            if (lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ToolInputProjectionError('held');
          }
        }
      };
      const assertAuthorityCurrent = () => {
        signal?.throwIfAborted(); assertCurrentToolExecution(rawArgs, options); assertStorageCurrent();
        if (options?.signal !== signal || agentResearchSourceOwner(registry) !== sourceOwner
          || shellPaths.workingDirectory !== workingDirectory || JSON.stringify(captureCatalogData(rawArgs)) !== originalJson) throw new ToolInputProjectionError('stale');
      };
      try {
        assertAuthorityCurrent();
        const mode = readMode(args.mode);
        // readMode falls back to preview; an unrecognised value must not quietly become a read.
        if (args.mode !== undefined && args.mode !== null && String(args.mode).trim() !== '' && !(typeof args.mode === 'string' && MODES.includes(args.mode as typeof mode))) {
          return failure(`Unknown mode ${JSON.stringify(String(args.mode)).slice(0, 40)}; nothing was read or changed. Valid values ${MODES.join(', ')}. Duplicates are consolidated with stale, then delete; the survivor is kept as it is.`);
        }
        const receiptSource = () => lstatSync(receiptPath(shellPaths), { throwIfNoEntry: false }) ? readFileSync(receiptPath(shellPaths), 'utf8') : null;
        let receiptsJson = receiptSource();
        const assertReceiptsCurrent = () => {
          if (receiptSource() !== receiptsJson) throw new ToolInputProjectionError('stale');
        };
        const beforeWrite = () => {
          assertAuthorityCurrent(); assertReceiptsCurrent();
          if (mode !== 'stale' && mode !== 'delete' && mode !== 'rollback' && mode !== 'recreate') throw new ToolInputProjectionError('held');
          requireConfirmedWrite(rawArgs, mode, options);
        };
        // Writing a receipt changes the file this call watches for outside edits, so the baseline moves with it.
        const record = (receipt: LearningConsolidationReceipt) => {
          beforeWrite(); writeReceipt(shellPaths, receipt); receiptsJson = receiptSource();
        };
        if (mode === 'receipts') {
          // `total` and the note exist because the default page is 20 and the
          // receipt file holds far more: without them, "here are the receipts"
          // reads as the whole rollback history when it is the newest slice.
          const stored = readReceiptFile(shellPaths).receipts;
          const wanted = readString(args.receiptId);
          if (wanted) {
            const receipt = stored.find((entry) => entry.id === wanted);
            if (!receipt) return failure(`Unknown learning consolidation receipt ${wanted}. List them with mode:"receipts".`);
            const deleteRecovery = await recreateGuidance(shellPaths, memory, receipt);
            return output({ status: 'receipt', receipt: receiptSummary(receipt), ...(deleteRecovery ? { deleteRecovery } : {}) });
          }
          const page = stored.slice(0, readLimit(args.limit, 20));
          return output({
            status: 'receipts',
            receipts: page.map(receiptSummary),
            returned: page.length,
            total: stored.length,
            ...(page.length < stored.length
              ? { note: `Showing the ${page.length} newest of ${stored.length} receipts; raise limit (at most 100) to see older ones.` }
              : {}),
          });
        }
        if (mode === 'rollback') {
          const explicitUserRequest = requireConfirmedWrite(rawArgs, mode, options);
          return output(await applyRollback(shellPaths, memory, args, explicitUserRequest, beforeWrite, record));
        }
        if (mode === 'recreate') {
          const explicitUserRequest = requireConfirmedWrite(rawArgs, mode, options);
          return output(await applyRecreate(shellPaths, memory, args, explicitUserRequest, beforeWrite, record));
        }
        const candidateGuards = new Map<string | (() => void), () => void>();
        const candidate = await resolveCandidate(shellPaths, memory, args, {
          signal, sourceOwner, assertCurrent: () => { assertAuthorityCurrent(); assertReceiptsCurrent(); },
          retainCurrent(guard, key) { if (!candidateGuards.has(key ?? guard)) candidateGuards.set(key ?? guard, guard); },
        });
        assertAuthorityCurrent(); assertReceiptsCurrent();
        // Check the complete retained source immediately before the phase.
        // The authorized phase itself changes that collection, so publication
        // continues to check authority rather than the pre-write revision.
        for (const guard of candidateGuards.values()) guard();
        if (mode === 'preview') return output(previewCandidate(candidate));
        if (mode !== 'stale' && mode !== 'delete') throw new ToolInputProjectionError('held');
        const explicitUserRequest = requireConfirmedWrite(rawArgs, mode, options);
        if (mode === 'stale') return output(await applyStale(shellPaths, memory, candidate, explicitUserRequest, beforeWrite, record));
        return output(await applyDelete(shellPaths, memory, candidate, explicitUserRequest, beforeWrite, record));
      } catch (error) {
        // Records already changed: the account of what changed matters more than which check failed.
        if (error instanceof PartWayError) return failure(error.message);
        assertAuthorityCurrent();
        if (error instanceof ToolInputProjectionError) throw error;
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
  return registry ? protectHarnessCatalogTool(tool, registry, isConsolidationCandidateCall) : tool;
}

export function registerAgentLearningConsolidationTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  memoryRegistry: MemoryRegistry,
  memorySpine?: MemoryAccess,
): void {
  registry.register(createAgentLearningConsolidationTool(shellPaths, memoryRegistry, registry, memorySpine), { inputProjection: createHarnessCatalogInputProjector(registry, undefined, isConsolidationCandidateCall) });
}
