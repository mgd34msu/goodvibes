/**
 * recall-files.ts, `/recall files sync|review|apply`, the git-backed markdown
 * projection of standing (project/team-scope) memory records.
 *
 *   sync  , write each record to `<dir>/<id>.md` and commit the directory in its
 *           own repository. Reads the store, writes only the directory.
 *   review, diff the directory against the store and print proposals. Writes nothing.
 *   apply , re-diff, then change the store ONLY for the proposal ids named (or
 *           --all). A file edit or deletion never changes the store by itself.
 *
 * Reads and writes go through the memory spine, so with a daemon attached they
 * act on the daemon's store. A model-run command may sync (it writes only the
 * projection directory inside the workspace, committed in its own repository,
 * so every change can be undone) and review, but not apply: apply turns file
 * contents, which anything that writes the workspace can change, into memory
 * records, which is the owner's decision.
 */
import { existsSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import {
  diffProjectionToProposals,
  findOrphanedProjectionFiles,
  createMemoryProjectionGit,
  projectMemoryToFiles,
  readProjectedMemoryFiles,
  type MemoryProjectionFile,
  type MemoryProjectionProposal,
} from '@goodvibes-jev/engine/platform/platform/state';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { resolveCommandFilePath } from './agent-local-library-args.ts';
import { getMemorySpine as findMemorySpine } from './recall-query.ts';
import { commandRefusal } from './confirmation.ts';

/** Relative to the project working directory, inside the project's own control directory. */
const MEMORY_PROJECTION_DIR_DEFAULT = '.goodvibes/memory/projection';
const PROJECTION_LIST_LIMIT = 5000;

/** The list is capped, so at the cap some records are not in the projection or the diff; say so instead of looking complete. */
function warnIfTruncated(context: CommandContext, count: number): void {
  if (count >= PROJECTION_LIST_LIMIT) {
    context.print(`[memory] Warning: the store returned ${count} records, the most this command reads; any further records are not projected or compared.`);
  }
}

/** Resolve the projection directory: an explicit --dir argument wins, else the default. Null (already printed) when a model-run command names a place outside the workspace. */
function resolveProjectionDir(args: string[], context: CommandContext, purpose: 'read' | 'write'): string | null {
  const dirIdx = args.indexOf('--dir');
  const explicit = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
  return resolveCommandFilePath(context, explicit || MEMORY_PROJECTION_DIR_DEFAULT, purpose);
}

function getMemorySpine(context: CommandContext): ReturnType<typeof findMemorySpine> {
  const memory = findMemorySpine(context);
  if (!memory) context.print('[memory] The memory spine is not available in this runtime, so nothing was read or changed.');
  return memory;
}

/** True (after printing why) when the model ran a verb that only the owner may start. */
function refuseWhenModelRun(verb: string, effect: string, context: CommandContext): boolean {
  if (context.invokedByModel !== true) return false;
  throw commandRefusal(`Refused: /memory files ${verb} ${effect}, so it only counts when you type it yourself. Nothing was changed. /memory files sync and review are open to the model.`);
}

export async function handleRecallFilesSync(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) return;

  const dir = resolveProjectionDir(args, context, 'write');
  if (dir === null) return;
  const records = await memory.list({ limit: PROJECTION_LIST_LIMIT });
  warnIfTruncated(context, records.length);

  try {
    // The platform's ownership gate commits only to a repository whose toplevel IS
    // the projection directory (initializing one there when needed), never
    // to a checkout the directory merely sits inside.
    const report = projectMemoryToFiles(records, dir, { git: createMemoryProjectionGit() });
    context.print(`[memory] Projected ${report.written.length} record(s) to ${report.dir}`);
    if (report.kept && report.kept.length > 0) {
      context.print(`[memory] Kept ${report.kept.length} edited or deleted file(s) as they are: ${report.kept.join(', ')}. Run /memory files review to see them, then apply to take them into the store. A changed cls, confidence or reviewState line is read-only and has no proposal: change it back by hand so sync can refresh the file.`);
    }
    if (report.removed && report.removed.length > 0) {
      context.print(`[memory] Removed ${report.removed.length} file(s) whose record was deleted from the store: ${report.removed.join(', ')}.`);
    }
    if (report.orphaned && report.orphaned.length > 0) {
      context.print(`[memory] Kept ${report.orphaned.length} file(s) whose record was deleted in the store because you edited them: ${report.orphaned.join(', ')}. Their edits cannot reach the store; delete the files, or add the memory again.`);
    }
    context.print(report.committed
      ? `  committed in ${report.dir} (the projection's own repository)`
      : report.kept && report.kept.length > 0 && report.written.length === 0 && !report.removed
        ? '  nothing to commit (no file was written)'
        : '  not committed (the directory is unchanged or git did not run)');
  } catch (error) {
    throw commandRefusal(`[memory] Projection sync failed: ${summarizeError(error)}`);
  }
}

/**
 * Compute the current proposals for `dir` against the live store, and the files
 * whose record no longer exists. Returns null (already printed) when the
 * directory doesn't exist yet.
 */
