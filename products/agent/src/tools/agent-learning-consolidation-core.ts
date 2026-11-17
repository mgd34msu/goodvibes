import { existsSync, readFileSync } from 'node:fs';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { runStoreFileUpdateSync, writeStoreJson } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import type { MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentPersonaRegistry, type AgentPersonaRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentRoutineRegistry, type AgentRoutineRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentSkillRegistry, type AgentSkillRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import {
  resolveLearningConsolidationCandidate,
  type LearningCandidate,
  type LearningConsolidationFields,
} from './agent-harness-learning-curator.ts';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';
import { clampReadLimit } from './agent-harness-read-helpers.ts';
import { readString } from './tool-args.ts';

export type AgentLearningConsolidationMode = 'preview' | 'stale' | 'delete' | 'rollback' | 'recreate' | 'receipts';
export type AgentLearningConsolidationDomain = 'memory' | 'persona' | 'skill' | 'routine';
export type AgentLearningConsolidationWriteMode = 'stale' | 'delete' | 'rollback' | 'recreate';
/** A stored receipt can also come from the merge phase, which no longer runs but whose receipts can still be rolled back. */
export type AgentLearningConsolidationReceiptPhase = AgentLearningConsolidationWriteMode | 'merge';

export interface AgentLearningConsolidationToolArgs {
  readonly mode?: unknown;
  readonly candidateId?: unknown;
  readonly query?: unknown;
  readonly receiptId?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface LearningConsolidationReceipt {
  readonly judgmentDecisionIds?: readonly string[] | undefined;
  readonly id: string;
  readonly createdAt: string;
  readonly domain: AgentLearningConsolidationDomain;
  readonly candidateId: string;
  readonly phase: AgentLearningConsolidationReceiptPhase;
  readonly explicitUserRequest: string;
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly beforeSurvivor?: Record<string, unknown>;
  /** Merge only: the survivor as the merge left it, so a rollback can tell whether it was edited since. */
  readonly afterSurvivor?: Record<string, unknown>;
  /** Rollback receipts: the receipt that was rolled back. */
  readonly rollbackOf?: string;
  readonly beforeDuplicates: readonly Record<string, unknown>[];
}

export interface LearningConsolidationReceiptFile {
  readonly version: 1;
  readonly receipts: readonly LearningConsolidationReceipt[];
  /** Entries this build does not recognise, kept verbatim so a rewrite never erases them. */
  readonly preserved?: readonly unknown[];
}

export const MODES: readonly AgentLearningConsolidationMode[] = ['preview', 'stale', 'delete', 'rollback', 'recreate', 'receipts'];
export const RECEIPT_LIMIT = 100;
export const MEMORY_CLASSES = new Set(['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership']);
export const MEMORY_SCOPES = new Set(['session', 'project', 'team']);
export const MEMORY_REVIEW_STATES = new Set(['fresh', 'reviewed', 'stale', 'contradicted']);

export { readString };

export function readMode(value: unknown): AgentLearningConsolidationMode {
  return typeof value === 'string' && MODES.includes(value as AgentLearningConsolidationMode)
    ? value as AgentLearningConsolidationMode
    : 'preview';
}

export function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, RECEIPT_LIMIT);
}

