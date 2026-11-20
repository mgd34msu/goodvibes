/**
 * Which tool calls of one model response run side by side, decided from what
 * each tool declares (no model request, no I/O), and the bounded runner every
 * tool loop uses to run them.
 *
 * - A read (declared `read_fs` only, `concurrency: 'parallel'`, a call in
 *   one of the tool's declared `readModes`, or a call the tool itself says
 *   only reads through `callReadsOnly`) runs beside any other read.
 * - A write (declared `write_fs` only, with its paths declared) runs beside
 *   reads and writes whose paths it does not overlap.
 * - Everything else (`exec`, undeclared effects, a tool the owner decides,
 *   `concurrency: 'singleton'`) runs alone, after every call before it has
 *   finished and before any call after it starts.
 *
 * Calls are grouped in the model's order, so a call never runs before one the
 * model issued earlier that it could depend on.
 */
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { declaredValues } from '../gate/classify.js';
import { readModeCategory, type Tool, type ToolDefinition, type ToolSideEffect } from '../types/tools.js';
import type { ConfigManager } from '../config/manager.js';

/** At most this many calls of one response are in flight when `runtime.maxParallelToolCalls` is not set. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;

/** The cap on calls in flight (`runtime.maxParallelToolCalls`); 1 runs every call alone. */
export function maxParallelToolCalls(configManager: Pick<ConfigManager, 'get'> | null | undefined): number {
  const value = configManager?.get('runtime.maxParallelToolCalls');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PARALLEL_TOOL_CALLS;
}

/**
 * A path a call touches. Relative paths are compared with relative paths only:
 * without the directory they resolve against, a relative and an absolute path
 * may name the same file, so such a pair counts as overlapping.
 */
type TouchedPath = { readonly absolute: boolean; readonly path: string };

/** How one call may run beside the others of its response. */
export type ToolCallLane =
  /** `paths` absent: the read may touch any file. */
  | { readonly kind: 'read'; readonly paths?: readonly TouchedPath[] | undefined }
  | { readonly kind: 'write'; readonly paths: readonly TouchedPath[] }
  | { readonly kind: 'alone'; readonly reason: string };

const READ_ONLY: ReadonlySet<ToolSideEffect> = new Set(['read_fs']);
const FILE_EFFECTS: ReadonlySet<ToolSideEffect> = new Set(['read_fs', 'write_fs']);

function touchedPaths(definition: ToolDefinition, args: Record<string, unknown>, workingDirectory: string | undefined): TouchedPath[] | undefined {
  const raw = declaredValues(args, definition.subjects?.paths);
  if (raw === undefined || raw.length === 0) return undefined;
  const paths: TouchedPath[] = [];
  for (const value of raw) {
    // `~` is expanded by the tool against a home directory this code does not know.
    if (value.length === 0 || value.startsWith('~')) return undefined;
    if (isAbsolute(value)) paths.push({ absolute: true, path: resolve(value) });
    else if (workingDirectory) paths.push({ absolute: true, path: resolve(workingDirectory, value) });
    else paths.push({ absolute: false, path: normalize(value) });
  }
  return paths;
}

/** Whether the tool itself says this call only reads; a hook that throws says nothing. */
function toolSaysReadsOnly(tool: Pick<Tool, 'callReadsOnly'> | undefined, args: Record<string, unknown>): boolean {
  if (tool?.callReadsOnly === undefined) return false;
  try { return tool.callReadsOnly(args) === true; } catch { return false; }
}

/**
 * The lane of one call, from its tool's declaration and the call's own
 * arguments; `tool` adds what the tool knows about this call beyond its
 * declaration (Tool.callReadsOnly).
 */
export function toolCallLane(definition: ToolDefinition | undefined, args: Record<string, unknown>, workingDirectory?: string,
  tool?: Pick<Tool, 'callReadsOnly'> | undefined): ToolCallLane {
  if (!definition) return { kind: 'alone', reason: 'unknown tool' };
  if (definition.dangerous === true) return { kind: 'alone', reason: 'the owner decides this tool' };
  if (definition.concurrency === 'singleton') return { kind: 'alone', reason: 'the tool runs one call at a time' };
  const effects = definition.sideEffects;
  const touchesFiles = effects === undefined || effects.some((effect) => FILE_EFFECTS.has(effect));
  // A call in one of the modes the tool declares read-only reads, whatever its other modes do.
  const readMode = effects !== undefined && !effects.includes('exec')
    && ((definition.readModes !== undefined && readModeCategory(definition.readModes, args, 'write') === 'read') || toolSaysReadsOnly(tool, args));
  if (definition.concurrency === 'parallel' || readMode) {
    return touchesFiles ? { kind: 'read', paths: touchedPaths(definition, args, workingDirectory) } : { kind: 'read', paths: [] };
  }
  if (effects === undefined || effects.length === 0) return { kind: 'alone', reason: 'undeclared side effects' };
  if (effects.every((effect) => READ_ONLY.has(effect))) return { kind: 'read', paths: touchedPaths(definition, args, workingDirectory) };
  if (effects.every((effect) => FILE_EFFECTS.has(effect))) {
    const paths = touchedPaths(definition, args, workingDirectory);
    return paths ? { kind: 'write', paths } : { kind: 'alone', reason: 'a write whose paths cannot be read from the call' };
  }
  return { kind: 'alone', reason: `declared effects ${effects.join(', ')}` };
}

