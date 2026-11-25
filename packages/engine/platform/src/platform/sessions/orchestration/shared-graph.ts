/**
 * The project's one cross-session task graph for both terminal programs.
 *
 * Until 3.5.0 the terminal app and the Agent each kept their own graph in the
 * project (`.goodvibes/tui/sessions/task-graph.json`, `.goodvibes/agent/...`),
 * so a task handed from a terminal-app session was never seen by an Agent
 * session in the same folder. Both now use `.goodvibes/shared/task-graph.json`.
 * At the first start of this version in a project, before the graph is read,
 * the two old files are carried into it once: every task, dependency and
 * hand-off of both, nothing dropped (a task both files hold keeps the newer
 * record). The old files are left as they are, so a 3.5.0 binary still reads
 * its own file exactly as it was at the upgrade; what this version changes
 * afterwards is in the shared file only. A shared file that exists means the
 * carry happened (or this version already wrote it): it is never done twice.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeDocument } from '../../utils/atomic-json-store.js';
import { withProcessLockSync } from '../../utils/process-lock.js';
import { parseGraphFile } from './registry-housekeeping.js';
import type { SessionTaskGraphSnapshot, TaskDependencyEdge, TaskHandoffRecord, CrossSessionTaskRef } from './types.js';
import { makeRefKey } from './types.js';

/** The project's shared task graph file. */
export function projectTaskGraphPath(projectRoot: string): string {
  return join(projectRoot, '.goodvibes', 'shared', 'task-graph.json');
}

/** Each terminal program's own graph before this version (left untouched for a rollback). */
function oldGraphPaths(projectRoot: string): readonly string[] {
  return ['tui', 'agent'].map((surface) => join(projectRoot, '.goodvibes', surface, 'sessions', 'task-graph.json'));
}

function readOld(path: string): SessionTaskGraphSnapshot | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const verdict = parseGraphFile(readFileSync(path, 'utf-8'));
    // A damaged or newer-version file is left where it is and not carried; it stays readable by the version that wrote it.
    return verdict.kind === 'ok' ? verdict.snapshot : undefined;
  } catch {
    return undefined;
  }
}

/** Carry both programs' old graphs into the shared one, once; returns what was carried (undefined when nothing was). */
export function carryTaskGraphsOnce(projectRoot: string): { readonly refs: number; readonly edges: number; readonly handoffs: number } | undefined {
  const shared = projectTaskGraphPath(projectRoot);
  if (existsSync(shared)) return undefined;
  const old = oldGraphPaths(projectRoot).map(readOld).filter((snapshot): snapshot is SessionTaskGraphSnapshot => snapshot !== undefined);
  if (old.length === 0) return undefined;
  const refs: Record<string, CrossSessionTaskRef> = {};
  const edges: TaskDependencyEdge[] = [];
  const handoffs: TaskHandoffRecord[] = [];
  const edgeKeys = new Set<string>();
  const handoffIds = new Set<string>();
  for (const snapshot of old) {
    for (const ref of Object.values(snapshot.refs)) {
      const key = makeRefKey(ref.sessionId, ref.taskId);
      const held = refs[key];
      if (!held || held.updatedAt < ref.updatedAt) refs[key] = ref;
    }
    for (const edge of snapshot.edges) {
      const key = `${makeRefKey(edge.fromRef.sessionId, edge.fromRef.taskId)}>${makeRefKey(edge.toRef.sessionId, edge.toRef.taskId)}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
    for (const handoff of snapshot.handoffs) {
      if (handoffIds.has(handoff.handoffId)) continue;
      handoffIds.add(handoff.handoffId);
      handoffs.push(handoff);
    }
  }
  if (Object.keys(refs).length === 0 && edges.length === 0 && handoffs.length === 0) return undefined;
  const merged: SessionTaskGraphSnapshot = { version: 1, snapshotAt: Date.now(), refs, edges, handoffs };
  mkdirSync(dirname(shared), { recursive: true, mode: 0o700 });
  // Under the same lock the registry writes with: a second program starting in the project at once carries nothing twice.
  return withProcessLockSync(`${shared}.writer.sqlite`, () => {
    if (existsSync(shared)) return undefined;
    writeDocument(shared, merged);
    return { refs: Object.keys(refs).length, edges: edges.length, handoffs: handoffs.length };
  }, { waitMs: 1000 });
}