function slugifyForDomain(value: string, fallback: AgentLearningConsolidationDomain): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function nextGeneratedId(name: string, occupiedIds: Set<string>, fallback: AgentLearningConsolidationDomain): string {
  const base = slugifyForDomain(name, fallback);
  if (!occupiedIds.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!occupiedIds.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate ${fallback} id for ${name}.`);
}

export function output(value: unknown): { readonly success: true; readonly output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}

export function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function requireConfirmedWrite(args: Record<string, unknown>, mode: AgentLearningConsolidationWriteMode, options: Parameters<Tool['execute']>[1]): string {
  if (!harnessCatalogInvocationAuthority(args, options, 'write')) throw new Error(`${mode} requires current recorded effect admission.`);
  return readString(args.explicitUserRequest) || `Recorded effect admission for ${mode}.`;
}

function isDomain(value: string): value is AgentLearningConsolidationDomain {
  return value === 'memory' || value === 'persona' || value === 'skill' || value === 'routine';
}

export function receiptPath(shellPaths: ShellPathService): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json');
}

function parseReceipt(value: unknown): LearningConsolidationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const createdAt = readString(record.createdAt);
  const domain = readString(record.domain);
  const candidateId = readString(record.candidateId);
  const phase = readString(record.phase);
  const explicitUserRequest = readString(record.explicitUserRequest);
  const survivorId = readString(record.survivorId);
  const duplicateIds = Array.isArray(record.duplicateIds)
    ? record.duplicateIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const beforeDuplicates = Array.isArray(record.beforeDuplicates)
    ? record.beforeDuplicates.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
  if (
    !id
    || !createdAt
    || !isDomain(domain)
    || !candidateId
    || !['merge', 'stale', 'delete', 'rollback', 'recreate'].includes(phase)
    || !explicitUserRequest
    || !survivorId
  ) return null;
  const beforeSurvivor = typeof record.beforeSurvivor === 'object' && record.beforeSurvivor !== null && !Array.isArray(record.beforeSurvivor)
    ? record.beforeSurvivor as Record<string, unknown>
    : undefined;
  const afterSurvivor = typeof record.afterSurvivor === 'object' && record.afterSurvivor !== null && !Array.isArray(record.afterSurvivor)
    ? record.afterSurvivor as Record<string, unknown>
    : undefined;
  const rollbackOf = readString(record.rollbackOf);
  return {
    id,
    createdAt,
    domain,
    candidateId,
    phase: phase as AgentLearningConsolidationReceiptPhase,
    explicitUserRequest,
    survivorId,
    duplicateIds,
    ...(beforeSurvivor ? { beforeSurvivor } : {}),
    ...(afterSurvivor ? { afterSurvivor } : {}),
    ...(rollbackOf ? { rollbackOf } : {}),
    beforeDuplicates,
    ...(Array.isArray(record.judgmentDecisionIds) ? { judgmentDecisionIds: record.judgmentDecisionIds.filter((id): id is string => typeof id === 'string') } : {}),
  };
}

/**
 * A missing file is an empty history. A file that exists but cannot be read is
 * an error, never an empty history: the next write would replace it, erasing
 * every receipt (delete receipts hold the only copy of deleted records).
 */
export function readReceiptFile(shellPaths: ShellPathService): LearningConsolidationReceiptFile {
  const path = receiptPath(shellPaths);
  if (!existsSync(path)) return { version: 1, receipts: [] };
  const unreadable = (why: string) => new Error(`The learning consolidation receipts file is unreadable (${why}). It was left unchanged; repair or move it so recorded history is not lost.`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { throw unreadable('not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadable('not a receipts object');
  const entries = (parsed as Record<string, unknown>).receipts;
  if (entries === undefined) return { version: 1, receipts: [] };
  if (!Array.isArray(entries)) throw unreadable('receipts is not a list');
  const receipts: LearningConsolidationReceipt[] = [];
  const preserved: unknown[] = [];
  for (const entry of entries as unknown[]) {
    const receipt = parseReceipt(entry);
    if (receipt) receipts.push(receipt); else preserved.push(entry);
  }
  return { version: 1, receipts, ...(preserved.length > 0 ? { preserved } : {}) };
}

/**
 * The newest RECEIPT_LIMIT receipts, plus every delete receipt older than that
 * which has not been recreated: it is the only copy of the deleted records.
 */
function retainReceipts(newestFirst: readonly LearningConsolidationReceipt[]): LearningConsolidationReceipt[] {
  // Candidate ids repeat when the same duplicate is staged again, so a recreate only answers the deletes recorded before it.
  const newestRecreate = new Map<string, number>();
  newestFirst.forEach((entry, index) => { if (entry.phase === 'recreate' && !newestRecreate.has(entry.candidateId)) newestRecreate.set(entry.candidateId, index); });
  return [
    ...newestFirst.slice(0, RECEIPT_LIMIT),
    ...newestFirst.slice(RECEIPT_LIMIT).filter((entry, offset) => {
      if (entry.phase !== 'delete') return false;
      const recreatedAt = newestRecreate.get(entry.candidateId);
      return recreatedAt === undefined || recreatedAt > offset + RECEIPT_LIMIT;
    }),
  ];
}

/**
 * One locked read-modify-write, like the registries beside it: delete receipts
 * hold the only copy of deleted records, so two Agent processes must not drop
 * each other's receipt.
 */
export function writeReceipt(shellPaths: ShellPathService, receipt: LearningConsolidationReceipt): void {
  const path = receiptPath(shellPaths);
  runStoreFileUpdateSync(path, () => {
    const current = readReceiptFile(shellPaths);
    writeStoreJson(path, {
      version: 1,
      // Unrecognised entries stay in the same list, after the readable ones, so the next read finds them again.
      receipts: [...retainReceipts([receipt, ...current.receipts.filter((entry) => entry.id !== receipt.id)]), ...(current.preserved ?? [])],
    });
  });
}

export function receiptId(candidate: LearningCandidate, phase: AgentLearningConsolidationWriteMode): string {
  const slug = candidate.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'candidate';
  return `lcon-${phase}-${Date.now().toString(36)}-${slug}`;
}

export function receiptIdFromReceipt(receipt: LearningConsolidationReceipt, phase: AgentLearningConsolidationWriteMode): string {
  const slug = receipt.candidateId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'receipt';
  return `lcon-${phase}-${Date.now().toString(36)}-${slug}`;
}

/**
 * The memory verbs consolidation uses. Handed the process's memory spine so an
 * adopted daemon, which is the single writer of the shared store, is the one
 * that reads and changes the records; the local store is not touched then.
 */
export type ConsolidationMemory = Pick<MemoryAccess, 'get' | 'update' | 'updateReview' | 'delete' | 'list' | 'importBundle'>;

/**
 * The candidate reader is synchronous, so it is given the records read through
 * the spine just now, not the boot-time local image.
 */
async function minimalContext(shellPaths: ShellPathService, memory: ConsolidationMemory): Promise<CommandContext> {
  const records = await memory.list();
  return {
    workspace: { shellPaths },
    clients: { agentKnowledgeApi: { memory: { getAll: () => records, get: (id: string) => records.find((record) => record.id === id) ?? null } } },
  } as unknown as CommandContext;
}

export async function resolveCandidate(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  args: AgentLearningConsolidationToolArgs,
  options: CatalogRankingOptions = {},
): Promise<LearningCandidate> {
  const input = readString(args.candidateId) || readString(args.query);
  const resolved = await resolveLearningConsolidationCandidate(await minimalContext(shellPaths, memory), input, options);
  if (resolved.status === 'found') return resolved.candidate;
  if (resolved.status === 'ambiguous') {
    throw new Error(`Ambiguous learning consolidation candidate ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  }
  throw new Error(resolved.usage);
}

