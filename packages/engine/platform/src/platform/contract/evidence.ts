/**
 * A unit's evidence: what Jev
 * reads when it checks the unit. The diff of the paths the unit touched, the
 * claim verification and gate results (at the triggers that run them), the
 * agent's complete output and the commands it ran.
 *
 * Where the diff comes from:
 * - In git (the unit's item worktree in worktree mode, the project root in
 *   shared mode): paths whose exact local source differs from the unit's
 *   baseline (taken in that tree when its agent was spawned), that are new, or
 *   that commits since the baseline changed, each diffed against the baseline
 *   HEAD, or shown whole when git has no diff for it. The agent's work is
 *   uncommitted until the unit passes, so the item branch's commits alone
 *   would show none of it.
 * - Outside git: the paths the unit's write and edit calls named, with their
 *   current text.
 *
 * Everything here is collection and arithmetic over sizes; no judgment.
 */
import { isAbsolute, relative } from 'node:path';
import { estimateTokens, type JsonValue } from '@goodvibes-jev/judgment';
import { GitService } from '../git/service.js';
import { listDirtyTreePaths } from '../orchestration/dirty-guard.js';
import { captureDirtyFile, captureDirtyTreeRoot } from '../orchestration/dirty-file-observation.js';
import { assertBaselineExecutionRootCurrent, baselineChangedPaths } from './tree-baseline.js';
import { readNativePrivateReceiptArchives, verifyPrivateReceiptPreservation } from './private-read-receipts.js';
import { compareJsonReadReferences, compareReadReferences } from './read-reference-comparison.js';
import { commandObservation } from './command-observation.js';
import { acceptedResearchIds } from './accepted-research.js';
import { currentFileObservationsAsync } from './current-file-observations.js';
import { assignedReviewPaths, reviewProjectPath, reviewInventoryObservationAsync } from './review-inventory.js';
import { projectCheckEvidence } from './check-evidence-projection.js';
export { currentFileObservations } from './current-file-observations.js';
import { parseCompletionReport } from '../agents/completion-report.js';
import { readBodyWithHostEvidence, returnedReadRows } from '../tools/read/observation.js';
import { compactJsonReference } from './json-reference.js';
import type { ToolResult } from '../types/tools.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { CompletionReport } from '../agents/completion-report.js';
import { verifyUnitClaims, type ClaimVerificationResult } from './claims.js';
import type { ContractConfigReader } from './config.js';
import { runContractGates, type QualityGateResult } from './gates.js';
import type { CheckTrigger, ContractUnit, ContractView } from './types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

// Kept as compatibility exports; evidence collection no longer discards content.
/** @deprecated No application evidence budget. Provider context limits apply. */
export const EVIDENCE_TOKEN_BUDGET = Number.POSITIVE_INFINITY;
/** @deprecated Full output is retained. */
export const OUTPUT_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full gate output is retained. */
export const GATE_OUTPUT_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full diffs are retained. */
export const DIFF_FILE_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full command output is retained. */
export const COMMAND_HEAD_LINES = Number.POSITIVE_INFINITY;
/** @deprecated Full command lines are retained. */
export const COMMAND_LINE_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated All commands are retained. */
export const MAX_COMMANDS = Number.POSITIVE_INFINITY;
/** @deprecated All paths are retained. */
export const MAX_LISTED_PATHS = Number.POSITIVE_INFINITY;

// ── Shapes ────────────────────────────────────────────────────────────────────

/** One turn of a contract-bound agent, as the turn-end hook sees it (design 4.1). */
export interface ContractTurnRecord {
  readonly turn: number;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
  /** One result per tool call, in the same order. */
  readonly results: readonly ToolResult[];
  readonly assistantText: string;
}

export interface EvidenceCommand {
  readonly command: string;
  readonly success: boolean;
  /** Complete command output. */
  readonly head: string;
}

/** One observed execution, identified by its host agent and tool result. */
export interface CommandExecutionReceipt extends EvidenceCommand {
  readonly agentId: string;
  readonly turn: number;
  readonly callIndex: number;
  readonly callId: string;
}

/** One changed path and its full diff (or text, for a new file or outside git). */
export interface FileChange {
  readonly path: string;
  readonly diff: string;
}

/** Captured read scope and selected returned text; scope alone proves no review quality. */
export interface SourceReadEvidence {
  readonly path: string;
  readonly returnedRanges: readonly string[];
  readonly returnedLines: number;
  /** Actual returned text of a declared reference input, when needed by a read-only unit. */
  readonly returnedContent?: string;
  readonly contentKind?: 'declared-reference' | 'cited-source';
}

