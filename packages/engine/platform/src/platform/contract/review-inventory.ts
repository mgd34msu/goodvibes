import { execFile } from 'node:child_process';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { readdir, lstat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildGlobMatcher } from '../utils/glob-to-regex.js';
import type { ContractView, ContractUnitView } from './types.js';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { isCurrentNativeFileObservation } from './current-file-observations.js';
import { hasNativeReviewedFileReference, reviewedFileProvenance, reviewedFileVersionState, type ReviewedFileReference } from './review-file-observations.js';

const executeFile = promisify(execFile);
const runtimeDirectories = new Set(['.git', '.goodvibes', '.plat', 'node_modules', '.venv']);

export interface ReviewInventory {
  readonly paths: readonly string[];
  readonly source: 'git' | 'filesystem';
  readonly errors: readonly string[];
}

/** Inventory filenames, without reading source bodies or asking a model. */
export async function captureReviewInventory(root: string, signal?: AbortSignal): Promise<ReviewInventory> {
  const paths = new Set<string>(), errors: string[] = [];
  let source: ReviewInventory['source'] = 'git';
  const included = (path: string) => !path.split('/').some(part => runtimeDirectories.has(part));
  try {
    const result = await executeFile('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}) });
    for (const path of result.stdout.split('\0')) if (path && included(path)) paths.add(path);
  } catch {
    signal?.throwIfAborted();
    source = 'filesystem';
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      try {
        for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
          const path = directory ? directory + '/' + entry.name : entry.name;
          if (!included(path)) continue;
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() || entry.isSymbolicLink()) paths.add(path);
        }
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${directory || '.'}: ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`);
      }
    };
    await walk('');
  }
  // Git also lists tracked deletions. They are changes, not present files.
  const present: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    try { const entry = await lstat(resolve(root, path)); if (entry.isFile() || entry.isSymbolicLink()) present.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`); }
  }
  present.sort();
  return { paths: present, source, errors };
}

/**
 * A lossless planner catalog: share each directory prefix once, retaining all
 * direct filenames, including dotfiles and files without extensions. Host
 * coverage checks still compare the original exact paths. The former budget
 * argument remains accepted for callers, but never hides inventory entries.
 */
export function reviewInventoryPlannerView(inventory: ReviewInventory, _budget?: number): JsonValue {
  const directories = new Map<string, string[]>();
  for (const path of inventory.paths) {
    const separator = path.lastIndexOf('/');
    const directory = separator === -1 ? '.' : path.slice(0, separator);
    const name = path.slice(separator + 1);
    const files = directories.get(directory) ?? [];
    files.push(name);
    directories.set(directory, files);
  }
  return {
    source: inventory.source,
    errors: [...inventory.errors],
    totalFiles: inventory.paths.length,
    directories: [...directories.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([directory, files]) => ({ directory, files: files.sort() })),
    meaning: 'Complete exact inventory. Each directory lists its direct filenames; "." is the project root. Join each other directory and filename with "/" to reconstruct every original path. No files are omitted. Assign scope with exact paths, directories or globs; the host checks coverage against the original inventory.',
  };
}

export function reviewProjectPath(root: string, path: string): string | undefined {
  const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
  return normalized && normalized !== '..' && !normalized.startsWith('../') ? normalized : undefined;
}

export function assignedReviewPaths(inventory: ReviewInventory, patterns: readonly string[]): string[] {
  const matches = patterns.map(pattern => ({ path: pattern.replace(/\/$/, ''), match: buildGlobMatcher(pattern) }));
  return inventory.paths.filter(path => matches.some(pattern => pattern.path === '.' || path === pattern.path || path.startsWith(pattern.path + '/') || pattern.match(path)));
}

/** Reads and native accepted assessments are separate facts. A prior check
 * applies only to the exact file version it received, never a changed file. */
