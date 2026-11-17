import { readExecutionPurpose } from '../batteries/execution-purpose.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
/**
 * The execution ledger: one record per tool call the runtime handles, built
 * from the `tools` event domain, for the execution surfaces to list and
 * filter.
 *
 * A tool code knows (the engine's own tools, `ENGINE_TOOL_ROUTES`, and any
 * registered tool whose definition declares its effects or category) is
 * recorded entirely by code, in every mode, with no reading: its kind, its
 * target (the declared subject argument), its command, an argument preview
 * with credential and owner-profile fields withheld by name
 * (`withheldFieldKind`), and whether it is a verification attempt (a shell
 * command whose program or script is a test, type check, lint or build
 * check; every other kind never verifies). `record.verification` is the one
 * answer every history view shows, and nothing asks it again.
 *
 * Only a tool with no declared facts (an MCP or plugin tool) is read: its
 * argument roles per tool and top-level argument name (`engine.gate.ledger-arg`,
 * remembered for the process), its route kind (`readSideEffectKind` at the
 * `engine.gate.execution-ledger` site) and, when it reads as a shell or other
 * tool, its purpose (`engine.gate.execution-purpose`). Those readings enrich
 * an immediately visible, value-free record in the background; lifecycle
 * events never wait for them. A name not read as a confident no is redacted,
 * and when a reading fails every value stays withheld and the failure is
 * stated in `argsReadingError` / `routeKindError`. YOLO and Classic take no
 * reading: such a tool's values stay withheld there.
 */
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import type { ToolEvent } from '../../../events/tools.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import { logger } from '../../utils/logger.js';
import type { SideEffectKind } from '../batteries/side-effect.js';
import { snapshotJudgmentInput, JudgmentInputError } from '../judgment-input.js';
import { readSideEffectKind, shellCommandsIn } from '../reading.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { isYoloExecution } from '../execution-context.js';
import { mapLimit } from '@goodvibes-jev/judgment';
import { ledgerArg } from '../batteries/ledger-arg.js';
import { withheldFieldKind } from '../../utils/field-kind-reading.js';
import { declaredValues } from '../classify.js';
import type { ToolArgumentPath, ToolDefinition } from '../../types/tools.js';

/** The decision site the ledger's route-kind readings are logged under. */
export const EXECUTION_LEDGER_SITE = 'engine.gate.execution-ledger';

export type AgentExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentExecutionRouteKind = SideEffectKind;

export interface AgentExecutionResultSummary {
  /** Passive provenance from execution, never authority. */
  readonly autonomousDecision?: JevDecision | undefined;
  readonly kind: string;
  readonly byteSize: number;
  readonly preview?: string | undefined;
}

export interface AgentExecutionRecord {
  readonly operationProvenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated' | 'partial';
  readonly id: string;
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly routeKind: AgentExecutionRouteKind;
  /** Settled purpose of the complete invocation; absent when pending/unavailable. */
  readonly verification?: boolean | undefined;
  /** Why the route kind could not be read, when the reading failed. */
  readonly routeKindError?: string | undefined;
  /** Why the argument roles could not be read; every argument value is redacted then. */
  readonly argsReadingError?: string | undefined;
  readonly status: AgentExecutionStatus;
  readonly phase: ToolEvent['type'];
  readonly receivedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly permissionApproved?: boolean | undefined;
  /** Passive provenance from permission/execution, never authority. */
  readonly autonomousDecision?: JevDecision | undefined;
  readonly argsPreview: string;
  readonly argsKeys: readonly string[];
  readonly commandPreview?: string | undefined;
  readonly targetPreview?: string | undefined;
  readonly resultSummary?: AgentExecutionResultSummary | undefined;
  readonly error?: string | undefined;
  readonly cancelReason?: string | undefined;
}

