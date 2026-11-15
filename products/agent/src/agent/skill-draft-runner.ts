import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { readJsonStore, runStoreFileUpdateSync, writeJsonStore, type JsonStoreSpec } from '@/utils/store-file.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CatalogRankingOptions } from '../tools/agent-harness-catalog-ranking.ts';
import { type LearningCandidateCollection, type LearningCuratorNativeContext } from '../tools/agent-harness-learning-curator-source.ts';
import { buildLearningCandidates, assertLearningCandidateCollection } from '../tools/agent-harness-learning-curator-proposals.ts';
import { AgentSkillRegistry, skillStorePath } from './skill-registry.ts';
import { proposeSkillDrafts } from './skill-draft-proposer.ts';

// ---------------------------------------------------------------------------
// Ledger types
// ---------------------------------------------------------------------------

export interface SkillDraftLedgerEntry {
  /** Stable ledger entry id, matches the persisted skill id assigned by the registry. */
  readonly skillId: string;
  /** Kebab-slug name of the proposed skill. */
  readonly name: string;
  /** Learning candidate that originated this proposal. */
  readonly candidateId: string;
  /** ISO timestamp when the draft was proposed. */
  readonly proposedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedgerEntry(value: unknown): SkillDraftLedgerEntry | null {
  if (!isRecord(value)) return null;
  const { skillId, name, candidateId, proposedAt } = value;
  if (typeof skillId !== 'string' || typeof name !== 'string' || typeof candidateId !== 'string' || typeof proposedAt !== 'string') return null;
  return { skillId, name, candidateId, proposedAt };
}

/**
 * The ledger of drafts already proposed, so a later pass does not propose the
 * same candidate again. An entry this build cannot read is kept as found, and a
 * file that is not JSON is copied aside before it is replaced (the store helper).
 */
const LEDGER_STORE: JsonStoreSpec<SkillDraftLedgerEntry> = {
  label: 'skill draft ledger',
  entriesKey: 'entries',
  version: 1,
  parseEntry: parseLedgerEntry,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SkillDraftRunResult {
  /** Number of new draft skills persisted this pass. */
  readonly proposed: number;
  /** Number of candidates that were eligible but skipped (dedup / secret). */
  readonly skipped: number;
  /** Entries written to the ledger this pass. */
  readonly entries: readonly SkillDraftLedgerEntry[];
  /** Skill ids created this pass. */
  readonly skillIds: readonly string[];
}

/** The pass's caller is still current: its signal has not fired and its own check passes. */
export function assertSkillDraftRunResultCurrent(
  _result: SkillDraftRunResult,
  _context: LearningCuratorNativeContext,
  options: CatalogRankingOptions,
): void {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
}

/** The ledger sits beside the skill store: `.../skills/skill-draft-ledger.json`. */
function ledgerPathFor(skillStore: string): string {
  return skillStore.replace(/skills\.json$/, 'skill-draft-ledger.json');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Create disabled drafts from the curator's candidates. The ledger's lock is
 * held for the whole write phase, so two passes take turns and the ledger and
 * the skill list are each read once; the caller is checked once before the
 * first write and once before the ledger write. Each create goes through the
 * candidate collection's transition, which checks the learning source right
 * before the skill file is replaced.
 */
export async function runSkillDraftProposer(
  context: LearningCuratorNativeContext,
  registry: AgentSkillRegistry,
  options: CatalogRankingOptions,
  suppliedCollection?: LearningCandidateCollection,
): Promise<SkillDraftRunResult> {
  const caller = options.assertCurrent;
  if (typeof caller !== 'function') throw new ToolInputProjectionError('unavailable');
  const assertCaller = () => { options.signal?.throwIfAborted(); caller(); };
  assertCaller();
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) throw new ToolInputProjectionError('unavailable');
  const collection = suppliedCollection ?? await buildLearningCandidates(context, options);
  assertLearningCandidateCollection(collection, context, options);

  return runStoreFileUpdateSync(ledgerPathFor(skillStorePath(shellPaths)), () => {
    const skills = registry.snapshot();
    // The registry handed in must be this workspace's store, or the drafts and their ledger would part.
    if (skills.path !== skillStorePath(shellPaths)) throw new ToolInputProjectionError('stale');
    const ledgerPath = ledgerPathFor(skills.path);
    const ledger = readJsonStore(ledgerPath, LEDGER_STORE);
    if (ledger.newerVersion !== undefined) {
      // Refused before any draft is created, so no skill is left without its ledger entry.
      throw new Error(`The skill draft ledger at ${ledgerPath} was written by a newer GoodVibes (file version ${ledger.newerVersion}), so no drafts were proposed. Update GoodVibes, then retry.`);
    }
    const eligibleCount = collection.candidates.filter(candidate =>
      (candidate.status === 'proposal-ready' || candidate.status === 'ready-to-promote')
        && candidate.proposalTarget === 'skill').length;
    const drafts = proposeSkillDrafts({
      candidates: collection.candidates,
      existingSkillNames: new Set(skills.skills.map(skill => skill.name.trim().toLowerCase())),
      previouslyProposedNames: new Set(ledger.entries.map(entry => entry.name.trim().toLowerCase())),
      previouslyProposedCandidateIds: new Set(ledger.entries.map(entry => entry.candidateId)),
    });
    const newEntries: SkillDraftLedgerEntry[] = [];
    const writeLedger = () => writeJsonStore(ledger, LEDGER_STORE, { entries: [...ledger.entries, ...newEntries] });
    if (drafts.length > 0) assertCaller();
    try {
      for (const draft of drafts) {
        const input = {
          name: draft.name, description: draft.description, procedure: draft.procedure,
          triggers: draft.triggers, tags: draft.tags, requirements: draft.requirements,
          enabled: false, source: 'agent', provenance: draft.provenance,
        } satisfies Parameters<AgentSkillRegistry['create']>[0];
        const transition = collection.prepareTransition({ kind: 'create', domain: 'skill', input });
        let checkFailed = false;
        let published = false;
        try {
          const writer = AgentSkillRegistry.fromShellPaths(shellPaths, {
            assertCurrent: () => {
              try { transition.effects.assertCurrent(); } catch (error) { checkFailed = true; throw error; }
            },
            onEffect: publication => {
              if (publication === true) published = true;
              try { transition.effects.onEffect?.(publication); } catch (error) { checkFailed = true; throw error; }
            },
          });
          const skill = writer.create(input);
          newEntries.push({ skillId: skill.id, name: skill.name, candidateId: draft.candidateId, proposedAt: new Date().toISOString() });
          transition.commit(skill);
        } catch (error) {
          transition.abort();
          if (published && !newEntries.some(entry => entry.candidateId === draft.candidateId)) {
            // The file was replaced before a check failed: record the skill so no later pass drafts it again.
            const created = AgentSkillRegistry.fromShellPaths(shellPaths).get(draft.name);
            if (created && created.provenance === draft.provenance) {
              newEntries.push({ skillId: created.id, name: created.name, candidateId: draft.candidateId, proposedAt: new Date().toISOString() });
            }
          }
          // Only a draft the registry refused before writing anything (a secret-like
          // field, a clashing name) is skipped; anything else ends the pass.
          if (published || checkFailed || error instanceof ToolInputProjectionError || options.signal?.aborted) throw error;
          logger.info('Skill draft skipped: the skill store refused it', { name: draft.name, error: summarizeError(error) });
        }
      }
      if (newEntries.length > 0) assertCaller();
    } catch (error) {
      // Skills created before the failure exist; their ledger entries are written
      // so a later pass does not propose them again. The original error is reported.
      if (newEntries.length > 0) {
        try { writeLedger(); } catch (ledgerError) {
          logger.error('Skill draft ledger could not record skills created before the pass failed', {
            path: ledgerPath, skillIds: newEntries.map(entry => entry.skillId), error: summarizeError(ledgerError),
          });
        }
      }
      throw error;
    }
    if (newEntries.length > 0) writeLedger();
    return {
      proposed: newEntries.length,
      skipped: eligibleCount - newEntries.length,
      entries: newEntries,
      skillIds: newEntries.map(entry => entry.skillId),
    };
  });
}

// ---------------------------------------------------------------------------
// Ledger read helper, for harness tool inspection
// ---------------------------------------------------------------------------

/**
 * Read the current ledger for inspection without running a proposal pass.
 */
export function readSkillDraftLedger(registry: AgentSkillRegistry): readonly SkillDraftLedgerEntry[] {
  return readJsonStore(ledgerPathFor(registry.snapshot().path), LEDGER_STORE).entries;
}