export interface UnitEvidence {
  readonly orchestration?: JsonValue;
  readonly sourceReads?: readonly SourceReadEvidence[];
  /** record.fullOutput at completion; the last assistant text mid-run. */
  readonly output: string;
  readonly changedPaths: readonly string[];
  /** Complete collected evidence. */
  readonly diff: string;
  /** Paths whose diff did not fit. */
  readonly omitted: readonly string[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

/** Evidence before trimming. */
export interface RawUnitEvidence {
  readonly orchestration?: JsonValue;
  readonly sourceReads?: readonly SourceReadEvidence[];
  readonly output: string;
  readonly changes: readonly FileChange[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

// ── Commands and written paths from the agent's turns (fixed tool formats) ─────

/**
 * A unit's reads, folded as each turn arrives: every returned row once, by
 * file and line. The raw turn (its tool arguments and complete results) is not
 * kept, so memory follows the distinct lines read, not the number of turns,
 * and a check reads these rows instead of re-parsing every earlier turn.
 */
export type FoldedReads = Map<string, Map<number, string>>;

/** Fold one turn's successful `read` results into `folded`. One pass over that turn only. */
export function foldTurnReads(folded: FoldedReads, turn: ContractTurnRecord): void {
  for (let index = 0; index < turn.toolCalls.length; index++) {
    if (turn.toolCalls[index]!.name !== 'read') continue;
    const result = turn.results[index];
    if (!result?.success || !result.output) continue;
    // The observation of each file travels on the result's host channel; results stored before it carried it in their text.
    const body = readBodyWithHostEvidence(result) as { success?: boolean; files?: unknown[] } | undefined;
    if (body?.success !== true || !Array.isArray(body.files)) continue;
    for (const value of body.files) {
      if (!value || typeof value !== 'object') continue;
      const file = value as { path?: unknown; extract?: unknown; content?: unknown; error?: unknown; binary?: unknown; readObservation?: unknown };
      if (typeof file.path !== 'string' || typeof file.content !== 'string' || file.error || file.binary
        || (file.extract !== 'content' && file.extract !== 'lines')) continue;
      const rows = folded.get(file.path) ?? new Map<number, string>();
      for (const row of returnedReadRows({ content: file.content, readObservation: file.readObservation })) {
        const match = /^[ \t]*(\d+) \|/.exec(row);
        const line = Number(match?.[1]);
        if (match && Number.isSafeInteger(line) && line > 0) rows.set(line, row);
      }
      if (rows.size) folded.set(file.path, rows);
    }
  }
}

/** Count complete actual rows with host-bound offsets; retain legacy numbered
 * returns, never requested ranges, file totals or previews. Content is kept for
 * declared reference files and for lines `citationText` cites. */
export function sourceReadsFromFolded(folded: FoldedReads, referencePaths: readonly string[] = [], citationText = ''): SourceReadEvidence[] {
  const references = new Set(referencePaths);
  return [...folded].map(([path, rows]) => {
    const lines = [...rows.keys()].sort((a, b) => a - b), returnedRanges: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const start = lines[index]!;
      let end = start;
      while (lines[index + 1] === end + 1) end = lines[++index]!;
      returnedRanges.push(start === end ? String(start) : `${start}-${end}`);
    }
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const citations = references.has(path) || citationText === '' ? [] : [...citationText.matchAll(new RegExp('(?<![\\w./-])' + escaped + '(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'))]
      .map(match => [Number(match[1]), Number(match[2] ?? match[1])] as const);
    const kept = references.has(path) ? lines : lines.filter(line => citations.some(([start, end]) => line >= start && line <= end));
    return { path, returnedRanges, returnedLines: lines.length,
      ...(kept.length ? { returnedContent: kept.map(line => rows.get(line)!).join('\n'),
        contentKind: references.has(path) ? 'declared-reference' as const : 'cited-source' as const } : {}) };
  });
}

/** The reads of `turns`, as `sourceReadsFromFolded` reads them. */
export function sourceReadsFromTurns(turns: readonly ContractTurnRecord[], referencePaths: readonly string[] = [], citationText = ''): SourceReadEvidence[] {
  const folded: FoldedReads = new Map();
  for (const turn of turns) foldTurnReads(folded, turn);
  return sourceReadsFromFolded(folded, referencePaths, citationText);
}

/** Merge retained observations with new reads; no prior verdict is carried forward. */
export function mergeSourceReads(previous: readonly SourceReadEvidence[], current: readonly SourceReadEvidence[]): SourceReadEvidence[] {
  const files = new Map<string, { ranges: [number, number][]; content: Map<number, string>; reference: boolean }>();
  for (const read of [...previous, ...current]) {
    if (typeof read.path !== 'string' || !Array.isArray(read.returnedRanges)) throw new Error('Invalid retained source-read evidence');
    const file: { ranges: [number, number][]; content: Map<number, string>; reference: boolean } = files.get(read.path) ?? { ranges: [], content: new Map(), reference: false };
    for (const range of read.returnedRanges) {
      if (typeof range !== 'string') throw new Error('Invalid retained source-read interval');
      const match = /^(\d+)(?:-(\d+))?$/.exec(range);
      const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) throw new Error('Invalid retained source-read interval');
      file.ranges.push([start, end]);
    }
    if (read.returnedContent !== undefined) {
      if (typeof read.returnedContent !== 'string') throw new Error('Invalid retained source-read contents');
      for (const row of read.returnedContent.split('\n')) {
        const match = /^[ \t]*(\d+) \|/.exec(row), line = Number(match?.[1]);
        if (match && file.ranges.some(([start, end]) => line >= start && line <= end)) file.content.set(line, row);
      }
      file.reference ||= read.contentKind === 'declared-reference';
    }
    files.set(read.path, file);
  }
  return [...files].map(([path, file]) => {
    const ranges: [number, number][] = [];
    for (const [start, end] of file.ranges.sort(([a], [b]) => a - b)) {
      const last = ranges.at(-1);
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    return { path, returnedRanges: ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`),
      returnedLines: ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0),
      ...(file.content.size ? { returnedContent: [...file.content].sort(([a], [b]) => a - b).map(([, row]) => row).join('\n'),
        contentKind: file.reference ? 'declared-reference' as const : 'cited-source' as const } : {}) };
  });
}

function commandText(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null;
  const { cmd, cmd_base64: encoded } = item as { cmd?: unknown; cmd_base64?: unknown };
  if (typeof cmd === 'string') return cmd;
  if (typeof encoded === 'string') return Buffer.from(encoded, 'base64').toString('utf-8');
  return null;
}

function capLine(text: string): string {
  return text.length <= COMMAND_LINE_CAP_CHARS ? text : `${text.slice(0, COMMAND_LINE_CAP_CHARS)}...`;
}

/** The first COMMAND_HEAD_LINES lines of `text`, each capped. */
export function headLines(text: string, count = COMMAND_HEAD_LINES): string {
  return text.split('\n').slice(0, count).map(capLine).join('\n');
}

/** Every `exec` call in the turns: its commands, whether the call succeeded, and the head of its output. */
export function commandsFromTurns(turns: readonly ContractTurnRecord[]): EvidenceCommand[] {
  const commands: EvidenceCommand[] = [];
  for (const turn of turns) {
    turn.toolCalls.forEach((call, index) => {
      if (call.name !== 'exec') return;
      const items = Array.isArray(call.arguments['commands']) ? (call.arguments['commands'] as unknown[]) : [];
      const text = items.map(commandText).filter((value): value is string => value !== null).join('\n');
      if (text.length === 0) return;
      const result = turn.results[index];
      commands.push({ command: capLine(text), success: result?.success === true, head: headLines(result?.output ?? result?.error ?? '') });
    });
  }
  return commands;
}

/** Keep distinct executions even when their command text and output are identical. */
export function commandReceiptsFromTurns(agentId: string, turns: readonly ContractTurnRecord[]): CommandExecutionReceipt[] {
  return turns.flatMap(turn => turn.toolCalls.flatMap((call, index) => {
    const result = turn.results[index];
    if (call.name !== 'exec' || !result) return [];
    return commandsFromTurns([{ ...turn, toolCalls: [call], results: [result] }])
      .map(command => ({ ...command, agentId, turn: turn.turn, callIndex: index, callId: result.callId }));
  }));
}

/** Merge by execution identity; replaying a receipt does not repeat a command. */
export function mergeCommandReceipts(previous: readonly CommandExecutionReceipt[], current: readonly CommandExecutionReceipt[]): CommandExecutionReceipt[] {
  const receipts = new Map<string, CommandExecutionReceipt>();
  for (const receipt of [...previous, ...current]) {
    const key = JSON.stringify([receipt.agentId, receipt.turn, receipt.callIndex, receipt.callId]);
    const retained = receipts.get(key);
    if (retained && (retained.command !== receipt.command || retained.success !== receipt.success || retained.head !== receipt.head)) {
      throw new Error('Conflicting command execution receipts');
    }
    receipts.set(key, receipt);
  }
  return [...receipts.values()];
}

/** Fold the paths one turn's `write` and `edit` calls named into `paths`, keeping first-seen order. */
export function foldWrittenPaths(paths: Set<string>, turn: ContractTurnRecord): void {
  for (const call of turn.toolCalls) {
    const key = call.name === 'write' ? 'files' : call.name === 'edit' ? 'edits' : null;
    if (key === null) continue;
    const items = Array.isArray(call.arguments[key]) ? (call.arguments[key] as unknown[]) : [];
    for (const item of items) {
      const path = item !== null && typeof item === 'object' ? (item as { path?: unknown }).path : undefined;
      if (typeof path === 'string' && path.length > 0) paths.add(path);
    }
  }
}

/** The paths the turns' `write` and `edit` calls named, in first-seen order. */
export function writtenPaths(turns: readonly ContractTurnRecord[]): string[] {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const key = call.name === 'write' ? 'files' : call.name === 'edit' ? 'edits' : null;
      if (key === null) continue;
      const items = Array.isArray(call.arguments[key]) ? (call.arguments[key] as unknown[]) : [];
      for (const item of items) {
        const path = item !== null && typeof item === 'object' ? (item as { path?: unknown }).path : undefined;
        if (typeof path === 'string' && path.length > 0) paths.add(path);
      }
    }
  }
  return [...paths];
}

// ── Changed paths and their diffs ─────────────────────────────────────────────

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, '--literal-pathspecs', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return code === 0 ? stdout : null;
  } catch (error) {
    logger.warn('contract evidence: git did not run', { args: args.join(' '), error: summarizeError(error) });
    return null;
  }
}

/** A file's current text for evidence, or a note when it is gone or binary. */
function fileText(cwd: string, path: string): string {
  const selected = isAbsolute(path) ? relative(cwd, path) : path;
  const file = captureDirtyFile(cwd, selected);
  if (file.kind === 'missing') return `(${path} no longer exists)`;
  if (file.kind === 'unavailable') return `(${path} could not be safely read)`;
  if (file.kind === 'symlink') return `symlink ${path} -> ${file.bytes.toString('utf8')}`;
  if (file.bytes.includes(0)) return `(binary file, ${file.bytes.length} bytes)`;
  return file.bytes.toString('utf-8');
}

/** Splits a unified diff into one entry per file, keyed by its new path. */
export function splitUnifiedDiff(unifiedDiff: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const chunk of unifiedDiff.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const line = chunk.slice(0, chunk.indexOf('\n') === -1 ? chunk.length : chunk.indexOf('\n'));
    // An unrenamed file names one path twice; reading it by length keeps a name containing " b/" whole.
    const rest = line.slice('diff --git '.length), length = (rest.length - 5) / 2;
    const same = Number.isInteger(length) && length > 0 ? rest.slice(2, 2 + length) : undefined;
    if (same !== undefined && rest === `a/${same} b/${same}`) { changes.push({ path: same, diff: chunk.trimEnd() }); continue; }
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (header !== null) changes.push({ path: header[2]!, diff: chunk.trimEnd() });
  }
  return changes;
}

/** Paths per `git diff` argument list, so a large change never exceeds the system's argument limit. */
const DIFF_PATHS_PER_CALL = 1_000;

/**
 * Shared mode: what changed in `cwd` since the unit's baseline, with each
 * path's diff. One `git diff` covers every changed path (split per file);
 * a path the combined diff does not attribute (an unusual name git quotes)
 * is diffed on its own. The tree root is checked once before and once after.
 */
async function sharedTreeChanges(cwd: string, baseline: ContractUnit['baseline']): Promise<FileChange[]> {
  const root = captureDirtyTreeRoot(cwd);
  const assertCurrent = () => { root.assertCurrent(); if (baseline) assertBaselineExecutionRootCurrent(cwd, baseline); };
  assertCurrent();
  const paths = new Set(baselineChangedPaths(cwd, listDirtyTreePaths(cwd), baseline));
  const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim() || null;
  const base = baseline?.head ?? head;
  if (baseline?.head && head !== null && head !== baseline.head) {
    const committed = await git(cwd, ['diff', '--name-only', '--no-renames', baseline.head, head]);
    for (const path of (committed ?? '').split('\n').filter(Boolean)) paths.add(path);
  }
  const ordered = [...paths];
  const diffs = new Map<string, string>();
  if (base !== null) {
    for (let start = 0; start < ordered.length; start += DIFF_PATHS_PER_CALL) {
      const combined = await git(cwd, ['diff', '--no-renames', base, '--', ...ordered.slice(start, start + DIFF_PATHS_PER_CALL)]);
      for (const change of splitUnifiedDiff(combined ?? '')) if (paths.has(change.path)) diffs.set(change.path, change.diff);
    }
  }
  const changes: FileChange[] = [];
  for (const path of ordered) {
    let diff = diffs.get(path);
    if (diff === undefined && base !== null) diff = (await git(cwd, ['diff', '--no-renames', base, '--', path]))?.trimEnd() ?? '';
    changes.push({ path, diff: diff !== undefined && diff.trim().length > 0 ? diff : `new file ${path}\n${fileText(cwd, path)}` });
  }
  assertCurrent(); return changes;
}

/** Outside git: the paths the unit wrote or edited, with their current text. */
function writtenChanges(cwd: string, written: Iterable<string>): FileChange[] {
  return [...written].map((path) => ({
    path: isAbsolute(path) ? relative(cwd, path) : path,
    diff: `${path}\n${fileText(cwd, path)}`,
  }));
}

// ── Collection ────────────────────────────────────────────────────────────────

/** Where one unit's evidence comes from. */
export interface UnitEvidenceSources {
  readonly ownerEvidence?: JsonValue | undefined;
  /** The final output at completion; the last assistant text mid-run. */
  readonly output: string;
  /** The unit's reads, folded from every turn its agents reported (`foldTurnReads`). */
  readonly reads: FoldedReads;
  /** The paths the unit's `write` and `edit` calls named, folded from every turn (`foldWrittenPaths`). */
  readonly writtenPaths: ReadonlySet<string>;
  /** The unit's worktree path, or the project root in shared mode. */
  readonly cwd: string;
  readonly configManager: ContractConfigReader;
  readonly signal?: AbortSignal | undefined;
  readonly runtimeBus: RuntimeEventBus;
  /**
   * The completion report the agent's output ends with, null when it gave none.
   * A check at completion parses it from `output`; a check after a restart reads
   * the one stored on the unit, since `output` is then capped head and tail.
   */
  readonly report: CompletionReport | null;
  /** Whether the unit's plan role has it change files (`unitMustWrite`), which decides whether its claims are checked. */
  readonly mustWrite: boolean;
  /** When given, only these changed paths are evidence (a unit's re-check after a planned fix). */
  readonly paths?: ReadonlySet<string> | null | undefined;
}

/** Triggers whose evidence includes gate results (design 4.3). */
const GATED_TRIGGERS: ReadonlySet<CheckTrigger> = new Set(['completion', 'agent-failed', 'fix-passed', 'resume', 'owner-amend']);

/** The changed files of a unit, from the source its isolation mode gives. */
export async function collectChanges(unit: Pick<ContractUnit, 'baseline'>, sources: Pick<UnitEvidenceSources, 'cwd' | 'writtenPaths'>): Promise<FileChange[]> {
  if (GitService.isGitRepo(sources.cwd)) return sharedTreeChanges(sources.cwd, unit.baseline);
  return writtenChanges(sources.cwd, sources.writtenPaths);
}

/**
 * Collects a unit's complete evidence for one check: the diff
 * always; claims at completion and at resume; gates at every trigger but turn-end.
 */
export async function collectUnitEvidence(
  contract: Pick<ContractView, 'id' | 'sessionId'> & Partial<Pick<ContractView, 'status' | 'decisions' | 'createdAt' | 'origin' | 'criteria' | 'groups' | 'units' | 'proposedUnits' | 'projectRoot' | 'inputSnapshot' | 'reviewInventory' | 'reviewExclusions' | 'isolation'>>,
  unit: Pick<ContractUnit, 'id' | 'goal' | 'brief' | 'files' | 'baseline' | 'readEvidence' | 'commandEvidence'>,
  trigger: CheckTrigger,
  sources: UnitEvidenceSources,
): Promise<UnitEvidence> {
  const collected = await collectChanges(unit, sources);
  const scope = sources.paths;
  const changes = scope === null || scope === undefined ? collected : collected.filter((change) => scope.has(change.path));
  // Claims are checked against the unit's own baseline-scoped changes (the same paths the evidence lists), not the whole tree.
  const claims = trigger === 'completion' || trigger === 'resume'
    ? verifyUnitClaims(sources.report, { cwd: sources.cwd, mustWrite: sources.mustWrite, changedPaths: changes.map((change) => change.path) })
    : undefined;
  const configuredGates = GATED_TRIGGERS.has(trigger)
    ? await runContractGates({
      configManager: sources.configManager,
      cwd: sources.cwd,
      runtimeBus: sources.runtimeBus,
      sessionId: contract.sessionId,
      contractId: contract.id,
      targetId: unit.id,
      // In a shared tree the results are evidence for this unit's files only, so the owner's other saves leave them current.
      ...(contract.isolation === 'shared' ? { scope: changes.map((change) => change.path) } : {}),
      signal: sources.signal,
    })
    : undefined;
  const preservation = verifyPrivateReceiptPreservation(contract, unit, sources.cwd);
  const gates = preservation ? [...(configuredGates ?? []), preservation] : configuredGates;
  const planChecks = contract.decisions?.filter(decision => decision.action === 'plan-accepted' && decision.targetId === contract.id)
    .map(decision => ({ at: decision.at, reason: decision.reason, decisionIds: [...decision.decisionIds] })) ?? [];
  const firstUnitStartedAt = contract.decisions?.find(decision => decision.action === 'spawned' && contract.units?.some(unit => unit.id === decision.targetId))?.at;
  const currentReads = sourceReadsFromFolded(sources.reads, sources.mustWrite ? [] : unit.files, sources.output);
  const observedReads = sources.mustWrite ? currentReads : mergeSourceReads(unit.readEvidence ?? [], currentReads);
  const currentUnit = contract.units?.find(planned => planned.id === unit.id);
  // Assignment is not inspection. Unread assigned files remain in the
  // unit's review inventory slice, but cannot enter check.reviewedFiles
  // without an actual returned read. Only the files this check is about are
  // observed: the unit's own files, reads and changes, and the earlier reviews
  // of files inside its assigned slice.
  const slice = contract.reviewInventory ? new Set(assignedReviewPaths(contract.reviewInventory, unit.files)) : undefined;
  const currentFiles = planChecks.length ? await currentFileObservationsAsync(sources.cwd, [...unit.files,
    ...observedReads.filter(read => read.returnedLines > 0).flatMap(read => {
      const path = reviewProjectPath(sources.cwd, read.path);
      return path === undefined ? [] : [path];
    }), ...changes.map(change => change.path),
    ...(slice === undefined ? [] : (contract.units ?? []).flatMap(planned => planned.checks.at(-1)?.reviewedFiles?.map(file => file.path) ?? []).filter(path => slice.has(path)))],
  { owner: contract }, sources.signal) : [];
  const owner = sources.ownerEvidence;
  const ownerReads = owner && typeof owner === 'object' && !Array.isArray(owner) && Array.isArray(owner['sourceReads'])
    ? owner['sourceReads'].flatMap(read => read && typeof read === 'object' && !Array.isArray(read) && typeof read['path'] === 'string'
      && Array.isArray(read['returnedRanges']) && read['returnedRanges'].every(range => typeof range === 'string')
      ? [{ path: read['path'], returnedRanges: read['returnedRanges'] as string[] }] : []) : [];
  const observationSources: { source: string; reads: readonly Pick<SourceReadEvidence, 'path' | 'returnedRanges'>[] }[] = [
    { source: `current unit ${unit.id}`, reads: observedReads },
    ...(contract.units ?? []).filter(planned => planned.id !== unit.id && planned.status === 'passed')
      .map(planned => ({ source: `passed unit ${planned.id}`, reads: planned.readEvidence ?? [] })),
    { source: 'qualified original-owner observations', reads: ownerReads },
  ];
  // A derived check can name a root or another derived requirement by id.
  // Supply that actual obligation, not just its id or the worker's summary.
  const allCriteria = [...(contract.criteria ?? []), ...(contract.groups ?? []).flatMap(group => group.criteria),
    ...(contract.units ?? []).flatMap(planned => planned.criteria)];
  const referenced = new Set(currentUnit?.criteria.flatMap(criterion => criterion.serves) ?? []);
  const assignedText = unit.goal + '\n' + unit.brief;
  for (const criterion of contract.criteria ?? []) {
    const escaped = criterion.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(?<![\\w.-])' + escaped + '(?![\\w-]|\\.[\\w-])').test(assignedText)) referenced.add(criterion.id);
  }
  for (const id of referenced) for (const parent of allCriteria.find(criterion => criterion.id === id)?.serves ?? []) referenced.add(parent);
  const referencedCriteria = allCriteria.filter(criterion => referenced.has(criterion.id));
  const requirements = { unitId: unit.id, brief: unit.brief,
    referencedCriteria: referencedCriteria.map(criterion => ({
      id: criterion.id, text: criterion.text, origin: criterion.origin, serves: [...criterion.serves],
      ...(criterion.quote === undefined ? {} : { quote: criterion.quote }),
    })),
    sourceReferenceComparisons: compareReadReferences([{ field: 'unit.brief', text: unit.brief },
      ...referencedCriteria.map(criterion => ({ field: `criterion ${criterion.id}`, text: criterion.text }))],
      observationSources.flatMap(source => source.reads), observationSources),
    sourceJsonReferenceComparisons: compareJsonReadReferences(observedReads, currentFiles, observationSources),
  };
  const repairing = currentUnit?.criteria.some(criterion => criterion.origin === 'fix') === true;
  const dependencyIds = new Set(currentUnit?.dependsOn ?? []);
  const researchIds = acceptedResearchIds({ units: contract.units ?? [] });
  for (const id of dependencyIds) for (const ancestor of contract.units?.find(planned => planned.id === id)?.dependsOn ?? []) dependencyIds.add(ancestor);
  const referencesExecution = (id: string | undefined): boolean => id !== undefined && new RegExp('(?<![\\w.-])'
    + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-]|\\.[\\w-])').test(unit.brief + '\n' + sources.output);
  const privateArtifacts = readNativePrivateReceiptArchives(contract, unit.files);
  return trimEvidence({ output: sources.output, changes, claims, gates, commands: unit.commandEvidence ?? [],
    sourceReads: observedReads,
    ...(planChecks.length ? { orchestration: { contractId: contract.id, ...(contract.status === undefined ? {} : { status: contract.status }), planChecks,
      requirements,
      ...(sources.ownerEvidence === undefined ? {} : { ownerPriorReads: sources.ownerEvidence }),
      currentFiles,
      ...(contract.reviewInventory && contract.projectRoot && contract.units ? { reviewInventory: await reviewInventoryObservationAsync({ ...contract, projectRoot: contract.projectRoot, units: contract.units }, currentFiles, sources.signal, unit.files) as unknown as JsonValue } : {}),
      ...(privateArtifacts.length ? { privateArtifacts } : {}),
      ...(contract.createdAt === undefined ? {} : { createdAt: contract.createdAt }),
      ...(contract.origin === undefined ? {} : { origin: contract.origin }),
      ...(firstUnitStartedAt === undefined ? {} : { firstUnitStartedAt }),
      ...(contract.proposedUnits === undefined ? {} : { proposedUnits: contract.proposedUnits.map(unit => ({ task: unit.task, ...(unit.template === undefined ? {} : { template: unit.template }) })) }),
      ...(contract.units === undefined ? {} : { plannedUnits: contract.units.map(planned => ({ id: planned.id, title: planned.title, goal: planned.goal, role: planned.role,
        briefSource: { storage: 'native-contract-store', contractId: contract.id, unitId: planned.id, field: 'brief', bytes: Buffer.byteLength(planned.brief) },
        ...(planned.id === unit.id ? {} : { status: planned.status,
          latestCheck: planned.checks.length ? { id: planned.checks.at(-1)!.id, trigger: planned.checks.at(-1)!.trigger,
            result: planned.checks.at(-1)!.result, decisionIds: [...planned.checks.at(-1)!.decisionIds],
            ...(planned.checks.at(-1)!.gates === undefined ? {} : { gates: gateEvidence(planned.checks.at(-1)!.gates!) }) } : null,
          ...(planned.status === 'passed' ? { readObservations: (planned.readEvidence ?? []).map(read => ({ path: read.path,
            returnedRanges: [...read.returnedRanges], returnedLines: read.returnedLines })),
            commands: (planned.commandEvidence ?? []).map((command, index) => {
              const observed = commandObservation(command);
              if (currentUnit === undefined || currentUnit.role === 'integration' || dependencyIds.has(planned.id) || referencesExecution(command.callId)) return { ...observed };
              const { command: script, head, ...identity } = command;
              return { ...identity, observationKind: 'retained-command-receipt-index',
                ...('exitCode' in observed && typeof observed.exitCode === 'number'
                  && 'executionSucceeded' in observed && typeof observed.executionSucceeded === 'boolean'
                  ? { exitCode: observed.exitCode, executionSucceeded: observed.executionSucceeded, toolCallSucceeded: command.success } : {}),
                commandBytes: Buffer.byteLength(script),
                captureBytes: Buffer.byteLength(head),
                bodySource: { storage: 'native-contract-store', contractId: contract.id, unitId: planned.id, field: 'commandEvidence', index } };
            }),
            ...(currentUnit?.role === 'integration' || (repairing && (planned.role === 'integration' || dependencyIds.has(planned.id) || researchIds.has(planned.id)))
              ? { acceptedAnswer: planned.answer ?? '' } : {}) } : {}) }),
        criteria: planned.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, serves: [...criterion.serves],
          ...(criterion.contribution ? { contribution: { ...criterion.contribution } } : {}),
          ...(planned.id !== unit.id && planned.status === 'passed' ? { verdict: criterion.status } : {}) })) })) }),
      readingRules: CHECK_READING_RULES,
      meaning: 'Host records for this current contract. The complete assigned unit brief and exact referenced requirements are supplied in requirements. Other units are represented by their goals, exact criteria, actual scoped checks, observations, command receipts and accepted results. Integration checks receive prior commands in full. Other checks receive full command/result bodies for their dependency closure or explicitly referenced execution ids; unrelated prior commands retain their identities, statuses and native storage locations, not proof of unshown results. Old worker instructions remain unchanged at briefSource; they are not this unit\'s requirements. A passed peer criterion verdict establishes only its checked scope. Plan and prior-unit acceptance do not approve the unit now being checked.' } } : {}) }, unit);
}

// ── What Jev reads ────────────────────────────────────────────────────────────

/**
 * How the rows of a check state are read, stated once per request rather than
 * on every row.
 */
export const CHECK_READING_RULES: JsonValue = {
  requirements: 'requirements: actual host-owned requirements referenced by this unit acceptance check, including transitive references. They resolve requirement ids; they do not expand this unit into the whole contract or approve its work. Judge the assigned unit goal and criteria against their referenced obligations and actual evidence.',
  currentFiles: 'read-current-file rows: a native read from the original current physical tree, with text when requested and representable. The observation ID labels this owner\'s latest observed physical file version; it proves neither byte equality nor semantic correctness, worker inspection, execution or native approval. A row with success false means the file\'s identity could not be established.',
  retainedCommandReceipts: 'retained-command-receipt-index rows: actual receipt identity and available child exit status retained; the command is outside the assigned dependency closure and its execution id is not referenced by this candidate. Command/result bodies remain unchanged at bodySource in their original native record and are not supplied in this check view. Metadata or a prior pass does not prove an unshown command body, purpose or asserted verification result. Declared dependency or explicitly execution-id-referenced receipts are supplied in full.',
  gates: 'gate rows: process success and assertion verification are separate observations. Unverified required checks leave acceptance open; a skipped check proves no behavior. A command-exit completion means the configured command completed with this exit code; it establishes no assertion count or test coverage.',
};

/** A path list for the state: at most MAX_LISTED_PATHS, then a count of the rest. */
export function listedPaths(paths: readonly string[]): string[] {
  if (paths.length <= MAX_LISTED_PATHS) return [...paths];
  return [...paths.slice(0, MAX_LISTED_PATHS), `(+${paths.length - MAX_LISTED_PATHS} more)`];
}

/** The evidence object the judge reads beside the output. */
/** The gate results a check state carries. */
function gateEvidence(gates: NonNullable<UnitEvidence['gates']>): JsonValue {
  return gates.map<JsonValue>(gate => {
    const record: Record<string, JsonValue> = { gate: gate.gate, passed: gate.passed, skipped: gate.skipped === true, output: gate.output };
    if (gate.outcome === undefined) return record;
    record['outcome'] = gate.outcome;
    record['required'] = gate.required === true;
    if (gate.reason !== undefined) record['reason'] = gate.reason;
    if (gate.completion?.kind === 'assertions') record['completion'] = { kind: gate.completion.kind, runner: gate.completion.runner, checks: { ...gate.completion.checks } };
    else if (gate.completion?.kind === 'command-exit') record['completion'] = { kind: gate.completion.kind, exitCode: gate.completion.exitCode };
    if (gate.provenance) record['provenance'] = { ...gate.provenance };
    return record;
  });
}

export function judgeEvidence(evidence: UnitEvidence): JsonValue {
  const hostOperations = actualHostOperations(evidence);
  return {
    ...(hostOperations.length ? { hostOperations } : {}),
    ...(evidence.orchestration === undefined ? {} : { orchestration: evidence.orchestration }),
    ...sourceReadState(evidence),
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    omitted: listedPaths(evidence.omitted),
    ...(evidence.claims === undefined
      ? {}
      : { claims: { kind: evidence.claims.kind, summary: evidence.claims.summary, missingPaths: listedPaths(evidence.claims.missingPaths) } }),
    ...(evidence.gates === undefined
      ? {}
      : { gates: gateEvidence(evidence.gates) }),
    commands: evidence.commands.map(command => ({ ...commandObservation(command) })),
  };
}

/** A check request's state: one object of named JSON values. */
export type CheckState = { [key: string]: JsonValue };

/** The judge's whole state, as the judge pattern builds it: `{ goal, output, evidence }`. */
export function judgeState(unit: Pick<ContractUnit, 'goal'>, evidence: UnitEvidence): CheckState {
  const report = parseCompletionReport(evidence.output);
  // Downstream native artifact checks consume raw judgeEvidence observations;
  // only this final model-facing state receives the lossless table view.
  const projected = projectCheckEvidence(judgeEvidence(evidence) as CheckState);
  if (typeof report?.finalAnswer === 'string') return { goal: unit.goal, output: report.finalAnswer,
    evidence: { ...projected, completionReport: report as unknown as JsonValue,
      deliverySource: { field: 'finalAnswer',
        meaning: 'output is the exact proposed user-facing finalAnswer from the current completion report. The complete parsed report remains supplied for criteria about its fields, supporting work and attribution. Report text is a proposal, never proof of execution or approval.' } } };
  return { goal: unit.goal, output: evidence.output, evidence: projected };
}

/** The quality battery's state (design 4.4). */
export function qualityState(unit: Pick<ContractUnit, 'goal' | 'brief'>, evidence: UnitEvidence): CheckState {
  const hostOperations = actualHostOperations(evidence);
  const report = parseCompletionReport(evidence.output);
  return projectCheckEvidence({
    ...(hostOperations.length ? { hostOperations } : {}),
    ...(evidence.orchestration === undefined ? {} : { orchestration: evidence.orchestration }),
    ...sourceReadState(evidence),
    goal: unit.goal,
    brief: unit.brief,
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    omitted: listedPaths(evidence.omitted),
    commands: evidence.commands.map(command => ({ ...commandObservation(command) })),
    // A gate's result shows a claim such as "the tests pass" as well as a command the agent ran.
    ...(evidence.gates === undefined ? {} : { gates: gateEvidence(evidence.gates) }),
    output: evidence.output,
    ...(typeof report?.finalAnswer === 'string' ? { completionReport: report as unknown as JsonValue,
      proposedFinalAnswer: report.finalAnswer,
      deliverySource: { field: 'finalAnswer',
        phase: 'candidate-before-native-acceptance-and-publication',
        meaning: 'The exact parsed finalAnswer is proposed release text, not an already published response or proof of performed work. The complete raw and parsed completion report remain supplied. The host releases this text only after separate native checks and successful owner publication; the current unit need not perform those future host steps. Every claimed substantive result, read, test or other execution still needs its actual relevant evidence. Internal pending-check metadata is not a claim that task work was omitted; explicit premature claims of native approval remain unsupported. No approval is granted by this state.' } } : {}),
  });
}

/**
 * Host operations not already in the state: the owner-read validation and the
 * private archive reads. The current-file reads are in `orchestration.currentFiles`
 * once and are not repeated here.
 */
function actualHostOperations(evidence: UnitEvidence): JsonValue[] {
  const orchestration = evidence.orchestration;
  if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)) return [];
  const archives = orchestration['privateArtifacts'];
  const owner = orchestration['ownerPriorReads'];
  const ownerValidation = owner && typeof owner === 'object' && !Array.isArray(owner)
    && owner['kind'] === 'original-owner-read-observations' ? owner['hostValidation'] : undefined;
  return [...(ownerValidation ? [ownerValidation] : []), ...(Array.isArray(archives) ? archives : []).flatMap(archive => archive && typeof archive === 'object' && !Array.isArray(archive)
    && archive['kind'] === 'contract-read-receipts' && archive['hostFileRead'] ? [archive['hostFileRead']] : [])];
}

function sourceReadState(evidence: UnitEvidence): CheckState {
  if (!evidence.sourceReads?.length) return {};
  const host = evidence.orchestration;
  const currentFiles = host && typeof host === 'object' && !Array.isArray(host) && Array.isArray(host['currentFiles']) ? host['currentFiles'] : [];
  return {
    sourceReads: evidence.sourceReads.map(read => ({ ...compactJsonReference(read, currentFiles), returnedRanges: [...read.returnedRanges] })),
    sourceReadMeaning: 'These host-collected ranges establish which complete source lines were actually returned by successful read tools. Host-bound offsets retain plain returns as well as numbered ones; displayed line labels may be normalized from those offsets. returnedContent carries actual retained source text, as contentKind records; it may be a subset of returnedRanges. A referenceProjection explicitly marks a byte-bound JSON view with display labels and whitespace outside string literals removed; all original tokens and literal values remain, and exact original returned text stays retained. For large inputs, Jev may identify receipt-only citation paragraphs: their source quotations are omitted from this check view while the full report, all returned-range records and raw saved evidence remain intact. Substantive and mixed citation contexts retain their primary text. Read scope alone does not establish semantic review quality or validate findings; missing primary text is not proof of a substantive claim. Judge the substantive work against the provided source evidence separately. This is the current native acceptance check; do not demand an earlier approval of this same check.',
  };
}

/** Estimated tokens of the larger of the two check states for this evidence. */
export function evidenceTokens(unit: Pick<ContractUnit, 'goal' | 'brief'>, evidence: UnitEvidence): number {
  return Math.max(estimateTokens(judgeState(unit, evidence)), estimateTokens(qualityState(unit, evidence)));
}

// ── Trimming (design 4.3) ─────────────────────────────────────────────────────

/** The head and tail of `text` within `cap` characters, with the cut stated. */
export function headAndTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const keep = Math.floor(cap / 2);
  return `${text.slice(0, keep)}\n[... ${text.length - 2 * keep} characters omitted ...]\n${text.slice(text.length - keep)}`;
}

/** The last `cap` characters of `text`, with the cut stated. */
export function tail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `[... ${text.length - cap} characters omitted ...]\n${text.slice(text.length - cap)}`;
}

/** Changes in fill order: the unit's `files` in their listed order, then the rest smallest first. */
function fillOrder(changes: readonly FileChange[], files: readonly string[]): FileChange[] {
  const rank = (path: string): number => {
    const index = files.indexOf(path);
    return index === -1 ? files.length : index;
  };
  return [...changes].sort((a, b) => rank(a.path) - rank(b.path) || a.diff.length - b.diff.length);
}

/** Assemble complete evidence without per-file, command, output or total cuts. */
export function trimEvidence(raw: RawUnitEvidence, unit: Pick<ContractUnit, 'goal' | 'brief' | 'files'>): UnitEvidence {
  return {
    ...(raw.orchestration === undefined ? {} : { orchestration: raw.orchestration }),
    ...(raw.sourceReads?.length ? { sourceReads: raw.sourceReads } : {}),
    output: raw.output,
    changedPaths: raw.changes.map(change => change.path),
    diff: fillOrder(raw.changes, unit.files).map(change => change.diff).join('\n\n'),
    omitted: [],
    ...(raw.claims === undefined ? {} : { claims: raw.claims }),
    ...(raw.gates === undefined ? {} : { gates: raw.gates }),
    commands: raw.commands,
  };
}