function* observeReviewInventory(contract: Pick<ContractView, 'projectRoot' | 'units' | 'reviewInventory'> & Partial<Pick<ContractView, 'reviewExclusions'>>,
  currentFiles: readonly JsonValue[] = []) {
  const inventory = contract.reviewInventory;
  if (!inventory) return undefined;
  const versions = new Map<string, JsonValue | null>();
  for (const value of currentFiles) if (value && typeof value === 'object' && !Array.isArray(value)
    && value['operation'] === 'read-current-file' && value['source'] === 'native-host-filesystem' && typeof value['path'] === 'string') {
    versions.set(value['path'], value['success'] === true && isCurrentNativeFileObservation(value) ? value : null);
    yield;
  }
  const excluded = new Map<string, string[]>();
  for (const exclusion of contract.reviewExclusions ?? []) for (const path of assignedReviewPaths(inventory, exclusion.files)) {
    const reasons = excluded.get(path) ?? []; reasons.push(exclusion.reason); excluded.set(path, reasons);
  }
  const accepted = new Map<string, (ReviewedFileReference & { unitId: string; checkId: string; criteria: string[]; state: string; provenance: string })[]>();
  for (const unit of contract.units) {
    const check = unit.checks.at(-1);
    if (unit.role !== 'research' || unit.status !== 'passed' || check?.result !== 'pass' || !check.decisionIds.length) continue;
    for (const file of check.reviewedFiles ?? []) {
      const records = accepted.get(file.path) ?? [];
      const current = versions.get(file.path);
      records.push({ ...file, unitId: unit.id, checkId: check.id, criteria: unit.criteria.map(criterion => criterion.id), provenance: reviewedFileProvenance(file),
        state: !hasNativeReviewedFileReference(file) ? 'unverified' : current ? reviewedFileVersionState(current, file) : versions.has(file.path) ? 'changed' : 'version-unchecked' });
      accepted.set(file.path, records);
      yield;
    }
  }
  const inspections = new Map<string, { unit: ContractUnitView; ranges: readonly string[] }[]>();
  for (const unit of contract.units) for (const read of unit.readEvidence ?? []) {
    const path = reviewProjectPath(contract.projectRoot, read.path);
    if (!path) continue;
    const records = inspections.get(path) ?? [];
    records.push({ unit, ranges: read.returnedRanges }); inspections.set(path, records);
  }
  const files = inventory.paths.map(path => {
    const exclusionReasons = excluded.get(path) ?? [];
    const reads = inspections.get(path) ?? [];
    const assessments = accepted.get(path) ?? [];
    return { path, scope: exclusionReasons.length ? 'excluded' : 'included', exclusionReasons, inspection: reads.length ? 'inspected' : 'uninspected',
      observations: reads.map(read => ({ unitId: read.unit.id, ranges: [...read.ranges] })),
      assessment: assessments.some(assessment => assessment.state === 'current') ? 'reviewed'
        : assessments.some(assessment => assessment.state === 'version-unchecked') ? 'version-unchecked' : assessments.length ? 'changed' : 'unreviewed', assessments };
  });
  return { source: inventory.source, errors: [...inventory.errors],
    totalFiles: files.length, inspectedFiles: files.filter(file => file.inspection === 'inspected').length,
    reviewedFiles: files.filter(file => file.assessment === 'reviewed').length,
    remainingFiles: files.filter(file => file.scope === 'included' && ['unreviewed', 'changed'].includes(file.assessment)).map(file => file.path),
    versionChecksPending: files.filter(file => file.scope === 'included' && file.assessment === 'version-unchecked').map(file => file.path), files,
    meaning: 'Native project inventory compared with actual read observations and accepted scoped research checks. Inspected never means reviewed. A reviewed entry requires a passed native assessment and the matching original physical file observation. Actual owned older saved SHA256 records verify their independently recorded reviewed bytes; original physical ownership was not recorded, as provenance states. Changed, copied, imported or unknown versions remain open. File inventory is not an instruction to review unrelated files: the original requested scope and any explicitly justified exclusions remain controlling. These facts never approve the final response.' };
}

/** Synchronous projection for existing callers with small local evidence. */
export function reviewInventoryObservation(contract: Pick<ContractView, 'projectRoot' | 'units' | 'reviewInventory'> & Partial<Pick<ContractView, 'reviewExclusions'>>,
  currentFiles: readonly JsonValue[] = []) {
  const observations = observeReviewInventory(contract, currentFiles);
  let next = observations.next();
  while (!next.done) next = observations.next();
  return next.value;
}

/** Retain every file and assessment while yielding between physical checks. */
export async function reviewInventoryObservationAsync(contract: Parameters<typeof observeReviewInventory>[0],
  currentFiles: readonly JsonValue[] = [], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const observations = observeReviewInventory(contract, currentFiles);
  let next = observations.next();
  while (!next.done) {
    await yieldToEventLoop(undefined, { signal });
    next = observations.next();
  }
  return next.value;
}

/** Counting and matching identities are host bookkeeping. Keep the exact gap
 * list, without sending all completed file records through every Jev request. */
export function compactReviewInventory(observation: NonNullable<ReturnType<typeof reviewInventoryObservation>>) {
  const { files, ...summary } = observation;
  return { ...summary,
    excludedFiles: files.filter(file => file.scope === 'excluded').map(file => ({ path: file.path, reasons: file.exclusionReasons })),
    acceptedAssessments: [...new Map(files.flatMap(file => file.assessments.map(assessment => [assessment.checkId, {
      unitId: assessment.unitId, checkId: assessment.checkId, criteria: assessment.criteria,
    }] as const))).values()],
    meaning: summary.meaning + ' This compact view preserves exact pending paths and explicit exclusions. Completed per-file records remain in the native contract reviewInventory and unit checks at the listed unitId/checkId references; counts and identity comparisons are computed by the host, never asserted by a model.' };
}