async function computeProposals(
  dir: string,
  context: CommandContext,
): Promise<{ readonly proposals: MemoryProjectionProposal[]; readonly orphans: MemoryProjectionFile[] } | null> {
  const memory = getMemorySpine(context);
  if (!memory) return null;
  if (!existsSync(dir)) {
    context.print(`[memory] No projection directory at ${dir}. Run /memory files sync first.`);
    return null;
  }
  const records = await memory.list({ limit: PROJECTION_LIST_LIMIT });
  warnIfTruncated(context, records.length);
  const files = readProjectedMemoryFiles(dir);
  return { proposals: diffProjectionToProposals(records, files), orphans: findOrphanedProjectionFiles(records, files) };
}

function printProposal(context: CommandContext, proposal: MemoryProjectionProposal): void {
  context.print(`  ${proposal.id} [${proposal.kind}] ${proposal.reason}`);
  if (proposal.kind === 'update' && proposal.changedFields && proposal.changedFields.length > 0) {
    context.print(`    changed: ${proposal.changedFields.join(', ')}`);
  }
}

export async function handleRecallFilesReview(args: string[], context: CommandContext): Promise<void> {
  const dir = resolveProjectionDir(args, context, 'read');
  if (dir === null) return;
  const computed = await computeProposals(dir, context);
  if (computed === null) return;
  const { proposals, orphans } = computed;

  if (orphans.length > 0) {
    context.print(`[memory] ${orphans.length} orphan file(s) in ${dir}, record no longer exists:`);
    for (const orphan of orphans) context.print(`  orphan: ${orphan.id} (${orphan.path})`);
    context.print('[memory] An edit to an orphan cannot reach the store. Delete the file, or add the memory again.');
  }
  if (proposals.length === 0) {
    if (orphans.length > 0) return;
    context.print(`[memory] No changes: ${dir} matches the store.`);
    return;
  }
  context.print(`[memory] ${proposals.length} proposal(s) from ${dir}:`);
  for (const proposal of proposals) printProposal(context, proposal);
  context.print('[memory] Nothing has been applied. Run /memory files apply <id> [<id> ...] | --all to confirm.');
}

export async function handleRecallFilesApply(args: string[], context: CommandContext): Promise<void> {
  if (refuseWhenModelRun('apply', 'changes or deletes memory records from file edits', context)) return;
  const memory = getMemorySpine(context);
  if (!memory) return;

  const applyAll = args.includes('--all') || args.includes('all');
  const ids = new Set(args.filter((a) => a !== '--all' && a !== 'all' && a !== '--dir' && !a.startsWith('.') && !a.startsWith('/')));
  // --dir's value (the token right after it) is not a proposal id, drop it.
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) ids.delete(args[dirIdx + 1]!);

  if (!applyAll && ids.size === 0) {
    context.print('[memory] Usage: /memory files apply <id> [<id> ...] | --all [--dir <path>]');
    context.print('[memory] Run /memory files review first to see the current proposal ids.');
    return;
  }

  const dir = resolveProjectionDir(args, context, 'read');
  if (dir === null) return;
  const computed = await computeProposals(dir, context);
  if (computed === null) return;
  const { proposals } = computed;

  const targeted = applyAll ? proposals : proposals.filter((p) => ids.has(p.id));
  if (targeted.length === 0) {
    context.print('[memory] No matching proposals. Run /memory files review to see the current list.');
    return;
  }
  const targetedIds = new Set(targeted.map((p) => p.id));

  const applied: MemoryProjectionProposal[] = [];
  const skipped: MemoryProjectionProposal[] = [];
  const failed: { proposal: MemoryProjectionProposal; reason: string }[] = [];

  for (const proposal of proposals) {
    if (!targetedIds.has(proposal.id)) {
      skipped.push(proposal);
      continue;
    }
    try {
      if (proposal.kind === 'delete') {
        const ok = await memory.delete(proposal.id);
        if (ok) applied.push(proposal);
        else failed.push({ proposal, reason: 'store delete returned false (record already gone?)' });
        continue;
      }
      const desired = proposal.desired ?? {};
      const patch: {
        scope?: typeof desired.scope;
        summary?: string;
        detail?: string;
        tags?: string[];
        validFrom?: number | null;
        validUntil?: number | null;
      } = {};
      if (desired.scope !== undefined) patch.scope = desired.scope;
      if (desired.summary !== undefined) patch.summary = desired.summary;
      if (desired.detail !== undefined) patch.detail = desired.detail;
      if (desired.tags !== undefined) patch.tags = [...desired.tags];
      if (desired.validFrom !== undefined) patch.validFrom = desired.validFrom;
      if (desired.validUntil !== undefined) patch.validUntil = desired.validUntil;
      const result = await memory.update(proposal.id, patch);
      if (result) applied.push(proposal);
      else failed.push({ proposal, reason: 'store update returned null (record not found?)' });
    } catch (error) {
      failed.push({ proposal, reason: summarizeError(error) });
    }
  }

  context.print(`[memory] Applied ${applied.length}, skipped ${skipped.length}, failed ${failed.length}.`);
  for (const proposal of applied) context.print(`  applied  ${proposal.id} [${proposal.kind}]`);
  for (const { proposal, reason } of failed) context.print(`  failed   ${proposal.id} [${proposal.kind}]: ${reason}`);
}