export function domainForCandidate(candidate: LearningCandidate): AgentLearningConsolidationDomain {
  const domain = String(candidate.domain);
  if (!isDomain(domain)) throw new Error(`Candidate ${candidate.id} is not an applyable consolidation domain.`);
  return domain;
}

export function cloneRecord(record: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

export async function getRecord(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  domain: AgentLearningConsolidationDomain,
  id: string,
): Promise<MemoryRecord | AgentPersonaRecord | AgentSkillRecord | AgentRoutineRecord> {
  if (domain === 'memory') {
    const record = await memory.get(id);
    if (!record) throw new Error(`Unknown Agent-local memory ${id}`);
    return record;
  }
  if (domain === 'persona') {
    const record = AgentPersonaRegistry.fromShellPaths(shellPaths).get(id);
    if (!record) throw new Error(`Unknown Agent-local persona ${id}`);
    return record;
  }
  if (domain === 'skill') {
    const record = AgentSkillRegistry.fromShellPaths(shellPaths).get(id);
    if (!record) throw new Error(`Unknown Agent-local skill ${id}`);
    return record;
  }
  const record = AgentRoutineRegistry.fromShellPaths(shellPaths).get(id);
  if (!record) throw new Error(`Unknown Agent-local routine ${id}`);
  return record;
}

export async function updateSurvivor(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  domain: AgentLearningConsolidationDomain,
  survivorId: string,
  fields: LearningConsolidationFields,
  /** A rollback passes the provenance the record had before the merge; a merge stamps its own. */
  provenance = 'learning-curator-consolidation',
): Promise<Record<string, unknown>> {
  if (domain === 'memory') {
    const record = await memory.update(survivorId, {
      ...(fields.detail === undefined ? {} : { detail: fields.detail }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    });
    if (!record) throw new Error(`Unknown Agent-local memory ${survivorId}`);
    return cloneRecord(record);
  }
  if (domain === 'persona') {
    const record = AgentPersonaRegistry.fromShellPaths(shellPaths).update(survivorId, {
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
      ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
      provenance,
    });
    return cloneRecord(record);
  }
  if (domain === 'skill') {
    const record = AgentSkillRegistry.fromShellPaths(shellPaths).update(survivorId, {
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
      ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
      provenance,
    });
    return cloneRecord(record);
  }
  const record = AgentRoutineRegistry.fromShellPaths(shellPaths).update(survivorId, {
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.tags === undefined ? {} : { tags: [...fields.tags] }),
    ...(fields.triggers === undefined ? {} : { triggers: [...fields.triggers] }),
    provenance,
  });
  return cloneRecord(record);
}

export async function markDuplicateStale(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  domain: AgentLearningConsolidationDomain,
  duplicateId: string,
  survivorId: string,
  judgmentDecisionIds: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const reason = `Duplicate of ${survivorId}; staged by learning curator consolidation. Jev decisions=${judgmentDecisionIds.join(',')}`;
  if (domain === 'memory') {
    const record = await memory.updateReview(duplicateId, { state: 'stale', staleReason: reason, reviewedBy: 'agent' });
    if (!record) throw new Error(`Unknown Agent-local memory ${duplicateId}`);
    return cloneRecord(record);
  }
  if (domain === 'persona') return cloneRecord(AgentPersonaRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
  if (domain === 'skill') return cloneRecord(AgentSkillRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
  return cloneRecord(AgentRoutineRegistry.fromShellPaths(shellPaths).markStale(duplicateId, reason));
}

export async function deleteDuplicate(
  shellPaths: ShellPathService,
  memory: ConsolidationMemory,
  domain: AgentLearningConsolidationDomain,
  duplicateId: string,
): Promise<void> {
  if (domain === 'memory') {
    if (!await memory.delete(duplicateId)) throw new Error(`Unknown Agent-local memory ${duplicateId}`);
    return;
  }
  if (domain === 'persona') {
    AgentPersonaRegistry.fromShellPaths(shellPaths).deletePersona(duplicateId);
    return;
  }
  if (domain === 'skill') {
    AgentSkillRegistry.fromShellPaths(shellPaths).deleteSkill(duplicateId);
    return;
  }
  AgentRoutineRegistry.fromShellPaths(shellPaths).deleteRoutine(duplicateId);
}