function pathsOverlap(a: TouchedPath, b: TouchedPath): boolean {
  if (a.absolute !== b.absolute) return true;
  if (a.path === b.path) return true;
  const within = (inner: string, outer: string) => inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  return within(a.path, b.path) || within(b.path, a.path);
}

function anyOverlap(a: readonly TouchedPath[], b: readonly TouchedPath[]): boolean {
  for (const left of a) for (const right of b) if (pathsOverlap(left, right)) return true;
  return false;
}

/** True when two calls' lanes may not run at the same time (a write beside anything touching its paths, or a call that runs alone). */
export function lanesConflict(a: ToolCallLane, b: ToolCallLane): boolean {
  if (a.kind === 'alone' || b.kind === 'alone') return true;
  if (a.kind === 'read' && b.kind === 'read') return false;
  const aPaths = a.paths, bPaths = b.paths;
  if (aPaths === undefined || bPaths === undefined) return true;
  return anyOverlap(aPaths, bPaths);
}

/**
 * The lanes of the calls of one batch as they are admitted. A batch is planned
 * from the model's arguments; a Pre hook or an admission revision can change
 * what a call touches before it runs. Each call enters with the lane of its
 * admitted arguments and waits for every running call it conflicts with, so
 * two writes never reach the same file at once whatever rewrote them.
 */
export class AdmittedLanes {
  private readonly running: { readonly lane: ToolCallLane; readonly done: Promise<void> }[] = [];

  async enter(lane: ToolCallLane): Promise<() => void> {
    for (;;) {
      const blockers = this.running.filter((entry) => lanesConflict(entry.lane, lane));
      if (blockers.length === 0) break;
      await Promise.all(blockers.map((entry) => entry.done));
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const entry = { lane, done };
    this.running.push(entry);
    return () => {
      const at = this.running.indexOf(entry);
      if (at >= 0) this.running.splice(at, 1);
      release();
    };
  }
}

interface OpenGroup {
  readonly indices: number[];
  readonly written: TouchedPath[];
  readonly read: TouchedPath[];
  readUnknown: boolean;
}

/**
 * Split the calls of one response into groups of indices, in the model's
 * order. The calls of one group may run together; a group starts only after
 * the one before it has finished.
 */
export function planToolBatch<C>(calls: readonly C[], laneOf: (call: C) => ToolCallLane): number[][] {
  const groups: number[][] = [];
  let open: OpenGroup | undefined;
  const start = (index: number): OpenGroup => {
    const group: OpenGroup = { indices: [index], written: [], read: [], readUnknown: false };
    groups.push(group.indices);
    return group;
  };
  calls.forEach((call, index) => {
    const lane = laneOf(call);
    if (lane.kind === 'alone') { groups.push([index]); open = undefined; return; }
    const current: OpenGroup | undefined = open;
    if (lane.kind === 'read') {
      const joins = current !== undefined && (lane.paths === undefined ? current.written.length === 0 : !anyOverlap(lane.paths, current.written));
      const group = joins ? current : start(index);
      if (joins) group.indices.push(index);
      if (lane.paths === undefined) group.readUnknown = true;
      else group.read.push(...lane.paths);
      open = group;
      return;
    }
    const joins = current !== undefined && !current.readUnknown && !anyOverlap(lane.paths, current.read) && !anyOverlap(lane.paths, current.written);
    const group = joins ? current : start(index);
    if (joins) group.indices.push(index);
    group.written.push(...lane.paths);
    open = group;
  });
  return groups;
}

/**
 * Run `work` over `items` with at most `limit` in flight, starting them in order.
 * If one throws, nothing further is started and `onFailure` is called (a caller
 * that wants the running siblings to stop aborts them there); every item already
 * started is awaited before the first error is rethrown, so nothing is left
 * running untracked and nothing settles after this returns.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  onFailure: (() => void) | undefined,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await work(items[index] as T, index); }
      catch (error) {
        if (!failed) { failed = true; firstError = error; onFailure?.(); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw firstError;
}