interface MutableAgentExecutionRecord {
  operationProvenance?: 'classic';
  semanticAssessment?: 'not-evaluated' | 'partial';
  id: string;
  callId: string;
  turnId: string;
  tool: string;
  routeKind: AgentExecutionRouteKind;
  verification?: boolean | undefined;
  routeKindError?: string | undefined;
  argsReadingError?: string | undefined;
  status: AgentExecutionStatus;
  phase: ToolEvent['type'];
  receivedAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
  durationMs?: number | undefined;
  permissionApproved?: boolean | undefined;
  autonomousDecision?: JevDecision | undefined;
  argsPreview: string;
  argsKeys: readonly string[];
  commandPreview?: string | undefined;
  targetPreview?: string | undefined;
  resultSummary?: AgentExecutionResultSummary | undefined;
  error?: string | undefined;
  cancelReason?: string | undefined;
}

export interface AgentExecutionLedgerSnapshot {
  readonly records: readonly AgentExecutionRecord[];
  readonly total: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

const DEFAULT_LIMIT = 500;

/** What one argument name is, for one tool (engine.gate.ledger-arg). */
interface ArgRole {
  readonly credential: boolean;
  readonly target: boolean;
}

/**
 * Roles read so far, by tool and argument name; bounded, the oldest leaves first. Kept per
 * installed judgment port and the model it names: a role one reader decided is never applied
 * under another, so replacing the port or changing its model (the settings port reads its model
 * live, with no replacement) starts every argument over.
 */
let argRolesByPort = new WeakMap<object, { model: string; roles: Map<string, ArgRole> }>();
const ARG_ROLES_LIMIT = 1024;
/** Nesting read or shown; deeper values are withheld, so a hostile depth cannot exhaust the stack. */
const ARG_DEPTH_LIMIT = 64;
const ARG_READ_CONCURRENCY = 8;
const roleKey = (tool: string, argument: string): string => JSON.stringify([tool, argument]);

/** What code knows about a tool: its kind and where its target and commands sit in its arguments. */
interface ToolFacts {
  readonly kind: AgentExecutionRouteKind;
  readonly targets?: readonly ToolArgumentPath[] | undefined;
  readonly commands?: readonly ToolArgumentPath[] | undefined;
}

/** The engine's own tools, facts of their definitions. */
const ENGINE_TOOL_ROUTES: Readonly<Record<string, ToolFacts>> = {
  read: { kind: 'read', targets: ['files[].path'] }, find: { kind: 'read' }, inspect: { kind: 'read', targets: ['file', 'projectRoot'] },
  repo_map: { kind: 'read' }, context_accounting: { kind: 'read' }, goodvibes_context: { kind: 'read' }, analyze: { kind: 'read' },
  write: { kind: 'write', targets: ['files[].path'] }, edit: { kind: 'write', targets: ['edits[].path'] }, goodvibes_settings: { kind: 'write', targets: ['key'] },
  exec: { kind: 'shell' },
  fetch: { kind: 'network', targets: ['urls[].url', 'url'] }, web_search: { kind: 'network', targets: ['query'] },
  agent: { kind: 'delegation', targets: ['task'] }, delegate: { kind: 'delegation', targets: ['task'] }, workflow: { kind: 'delegation', targets: ['workflowId'] },
};

/**
 * A registered tool's facts from its declared effects or category; undefined
 * when it declares neither. A declared empty list with no category is a tool
 * that changes nothing, so it is a read.
 */
function definitionFacts(definition: ToolDefinition | undefined): ToolFacts | undefined {
  if (!definition) return undefined;
  const effects = definition.sideEffects ?? [];
  const category = definition.category;
  const kind: AgentExecutionRouteKind | undefined = effects.includes('exec') ? 'shell'
    : effects.includes('network') ? 'network'
      : effects.includes('agent') || effects.includes('workflow') ? 'delegation'
        : effects.includes('write_fs') || effects.includes('state') ? 'write'
          : effects.length > 0 ? 'read'
            : category === 'execute' ? 'shell' : category === 'write' ? 'write' : category === 'read' ? 'read' : category === 'delegate' ? 'delegation'
              : definition.sideEffects !== undefined ? 'read' : undefined;
  if (kind === undefined) return undefined;
  const subjects = definition.subjects;
  return { kind, targets: subjects?.paths ?? subjects?.hosts ?? subjects?.recipients, commands: subjects?.commands };
}

const CHECK_VERBS = new Set(['test', 'tests', 'spec', 'typecheck', 'type-check', 'tsc', 'lint', 'check', 'verify', 'validate', 'ci', 'clippy', 'vet']);
const CHECK_PROGRAMS = new Set(['tsc', 'eslint', 'vitest', 'jest', 'mocha', 'ava', 'pytest', 'mypy', 'pyright', 'rspec', 'phpunit', 'ctest', 'shellcheck', 'golangci-lint', 'tox', 'nox']);
const RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn', 'deno', 'node', 'cargo', 'go', 'mvn', 'gradle', 'gradlew', './gradlew', 'make', 'dotnet', 'swift', 'mix', 'rake', 'just', 'task', 'ruff', 'biome', 'prettier', 'playwright', 'cypress', 'python', 'python3', 'uv', 'poetry']);
const LAUNCHERS = new Set(['npx', 'bunx', 'exec', 'dlx', 'run', 'env', 'time', 'nice']);

/** The name a word gives a check: a script path's base name without its extension, or `name:variant` before the colon. */
function checkWord(word: string): string {
  const base = word.split('/').pop() ?? word;
  return base.replace(/\.(?:[cm]?[jt]sx?|py|sh)$/, '').split(':')[0]!.toLowerCase();
}

/**
 * Whether a shell command runs a check of correctness: some simple command in
 * it is a test, type-check or lint program, or a runner (`bun`, `npm run`,
 * `cargo`, `go`, `make`, `python -m`, ...) whose subcommand or script is one.
 * Printing or naming a check (`echo tests passed`) is not.
 */
function runsCheck(command: string): boolean {
  for (const simple of command.split(/&&|\|\||[;|\n]/)) {
    const words = simple.trim().split(/\s+/).filter((word) => word.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    while (words.length > 0 && LAUNCHERS.has(words[0]!)) words.shift();
    const program = (words[0] ?? '').split('/').pop() ?? '';
    if (CHECK_PROGRAMS.has(program)) return true;
    if (!RUNNERS.has(program) && !RUNNERS.has(words[0] ?? '')) continue;
    for (const word of words.slice(1)) {
      if (word === '--test') return true;
      if (word.startsWith('-') || LAUNCHERS.has(word)) continue;
      if (CHECK_VERBS.has(checkWord(word)) || CHECK_PROGRAMS.has(checkWord(word)) || word === 'unittest') return true;
      // The first non-flag word decides: `bun install`, `npm start`, `go build` are not checks.
      if (program !== 'python' && program !== 'python3' && program !== 'uv' && program !== 'poetry') break;
    }
  }
  return false;
}

/** Top-level argument roles decided by name alone: a credential or owner-profile field is withheld. */
function namedRoles(args: Record<string, unknown>): ReadonlyMap<string, ArgRole> {
  return new Map(Object.keys(args).map((key) => [key, { credential: withheldFieldKind(key) !== undefined, target: false }]));
}

function firstDeclared(args: Record<string, unknown>, paths: readonly ToolArgumentPath[] | undefined): string | undefined {
  for (const path of paths ?? []) {
    const value = declaredValues(args, [path])?.find((entry) => entry.trim().length > 0);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Reads the roles of the call's top-level argument names not read yet for this tool. A JudgmentError propagates. */
async function readArgRoles(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ReadonlyMap<string, ArgRole>> {
  const names = Object.keys(args);
  if (names.length === 0) return new Map();
  const port = judgmentPort(EXECUTION_LEDGER_SITE);
  const model = port.model;
  let entry = argRolesByPort.get(port);
  if (!entry || entry.model !== model) { entry = { model, roles: new Map() }; argRolesByPort.set(port, entry); }
  const known = entry.roles;
  const unread = names.filter((name) => !known.has(roleKey(tool, name)));
  // mapLimit drains admitted workers before rejecting. Abort at the failing
  // worker so queued names stop and late siblings cannot publish a role.
  const batch = new AbortController();
  const batchSignal = AbortSignal.any([signal, batch.signal]);
  await mapLimit(unread, ARG_READ_CONCURRENCY, async (argument) => {
    try {
      batchSignal.throwIfAborted();
      const run = await ledgerArg.run(port, { tool, argument }, { site: EXECUTION_LEDGER_SITE, signal: batchSignal });
      batchSignal.throwIfAborted();
      const credential = !(run.readings.holds_credential.verdict === 'no' && run.readings.holds_credential.outcome === 'act');
      const target = run.readings.is_target.verdict === 'yes' && run.readings.is_target.outcome === 'act';
      run.recordAction(credential ? 'redact' : target ? 'target' : 'show');
      // Recording can synchronously dispose the owning ledger.
      batchSignal.throwIfAborted();
      known.set(roleKey(tool, argument), { credential, target });
      if (known.size > ARG_ROLES_LIMIT) known.delete(known.keys().next().value!);
    } catch (error) {
      // Abort immediately at the failing worker, before aggregate rejection
      // retires the ledger's pending entry. Non-cooperative late readers hit
      // the post-await guard; queued workers hit the pre-ask guard.
      batch.abort();
      throw error;
    }
  });
  return new Map(names.map((name) => [name, known.get(roleKey(tool, name))!]));
}

/** Forgets the argument roles read so far (tests; a replaced judgment port already starts empty). */
export function forgetLedgerArgRoles(): void {
  argRolesByPort = new WeakMap();
}

function truncateText(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}...` : compact;
}

/**
 * Whether a key's value is shown: a top-level argument when its name was read
 * as a confident non-credential, a nested key (part of its argument's value)
 * unless its name is a credential or owner-profile field name.
 */
function shownKey(key: string, roles: ReadonlyMap<string, ArgRole> | null, topLevel: boolean): boolean {
  return topLevel ? roles?.get(key)?.credential === false : roles !== null && withheldFieldKind(key) === undefined;
}

/** A value as the preview shows it. */
function redactValue(value: unknown, roles: ReadonlyMap<string, ArgRole> | null, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactValue(entry, roles, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 16).map(([key, entry]) => (
    [key, shownKey(key, roles, depth === 0) ? redactValue(entry, roles, depth + 1) : '[redacted]'] as const
  ));
  return Object.fromEntries(entries);
}

function argsPreview(args: Record<string, unknown>, roles: ReadonlyMap<string, ArgRole> | null): string {
  try {
    return truncateText(JSON.stringify(redactValue(args, roles)), 360);
  } catch {
    return '[unserializable args]';
  }
}

/** The first top-level string argument read as what the call acts on, and not as a credential. */
function targetPreview(args: Record<string, unknown>, roles: ReadonlyMap<string, ArgRole> | null): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    const role = roles?.get(key);
    if (role?.target && !role.credential && typeof value === 'string' && value.trim()) return truncateText(value, 180);
  }
  return undefined;
}

/** Redact the complete captured tree before any value-bearing reading. */
function readingArgs(value: unknown, roles: ReadonlyMap<string, ArgRole> | null, depth = 0, topLevel = true): unknown {
  if (depth > ARG_DEPTH_LIMIT) return '[truncated]';
  if (Array.isArray(value)) return value.map((entry) => readingArgs(entry, roles, depth + 1, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, shownKey(key, roles, topLevel) ? readingArgs(entry, roles, depth + 1, false) : '[redacted]',
  ]));
}

/** Provider errors can echo inputs; diagnostics here must never contain them. */
const ROUTE_READING_FAILED = 'Execution route judgment unavailable.';
const ARG_READING_FAILED = 'Execution argument judgment unavailable; values withheld.';
const READING_CANCELLED = 'Execution judgment cancelled; values withheld.';

/** Reads the call's route kind; uncertainty never becomes a guessed kind. */
async function readRouteKind(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ routeKind: AgentExecutionRouteKind; routeKindError?: string; classic?: true }> {
  try {
    signal.throwIfAborted();
    return await decisionOrClassic<{ routeKind: AgentExecutionRouteKind; routeKindError?: string; classic?: true }>(async () => {
      const reading = await readSideEffectKind(tool, args, EXECUTION_LEDGER_SITE, signal);
      signal.throwIfAborted();
      if (!reading.confident) return { routeKind: 'other', routeKindError: 'Execution route judgment uncertain.' };
      return { routeKind: reading.kind };
    }, () => { signal.throwIfAborted(); return { routeKind: 'other', classic: true }; }, () => { signal.throwIfAborted(); return true; });
  } catch {
    if (!signal.aborted) logger.warn('AgentExecutionLedger: route kind reading failed');
    return { routeKind: 'other', routeKindError: ROUTE_READING_FAILED };
  }
}

/** Argument values stay withheld on any failed reading. */
async function readArgRolesReported(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ roles: ReadonlyMap<string, ArgRole> | null; error?: string; classic?: true }> {
  try {
    return await decisionOrClassic<{ roles: ReadonlyMap<string, ArgRole> | null; classic?: true }>(
      async () => ({ roles: await readArgRoles(tool, args, signal) }),
      () => { signal.throwIfAborted(); return { roles: null, classic: true }; }, () => { signal.throwIfAborted(); return true; });
  } catch {
    if (!signal.aborted) logger.warn('AgentExecutionLedger: argument reading failed');
    return { roles: null, error: ARG_READING_FAILED };
  }
}

function statusForPhase(phase: ToolEvent['type']): AgentExecutionStatus {
  if (phase === 'TOOL_SUCCEEDED') return 'succeeded';
  if (phase === 'TOOL_FAILED') return 'failed';
  if (phase === 'TOOL_CANCELLED') return 'cancelled';
  return 'running';
}

function resultSummaryFrom(value: Extract<ToolEvent, { type: 'TOOL_SUCCEEDED' | 'TOOL_FAILED' }>['result']): AgentExecutionResultSummary | undefined {
  if (!value) return undefined;
  return {
    ...(value.autonomousDecision ? { autonomousDecision: structuredClone(value.autonomousDecision) } : {}),
    kind: value.kind,
    byteSize: value.byteSize,
    ...(typeof value.preview === 'string' && value.preview.trim() ? { preview: truncateText(value.preview, 220) } : {}),
  };
}

function immutable(record: MutableAgentExecutionRecord): AgentExecutionRecord {
  return { ...record, argsKeys: [...record.argsKeys],
    ...(record.autonomousDecision ? { autonomousDecision: structuredClone(record.autonomousDecision) } : {}),
    ...(record.resultSummary ? { resultSummary: structuredClone(record.resultSummary) } : {}),
  };
}

export interface AgentExecutionLedgerOptions {
  /** The registered definition of a tool, so its declared effects and subjects decide its record with no reading. */
  readonly describeTool?: ((name: string) => ToolDefinition | undefined) | undefined;
}

export class AgentExecutionLedger {
  private readonly records = new Map<string, MutableAgentExecutionRecord>();
  private readonly order: string[] = [];
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeTurns: () => void;
  /** Enrichment never blocks lifecycle events, cancellation, or disposal. */
  private readonly pending = new Map<string, { done: Promise<void>; cancel: () => void }>();
  private disposed = false;

  public constructor(
    runtimeBus: RuntimeEventBus,
    private readonly limit: number = DEFAULT_LIMIT,
    private readonly options: AgentExecutionLedgerOptions = {},
  ) {
    this.unsubscribe = runtimeBus.onDomain('tools', (envelope) => {
      this.handleToolEvent(envelope.payload as ToolEvent, envelope.ts);
    });
    this.unsubscribeTurns = runtimeBus.onDomain('turn', (envelope) => {
      const event = envelope.payload as TurnEvent;
      if (event.type === 'TURN_COMPLETED' || event.type === 'TURN_ERROR' || event.type === 'TURN_CANCEL') this.settleTurn(event.turnId, envelope.ts);
    });
  }

  public getSnapshot(): AgentExecutionLedgerSnapshot {
    const records = this.order
      .map((id) => this.records.get(id))
      .filter((record): record is MutableAgentExecutionRecord => record !== undefined)
      .map(immutable)
      .reverse();
    return {
      records,
      total: records.length,
      running: records.filter((record) => record.status === 'running').length,
      succeeded: records.filter((record) => record.status === 'succeeded').length,
      failed: records.filter((record) => record.status === 'failed').length,
      cancelled: records.filter((record) => record.status === 'cancelled').length,
    };
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }

  private toolFacts(tool: string): ToolFacts | undefined {
    const known = ENGINE_TOOL_ROUTES[tool];
    if (known) return known;
    try { return definitionFacts(this.options.describeTool?.(tool)); }
    catch { return undefined; }
  }

  /** Resolves once every route-kind reading started so far has been applied. */
  public async settled(): Promise<void> {
    // Domain delivery itself is deferred by RuntimeEventBus.
    await Promise.resolve();
    while (this.pending.size > 0) await Promise.all([...this.pending.values()].map((entry) => entry.done));
  }

  public dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeTurns();
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
    this.subscribers.clear();
  }

  private handleToolEvent(event: ToolEvent, timestamp: number): void {
    if (this.disposed || !('callId' in event)) return;
    if (event.type === 'TOOL_RECEIVED') this.recordReceived(event, timestamp);
    else this.applyLifecycleEvent(event, timestamp);
  }

  private applyLifecycleEvent(event: Extract<ToolEvent, { callId: string }>, timestamp: number): void {
    if (this.disposed) return;
    const existing = this.recordFor(event.turnId, event.callId);
    if (!existing || existing.status !== 'running') return;
    existing.phase = event.type;
    existing.status = statusForPhase(event.type);
    existing.updatedAt = timestamp;
    if (event.type === 'TOOL_PERMISSIONED') {
      existing.permissionApproved = event.approved;
      if (event.autonomousDecision) existing.autonomousDecision = structuredClone(event.autonomousDecision);
    }
    if (event.type === 'TOOL_SUCCEEDED') {
      existing.completedAt = timestamp;
      existing.durationMs = event.durationMs;
      existing.resultSummary = resultSummaryFrom(event.result);
      if (event.result?.autonomousDecision) existing.autonomousDecision = structuredClone(event.result.autonomousDecision);
    }
    if (event.type === 'TOOL_FAILED') {
      existing.completedAt = timestamp;
      existing.durationMs = event.durationMs;
      existing.error = truncateText(event.error, 220);
      existing.resultSummary = resultSummaryFrom(event.result);
      if (event.result?.autonomousDecision) existing.autonomousDecision = structuredClone(event.result.autonomousDecision);
    }
    if (event.type === 'TOOL_CANCELLED') {
      const pending = this.pending.get(existing.id);
      if (pending) {
        pending.cancel();
        this.pending.delete(existing.id);
        existing.argsReadingError ??= READING_CANCELLED;
        existing.routeKindError ??= READING_CANCELLED;
      }
      existing.completedAt = timestamp;
      existing.cancelReason = event.reason ? truncateText(event.reason, 220) : undefined;
    }
    this.notify();
  }

  /**
   * A call that never reported a result (cancelled while it was being
   * admitted, for example) cannot stay "running" once its turn has ended.
   */
  private settleTurn(turnId: string, timestamp: number): void {
    if (this.disposed) return;
    let changed = false;
    for (const record of this.records.values()) {
      if (record.turnId !== turnId || record.status !== 'running') continue;
      const pending = this.pending.get(record.id);
      if (pending) {
        pending.cancel();
        this.pending.delete(record.id);
        record.argsReadingError ??= READING_CANCELLED;
        record.routeKindError ??= READING_CANCELLED;
      }
      record.status = 'cancelled';
      record.completedAt = timestamp;
      record.updatedAt = timestamp;
      record.cancelReason = 'The turn ended before this call reported a result.';
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The record of one call: call ids are only unique within a turn. */
  private recordFor(turnId: string, callId: string): MutableAgentExecutionRecord | undefined {
    const first = this.records.get(callId);
    if (first && first.turnId === turnId) return first;
    return this.records.get(`${turnId}/${callId}`);
  }

  private recordReceived(event: Extract<ToolEvent, { type: 'TOOL_RECEIVED' }>, timestamp: number): void {
    return withConfiguredDecisionModelPolicy(() => this.recordOwnedReceived(event, timestamp));
  }

  private recordOwnedReceived(event: Extract<ToolEvent, { type: 'TOOL_RECEIVED' }>, timestamp: number): void {
    // Capture at delivery, before our first await. The event bus owns the
    // earlier asynchronous dispatch boundary; this is not an emitter snapshot.
    if (this.recordFor(event.turnId, event.callId)) return;
    // A provider may reuse a short call id in a later turn; that is a different call and
    // its record gets its own key, while a repeat inside one turn is the same call.
    const recordId = this.records.has(event.callId) ? `${event.turnId}/${event.callId}` : event.callId;
    const startedClassic = isClassicOperation();
    let args: Record<string, unknown> = {};
    let refusal: string | undefined;
    try { args = snapshotJudgmentInput(event.args, event.tool) as Record<string, unknown>; }
    catch (error) {
      refusal = error instanceof JudgmentInputError ? error.message : ARG_READING_FAILED;
    }
    const record: MutableAgentExecutionRecord = {
      ...(startedClassic ? { operationProvenance: 'classic' as const, semanticAssessment: 'not-evaluated' as const } : {}),
      id: recordId, callId: event.callId, turnId: event.turnId,
      // A known tool's name is not input; only an unknown one could carry the refused text.
      tool: refusal && !this.toolFacts(event.tool) ? '[protected tool call]' : event.tool,
      routeKind: 'other', status: 'running', phase: event.type,
      receivedAt: timestamp, updatedAt: timestamp,
      argsPreview: refusal ? '[redacted: protected input]' : startedClassic ? '[No decision model: argument values withheld; semantic roles unassessed]' : '[judgment pending: values withheld]',
      argsKeys: [],
      ...(refusal ? { routeKindError: refusal, argsReadingError: refusal } : {}),
    };
    // Receipt order, retention, and lifecycle visibility do not depend on the
    // speed (or eventual availability) of a hosted judgment.
    this.records.set(record.id, record);
    this.order.push(record.id);
    while (this.order.length > this.limit) {
      const dropped = this.order.shift();
      if (dropped) {
        this.pending.get(dropped)?.cancel();
        this.pending.delete(dropped);
        this.records.delete(dropped);
      }
    }
    this.notify();
    if (this.disposed || refusal || this.records.get(record.id) !== record) return;
    const facts = this.toolFacts(event.tool);
    if (facts) {
      // Decided by code from the tool's own facts, in every mode, with no reading.
      const roles = namedRoles(args);
      const commands = facts.kind === 'shell' ? (facts.commands ? declaredValues(args, facts.commands) ?? [] : shellCommandsIn(args)) : [];
      const command = commands.find((entry) => entry.trim().length > 0);
      const target = firstDeclared(args, facts.targets);
      record.routeKind = facts.kind;
      record.argsPreview = argsPreview(args, roles);
      record.argsKeys = Object.keys(args).filter((key) => roles.get(key)?.credential === false).sort();
      record.commandPreview = command ? truncateText(command, 180) : undefined;
      record.targetPreview = target ? truncateText(target, 180) : undefined;
      record.verification = commands.some(runsCheck);
      this.notify();
      return;
    }
    const markClassic = (partial: boolean): void => {
      record.operationProvenance = 'classic'; record.semanticAssessment = partial ? 'partial' : 'not-evaluated';
      record.argsPreview = '[No decision model: argument values withheld; semantic roles unassessed]';
      record.argsKeys = []; record.routeKind = 'other'; record.verification = undefined;
      record.commandPreview = undefined; record.targetPreview = undefined;
    };
    if (isClassicOperation()) { markClassic(false); this.notify(); return; }
    if (isYoloExecution()) {
      record.argsPreview = '[YOLO: values withheld]';
      this.notify();
      return;
    }

    const controller = new AbortController();
    let release: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => { release = resolve; });
    const active = () => !this.disposed && !controller.signal.aborted && this.records.get(record.id) === record;
    const enrich = async (): Promise<void> => {
      // The argument reader sees names only. Credential/uncertain values
      // cannot reach the independent, value-bearing route reader.
      const roles = await readArgRolesReported(record.tool, args, controller.signal);
      if (!active()) return;
      if (roles.classic) { markClassic(false); this.notify(); return; }
      const safeArgs = readingArgs(args, roles.roles) as Record<string, unknown>;
      const route = roles.error
        ? { routeKind: 'other' as const, routeKindError: ARG_READING_FAILED }
        : await readRouteKind(record.tool, safeArgs, controller.signal);
      if (!active()) return;
      if ('classic' in route && route.classic) { markClassic(true); this.notify(); return; }
      record.routeKind = route.routeKind;
      record.routeKindError = route.routeKindError;
      record.argsReadingError = roles.error;
      record.argsPreview = argsPreview(args, roles.roles);
      record.argsKeys = Object.keys(args).filter((key) => roles.roles?.get(key)?.credential === false).sort();
      const command = shellCommandsIn(safeArgs)[0];
      record.commandPreview = command && command !== '[redacted]' && command.trim() ? truncateText(command, 180) : undefined;
      record.targetPreview = targetPreview(args, roles.roles);
      this.notify();
      // Only a shell-like or unrecognised tool can run a check of correctness.
      if (!roles.error && route.routeKind !== 'shell' && route.routeKind !== 'other') {
        record.verification = false; this.notify();
      } else if (!roles.error) {
        try {
          const verification = await decisionOrClassic<boolean | undefined>(() => readExecutionPurpose(record.tool, safeArgs, controller.signal),
            () => { controller.signal.throwIfAborted(); return undefined; }, () => { controller.signal.throwIfAborted(); return true; });
          if (active()) {
            if (isClassicOperation()) { record.operationProvenance = 'classic'; record.semanticAssessment = 'partial'; }
            record.verification = verification; this.notify();
          }
        } catch { /* Unknown purpose stays unclassified; lifecycle history remains visible. */ }
      }
    };
    const enrichSafely = async (): Promise<void> => {
      try { await enrich(); }
      catch {
        // Never name the error: it can echo argument values. The record keeps its values withheld.
        logger.warn('AgentExecutionLedger: enrichment failed');
        if (!active()) return;
        record.argsReadingError ??= ARG_READING_FAILED;
        record.routeKindError ??= ROUTE_READING_FAILED;
        record.argsPreview = '[redacted: values withheld]';
        this.notify();
      }
    };
    const done = Promise.race([enrichSafely(), cancelled]).then(() => {
      if (this.pending.get(record.id)?.done === done) this.pending.delete(record.id);
    });
    this.pending.set(record.id, { done, cancel: () => { controller.abort(); release(); } });
  }

  private notify(): void {
    for (const callback of this.subscribers) {
      try { callback(); }
      catch { logger.warn('AgentExecutionLedger: subscriber failed'); }
    }
  }
}
