/**
 * trace-words.ts, a hook run as the hook trace keeps it, and what it did in a
 * person's words. Browser-safe (no node imports): the terminal programs post
 * runs in this shape, and every screen that shows the trace (the Tools and
 * extensions place, the web UI) words them with `hookRunOutcome`. The trace
 * itself is kept by the daemon (trace.ts).
 */
import type { HookActivityRecord } from './activity.js';
import type { HookType } from './types.js';

/** The programs whose hooks are traced. */
export type HookTraceProgram = 'tui' | 'agent' | 'daemon';

/** One hook run as the trace keeps it. */
export interface HookTraceRecord {
  /** Unique per run: the program's run id, so a post sent twice is kept once. */
  readonly id: string;
  /** When it ran (ms since the epoch). */
  readonly at: number;
  readonly program: HookTraceProgram;
  /** The project folder whose turn fired it, when the program said. */
  readonly project?: string | undefined;
  /** The hook point the event came through (`Pre:tool:exec`). */
  readonly point: string;
  /** What the event was about: the tool or the step (`exec`, `turn`). */
  readonly on: string;
  readonly hook: string;
  readonly type: HookType;
  readonly pattern: string;
  readonly ok: boolean;
  readonly decision?: 'allow' | 'deny' | 'ask' | undefined;
  readonly reason?: string | undefined;
  readonly changedInput?: boolean | undefined;
  readonly addedContext?: boolean | undefined;
  readonly error?: string | undefined;
  readonly durationMs: number;
  /** It ran beside the event instead of before it went on. */
  readonly background: boolean;
  readonly sessionId?: string | undefined;
}

const HOOK_TYPES: ReadonlySet<string> = new Set(['command', 'prompt', 'agent', 'http', 'ts']);
const DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'ask']);
/** A reason or an error is kept to this many characters. */
const TEXT_LIMIT = 400;

const clip = (value: string): string => value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT - 1)}…` : value;

/** A run of a program's dispatcher, as the trace keeps it. */
export function hookTraceRecordOf(record: HookActivityRecord, origin: { readonly id: string; readonly program: HookTraceProgram; readonly project?: string | undefined }): HookTraceRecord {
  return {
    id: origin.id,
    at: record.timestamp,
    program: origin.program,
    ...(origin.project ? { project: origin.project } : {}),
    point: record.path,
    on: record.specific,
    hook: record.hookName,
    type: record.hookType,
    pattern: record.pattern,
    ok: record.ok,
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.reason ? { reason: clip(record.reason) } : {}),
    ...(record.changedInput ? { changedInput: true } : {}),
    ...(record.addedContext ? { addedContext: true } : {}),
    ...(record.error ? { error: clip(record.error) } : {}),
    durationMs: record.durationMs,
    background: record.async,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

/** A posted or stored run read defensively: it came from another process or a file. */
export function readHookTraceRecord(value: unknown): HookTraceRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | undefined => typeof raw[key] === 'string' && (raw[key] as string).length > 0 ? raw[key] as string : undefined;
  const id = text('id');
  const point = text('point');
  const hook = text('hook');
  const type = text('type');
  const program = text('program');
  const at = typeof raw['at'] === 'number' && Number.isFinite(raw['at']) ? raw['at'] : undefined;
  if (!id || !point || !hook || !type || !HOOK_TYPES.has(type) || at === undefined) return undefined;
  if (program !== 'tui' && program !== 'agent' && program !== 'daemon') return undefined;
  const decision = text('decision');
  const project = text('project');
  const reason = text('reason');
  const error = text('error');
  const sessionId = text('sessionId');
  return {
    id: clip(id),
    at,
    program,
    ...(project ? { project } : {}),
    point: clip(point),
    on: clip(text('on') ?? ''),
    hook: clip(hook),
    type: type as HookType,
    pattern: clip(text('pattern') ?? point),
    ok: raw['ok'] === true,
    ...(decision && DECISIONS.has(decision) ? { decision: decision as 'allow' | 'deny' | 'ask' } : {}),
    ...(reason ? { reason: clip(reason) } : {}),
    ...(raw['changedInput'] === true ? { changedInput: true } : {}),
    ...(raw['addedContext'] === true ? { addedContext: true } : {}),
    ...(error ? { error: clip(error) } : {}),
    durationMs: typeof raw['durationMs'] === 'number' && Number.isFinite(raw['durationMs']) ? Math.max(0, raw['durationMs']) : 0,
    background: raw['background'] === true,
    ...(sessionId ? { sessionId } : {}),
  };
}

/** What a run did, in a person's words: "refused it: no pushes on Friday", "let it go on", "failed: exit code 2". */
export function hookRunOutcome(record: Pick<HookTraceRecord, 'ok' | 'decision' | 'reason' | 'changedInput' | 'addedContext' | 'error'>): string {
  if (!record.ok) return `failed${record.error ? `: ${record.error}` : ''}`;
  const parts: string[] = [];
  if (record.decision === 'deny') parts.push(`refused it${record.reason ? `: ${record.reason}` : ''}`);
  else if (record.decision === 'ask') parts.push(`put it to you${record.reason ? `: ${record.reason}` : ''}`);
  if (record.changedInput) parts.push('changed its input');
  if (record.addedContext) parts.push('added context to the conversation');
  if (parts.length === 0) return 'let it go on';
  return parts.join('; ');
}

/** The program a run came from, in words. */
export const HOOK_TRACE_PROGRAM_WORDS: Readonly<Record<HookTraceProgram, string>> = { tui: 'the terminal app', agent: 'the Agent', daemon: 'the daemon' };
