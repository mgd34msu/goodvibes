import { KVState } from '../../state/kv-state.js';
import { ProjectIndex } from '../../state/project-index.js';
import { ModeManager, type HITLMode } from '../../state/mode-manager.js';
import { HookDispatcher } from '../../hooks/dispatcher.js';
import { TelemetryDB } from '../../state/telemetry.js';
import type { TelemetryFilter } from '../../state/telemetry.js';
import { logger } from '../../utils/logger.js';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { STATE_TOOL_SCHEMA } from './schema.js';
import type { ContextAccountingSource } from '../context-accounting/index.js';
import type { StateInput } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  listMemoryRecords,
  memoryRecordsForKey,
  memoryValueRefusal,
  saveMemoryRecord,
  type StateMemoryStore,
} from './memory-mirror.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reserved keys that callers cannot set or clear through the state tool. */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

function summarizeEntries(entries: Record<string, unknown>): Array<{ key: string; type: string }> {
  return Object.entries(entries).map(([key, value]) => ({
    key,
    type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
  }));
}

/**
 * Sanitize a memory key to prevent path traversal.
 * Only alphanumeric characters, hyphens, and underscores are allowed.
 * Returns null if the key is invalid.
 */
function sanitizeMemoryKey(key: string): string | null {
  if (!key) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return null;
  return key;
}

/** The slice of the workspace swap manager the state tool uses. */
export interface StateSwapManager {
  requestSwap(newDir: string): Promise<{
    ok: boolean; reason?: string; code?: string; current?: string; previous?: string;
    restartRequired?: boolean; requiresRestart?: readonly string[] | undefined; note?: string;
  }>;
}

/** A change to the registered hooks, shown to the approval gate before it is made. */
export interface HookChangeRequest {
  readonly action: 'add' | 'enable' | 'disable' | 'remove';
  /** The event the hook is (or will be) registered under. */
  readonly eventPattern: string;
  /** The hook being added, or the existing hook being changed. */
  readonly hook: import('../../hooks/types.js').HookDefinition;
}

/**
 * Decides whether a model-requested hook change may happen. A hook runs a command, a script or a request
 * on events, so the approval has to be the one the same command, script or request would need if the model
 * ran it directly. The host wires this to the permission manager; without it, hook changes are refused.
 */
export type HookChangeGate = (request: HookChangeRequest, execution: { readonly signal?: AbortSignal | undefined }) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>;

export interface StateToolOptions {
  readonly hookDispatcher?: HookDispatcher | undefined;
  /** Approval for hook changes (add/enable/disable/remove). Absent: `mode=hooks` can list but not change. */
  readonly hookGate?: HookChangeGate | undefined;
  /** How much the terminal apps print (`behavior.hitlMode`): read by `mode=mode`. */
  readonly modeManager?: ModeManager | undefined;
  /** Saves a new print level for the host (the `behavior.hitlMode` setting). Absent: `mode=mode` can read but not change it. */
  readonly setPrintLevel?: ((level: HITLMode) => void) | undefined;
  /** The process's tool-call log (state/telemetry.ts), fed where tools run. Absent: `mode=analytics` is not offered. */
  readonly telemetryDB?: TelemetryDB | undefined;
  /**
   * Current working directory at session start. Exposed as the well-known
   * read-only key `runtime.workingDir` via `mode=get`.
   * The directory this host runs in; a saved change applies at the next start.
   */
  readonly workingDir?: string | (() => string | undefined) | undefined;
  /**
   * Daemon home directory (immutable after startup). Exposed as the well-known
   * read-only key `daemon.homeDir` via `mode=get`.
   */
  readonly daemonHomeDir?: string | (() => string | undefined) | undefined;
  /**
   * Workspace swap manager. When provided, `set({values: {'runtime.workingDir': '/new/path'}})`
   * saves the new working directory for the next start via `requestSwap()` instead of
   * returning an error. Failures are surfaced as `success: false` with the error reason.
   */
  readonly swapManager?: StateSwapManager;
  /**
   * The project memory store `mode=memory` reads and writes: the host's memory
   * spine (which reaches a connected host when it serves memory), or a local
   * registry behind `createLocalMemoryAccess`. A key is one row in it, the row
   * prompt retrieval reads. Absent: `mode=memory` is not offered.
   */
  readonly memory?: StateMemoryStore | undefined;
  /**
   * The live session's token and context state (the holder the
   * context_accounting tool reads). `mode=budget` reports its token usage and
   * turns, `mode=context` its context window; unbound, they say so.
   */
  readonly contextAccounting?: { getSource(): ContextAccountingSource | null } | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `state` tool bound to the given KVState and ProjectIndex.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createStateTool(
  kvState: KVState,
  projectIndex: ProjectIndex,
  options: StateToolOptions,
): Tool {
  const memory = options.memory;
  const hookDispatcher = options.hookDispatcher;
  const hookGate = options.hookGate;
  const modeManager = options.modeManager;
  const telemetryDB = options.telemetryDB;
  // A getter reads the host's working directory each call; a plain string is a fixed answer.
  const workingDir = (): string | undefined => typeof options.workingDir === 'function' ? options.workingDir() : options.workingDir;
  const daemonHomeDir = (): string | undefined => typeof options.daemonHomeDir === 'function' ? options.daemonHomeDir() : options.daemonHomeDir;
  const swapManager = options.swapManager;
  // Session start time and telemetry are scoped per-instance so multiple
  // createStateTool() calls don't share state.
  const SESSION_START_MS = Date.now();
  const _telemetry = {
    toolCalls: 0,
    errors: 0,
  };

  // Only modes this session can serve are advertised; the others are refused
  // with the list of available ones.
  const unavailableModes = new Set<string>([
    ...(hookDispatcher ? [] : ['hooks']),
    ...(telemetryDB ? [] : ['analytics']),
    ...(memory ? [] : ['memory']),
  ]);
  const definition: ToolDefinition = {
    name: 'state',
    // Sent in full on every model request (see ToolDefinition.core).
    core: true,
    description:
      'Access and manipulate session state. Modes: get/set/list/clear operate on KVState;'
      + ' budget reports this session\'s measured token usage and turns, context its context window (last request size, window size, compaction), both with the files this product has read or written in this workspace;'
      + (memory ? ' memory reads, writes, lists and deletes project memories by key; a memory is the record prompts retrieve, so what get shows is what the model is given;' : '')
      + ' telemetry reports this tool\'s call counts and how many of them failed or were refused;'
      + (hookDispatcher ? ' hooks lists registered hooks and, with the same approval running their command would need, changes them (enable/disable/add/remove);' : '')
      + ' mode reads or sets how much the terminal app prints: quiet, balanced or operator (get/set/list).'
      + ' Discovery: use mode=list to see existing KV keys,'
      + (hookDispatcher ? ' mode=hooks hookAction=list to see registered hooks,' : '')
      + ' mode=mode modeAction=get to see the current print level.'
      + [
        ...(memory ? [' mode=memory memoryAction=list lists memory keys.'] : []),
        ...(telemetryDB ? [' mode=analytics analyticsAction=summary shows the tool calls this process ran (name, status, duration, result size).'] : []),
      ].join(''),
    parameters: narrowStateModes(toRecord(STATE_TOOL_SCHEMA), unavailableModes),
    sideEffects: ['state'],
    concurrency: 'serial',
  };
  const availableModes = STATE_TOOL_SCHEMA.properties.mode.enum.filter((mode) => !unavailableModes.has(mode));

  async function execute(
    args: Record<string, unknown>,
    executionOptions?: ToolExecuteOptions,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return withConfiguredDecisionModelPolicy(async () => {
      _telemetry.toolCalls++;
      const result = await dispatch(args, executionOptions);
      // Every refusal and failure counts, not only thrown ones.
      if (!result.success) _telemetry.errors++;
      return result;
    });
  }

  async function dispatch(
    args: Record<string, unknown>,
    executionOptions?: ToolExecuteOptions,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const signal = executionOptions?.signal;
      // Still wanted: the call's signal and the registry's own check of this call.
      const current = () => {
        signal?.throwIfAborted();
        executionOptions?.assertCurrent?.(args);
      };
      current();
      if (typeof args.mode !== 'string') {
        return { success: false, error: 'Missing or invalid "mode" field (string required)' };
      }
      const input = args as unknown as StateInput;
      const { mode } = input;

      switch (mode) {
        case 'get':   return await runGet(input, kvState, workingDir(), daemonHomeDir());
        case 'set':   return await runSet(input, kvState, swapManager);
        case 'list':  return await runList(input, kvState);
        case 'clear': return await runClear(input, kvState);
        case 'budget': return runBudget(kvState, projectIndex, options.contextAccounting?.getSource() ?? null);
        case 'context': return runContext(kvState, projectIndex, options.contextAccounting?.getSource() ?? null);
        case 'memory':
          if (!memory) return unavailableMode('memory', 'this session has no project memory store', availableModes);
          return await runMemory(input, memory, { signal, assertCurrent: current });
        case 'telemetry': return await runTelemetry();
        case 'hooks':
          if (!hookDispatcher) return unavailableMode('hooks', 'hook registration belongs to the user\'s hook settings, not this tool', availableModes);
          return await runHooks(input, hookDispatcher, hookGate, signal);
        case 'mode': return runMode(input, modeManager, options.setPrintLevel);
        case 'analytics':
          if (!telemetryDB) return unavailableMode('analytics', 'this session has no telemetry store; mode=telemetry reports this tool\'s call counts', availableModes);
          return runAnalytics(input, telemetryDB);
        default:
          return { success: false, error: `Unknown mode: ${String(mode)}` };
      }
    } catch (err) {
      const message = summarizeError(err);
      logger.error('state tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  function runTelemetry(): { success: boolean; output?: string; error?: string } {
    const durationMs = Date.now() - SESSION_START_MS;
    return {
      success: true,
      output: JSON.stringify({
        mode: 'telemetry',
        session_duration_ms: durationMs,
        tool_calls: _telemetry.toolCalls,
        errors: _telemetry.errors,
      }),
    };
  }

  return { definition, execute };
}

function unavailableMode(mode: string, why: string, available: readonly string[]): { success: false; error: string } {
  return { success: false, error: `state mode=${mode} is not available in this session: ${why}. Nothing was read or changed; do not retry. Available modes: ${available.join(', ')}.` };
}

function narrowStateModes(parameters: Record<string, unknown>, unavailable: ReadonlySet<string>): Record<string, unknown> {
  if (unavailable.size === 0) return parameters;
  const properties = parameters.properties as Record<string, { enum?: readonly string[] }>;
  const mode = properties.mode;
  if (!mode?.enum) return parameters;
  return { ...parameters, properties: { ...properties, mode: { ...mode, enum: mode.enum.filter((value) => !unavailable.has(value)) } } };
}

// ---------------------------------------------------------------------------
// Analytics handler
// ---------------------------------------------------------------------------

const ANALYTICS_EXPORT_MAX_CHARS = 50_000;

function runAnalytics(
  input: StateInput,
  db: TelemetryDB,
): { success: boolean; output?: string; error?: string } {
  const action = input.analyticsAction ?? 'summary';
  const view = input.view ?? 'summary';

  if (action === 'query') {
    const rawFilter = input.analyticsFilter ?? {};
    const filter: TelemetryFilter = {
      tool: typeof rawFilter.tool === 'string' ? rawFilter.tool : undefined,
      status: rawFilter.status === 'ok' || rawFilter.status === 'error' || rawFilter.status === 'cancelled' ? rawFilter.status : undefined,
      since: typeof rawFilter.since === 'number' ? rawFilter.since : undefined,
      until: typeof rawFilter.until === 'number' ? rawFilter.until : undefined,
      limit: typeof rawFilter.limit === 'number' ? rawFilter.limit : undefined,
    };
    try {
      const records = db.query(filter);
      return {
        success: true,
        output: JSON.stringify({
          mode: 'analytics',
          action: 'query',
          view,
          count: records.length,
          records: view === 'full'
            ? records
            : records.map((record) => ({
              tool: record.tool,
              status: record.status,
              durationMs: record.duration_ms,
              tokenCount: record.tokens,
              resultBytes: record.result_bytes,
              timestamp: record.timestamp,
            })),
        }),
      };
    } catch (err) {
      return { success: false, error: `query failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'summary') {
    try {
      const summary = db.getSummary();
      return {
        success: true,
        output: JSON.stringify({ mode: 'analytics', action: 'summary', ...summary }),
      };
    } catch (err) {
      return { success: false, error: `summary failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'export') {
    const format = input.analyticsFormat ?? 'json';
    try {
      const exported = db.export(format);
      // Up to the row cap of calls: a bounded slice is returned, not the whole history.
      const truncated = exported.length > ANALYTICS_EXPORT_MAX_CHARS;
      const data = truncated ? exported.slice(0, ANALYTICS_EXPORT_MAX_CHARS) : exported;
      return {
        success: true,
        output: JSON.stringify({
          mode: 'analytics', action: 'export', format, data,
          ...(truncated ? { truncated: true, note: `Export cut at ${ANALYTICS_EXPORT_MAX_CHARS} characters of ${exported.length}. Use action=query with a filter (tool, since, until, limit) for the rest.` } : {}),
        }),
      };
    } catch (err) {
      return { success: false, error: `export failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'dashboard') {
    try {
      const summary = db.getSummary();
      const recentRecords = db.query({ limit: 10 });
      return {
        success: true,
        output: JSON.stringify({
          mode: 'analytics',
          action: 'dashboard',
          view,
          summary,
          recent: view === 'full'
            ? recentRecords
            : recentRecords.map((record) => ({
              tool: record.tool,
              status: record.status,
              durationMs: record.duration_ms,
              tokenCount: record.tokens,
              timestamp: record.timestamp,
            })),
        }),
      };
    } catch (err) {
      return { success: false, error: `dashboard failed: ${summarizeError(err)}` };
    }
  }

  return { success: false, error: `Unknown analytics action: ${String(action)}` };
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

async function runHooks(
  input: StateInput,
  dispatcher: HookDispatcher | undefined,
  gate: HookChangeGate | undefined,
  signal: AbortSignal | undefined,
): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!dispatcher) {
    return { success: false, error: 'hooks mode requires a HookDispatcher (not provided at startup)' };
  }

  const action = input.hookAction ?? 'list';

  if (action !== 'list' && gate === undefined) {
    return { success: false, error: 'A hook runs on events (and an http hook sends their tool arguments and results to its URL), so changing one is always put to the owner, and this session cannot ask for it. '
      + 'Nothing was changed; do not retry. mode=hooks hookAction=list still works; ask the user to change hooks in their settings.' };
  }
  // Every change is gated and asked every time, including enable/disable/remove: re-enabling a hook the user
  // turned off runs it, and removing or disabling one lifts whatever protection it gave.
  const approve = async (request: HookChangeRequest): Promise<{ success: false; error: string } | undefined> => {
    const verdict = await gate!(request, { signal });
    if (verdict.approved) return undefined;
    return { success: false, error: `Hook change refused${verdict.reason ? `: ${verdict.reason}` : ''}. Nothing was changed; do not retry the same change.` };
  };
  const existing = (name: string | undefined) => name === undefined ? undefined : dispatcher.listHooks().find(entry => entry.hook.name === name);

  if (action === 'list') {
    const entries = dispatcher.listHooks();
    const view = input.view ?? 'summary';
    return {
      success: true,
      output: JSON.stringify({
        mode: 'hooks',
        action: 'list',
        view,
        count: entries.length,
        hooks: entries.map(({ pattern, hook }) => {
          const summary = {
            pattern,
            name: hook.name ?? null,
            type: hook.type,
            match: hook.match,
            enabled: hook.enabled !== false,
            description: hook.description ?? null,
          };
          return view === 'full' ? { ...summary, hook } : summary;
        }),
      }),
    };
  }

  if (action === 'enable') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "enable" requires "hookName"' };
    const target = existing(name);
    if (target) { const refused = await approve({ action: 'enable', eventPattern: target.pattern, hook: target.hook }); if (refused) return refused; }
    const found = dispatcher.enableHook(name);
    if (!found) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'enable', name, enabled: true }) };
  }

  if (action === 'disable') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "disable" requires "hookName"' };
    const target = existing(name);
    if (target) { const refused = await approve({ action: 'disable', eventPattern: target.pattern, hook: target.hook }); if (refused) return refused; }
    const found = dispatcher.disableHook(name);
    if (!found) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'disable', name, enabled: false }) };
  }

  if (action === 'remove') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "remove" requires "hookName"' };
    const target = existing(name);
    if (target) { const refused = await approve({ action: 'remove', eventPattern: target.pattern, hook: target.hook }); if (refused) return refused; }
    const removed = dispatcher.unregister(name);
    if (!removed) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'remove', name }) };
  }

  if (action === 'add') {
    const def = input.hookDefinition;
    if (!def) return { success: false, error: 'hooks action "add" requires "hookDefinition"' };
    const { eventPattern, ...hookDef } = def;
    if (!eventPattern) return { success: false, error: 'hookDefinition.eventPattern is required' };
    if (!hookDef.type) return { success: false, error: 'hookDefinition.type is required' };
    if (!hookDef.match) return { success: false, error: 'hookDefinition.match is required' };
    const VALID_HOOK_TYPES = new Set(['command', 'http', 'ts']);
    if (!VALID_HOOK_TYPES.has(hookDef.type)) {
      return { success: false, error: `hookDefinition.type must be one of: command, http, ts` };
    }
    // Enable, disable and remove address a hook by name, so a hook without a unique name could never be managed again.
    if (typeof hookDef.name !== 'string' || hookDef.name.trim().length === 0) {
      return { success: false, error: 'hookDefinition.name is required: it is how the hook is later enabled, disabled or removed. Nothing was added.' };
    }
    if (existing(hookDef.name)) {
      return { success: false, error: `A hook named "${hookDef.name}" already exists. Choose another name, or remove the existing one first. Nothing was added.` };
    }
    const typeField = { command: 'command', http: 'url', ts: 'path' } as const;
    const requiredField = typeField[hookDef.type];
    const fieldValue: unknown = hookDef[requiredField];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      return { success: false, error: `hookDefinition.${requiredField} is required for a ${hookDef.type} hook. Nothing was added.` };
    }
    const refused = await approve({ action: 'add', eventPattern, hook: hookDef as import('../../hooks/types.js').HookDefinition });
    if (refused) return refused;
    // The approval above awaits; a parallel add of the same name may have registered while this one waited.
    if (existing(hookDef.name)) {
      return { success: false, error: `A hook named "${hookDef.name}" was added while this call waited for approval. Nothing was added; remove it first or choose another name.` };
    }
    dispatcher.register(eventPattern, hookDef as import('../../hooks/types.js').HookDefinition);
    return {
      success: true,
      output: JSON.stringify({
        mode: 'hooks', action: 'add', eventPattern, name: hookDef.name, persisted: false,
        note: 'The hook is registered for this session only; it is not written to the hooks file and is gone when the host restarts.',
      }),
    };
  }

  return { success: false, error: `Unknown hooks action: ${String(action)}` };
}

const PRINT_LEVELS: readonly HITLMode[] = ['quiet', 'balanced', 'operator'];

/**
 * The one print-less setting of the terminal apps (`behavior.hitlMode`):
 * quiet, balanced or operator. `set` saves the setting through the host;
 * the apps apply it at once.
 */
function runMode(
  input: StateInput,
  manager: ModeManager | undefined,
  setPrintLevel: ((level: HITLMode) => void) | undefined,
): { success: boolean; output?: string; error?: string } {
  if (!manager) {
    return { success: false, error: 'mode=mode is not available in this session: this host has no terminal print level. Nothing was read or changed.' };
  }
  const action = input.modeAction ?? 'get';
  const describe = () => {
    const preset = manager.getHITLPreset();
    return { level: preset.name, description: preset.description };
  };

  if (action === 'get') {
    return { success: true, output: JSON.stringify({ mode: 'mode', action: 'get', ...describe() }) };
  }

  if (action === 'list') {
    const current = manager.getHITLMode();
    return {
      success: true,
      output: JSON.stringify({
        mode: 'mode', action: 'list', current,
        levels: PRINT_LEVELS.map((name) => ({ name, description: manager.listHITLPresets().find((preset) => preset.name === name)?.description ?? '' })),
      }),
    };
  }

  if (action === 'set') {
    const name = input.modeName;
    if (!name || !PRINT_LEVELS.includes(name as HITLMode)) {
      return { success: false, error: `mode action "set" needs modeName quiet, balanced or operator${name ? ` (got "${name}")` : ''}. Nothing was changed.` };
    }
    if (!setPrintLevel) {
      return { success: false, error: 'This host cannot save the print level from a tool. Nothing was changed. The person can run /mode ' + name + ' in the terminal app.' };
    }
    try {
      setPrintLevel(name as HITLMode);
    } catch (err) {
      return { success: false, error: `The print level was not saved: ${summarizeError(err)}. Nothing was changed.` };
    }
    return { success: true, output: JSON.stringify({ mode: 'mode', action: 'set', ...describe(), saved: true }) };
  }

  return { success: false, error: `Unknown mode action: ${String(action)}. Use get, list or set.` };
}

/**
 * Well-known read-only keys surfaced directly by the state tool.
 * These keys are injected into the `get` response alongside KVState values
 * and rejected with an error in `set` to prevent mutation.
 */
const WELL_KNOWN_READONLY_KEYS = new Set(['runtime.workingDir', 'daemon.homeDir']);

async function runGet(
  input: StateInput,
  kvState: KVState,
  workingDir: string | undefined,
  daemonHomeDir: string | undefined,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const keys = input.keys ?? [];
  if (keys.length === 0) {
    return { success: false, error: 'mode "get" requires a non-empty "keys" array' };
  }
  // Separate well-known keys from regular KV keys
  const kvKeys = keys.filter((k) => !WELL_KNOWN_READONLY_KEYS.has(k));
  const values: Record<string, unknown> = kvKeys.length > 0 ? await kvState.get(kvKeys) : {};
  // Inject well-known read-only keys
  if (keys.includes('runtime.workingDir')) {
    values['runtime.workingDir'] = workingDir ?? null;
  }
  if (keys.includes('daemon.homeDir')) {
    values['daemon.homeDir'] = daemonHomeDir ?? null;
  }
  return { success: true, output: JSON.stringify({ mode: 'get', values }) };
}

async function runSet(
  input: StateInput,
  kvState: KVState,
  swapManager?: StateSwapManager,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const values = input.values;
  if (!values || typeof values !== 'object') {
    return { success: false, error: 'mode "set" requires a "values" object' };
  }

  // Handle runtime.workingDir specially, delegate to swap manager if available.
  if ('runtime.workingDir' in values) {
    const others = Object.keys(values).filter((key) => key !== 'runtime.workingDir');
    if (others.length > 0) {
      return {
        success: false,
        error: `runtime.workingDir changes the workspace and must be set on its own; it was sent together with ${others.join(', ')}. Nothing was changed. Send the working directory in one call and the other keys in another.`,
      };
    }
    const newDir = values['runtime.workingDir'];
    if (typeof newDir !== 'string' || !newDir.trim()) {
      return { success: false, error: 'runtime.workingDir must be a non-empty string.' };
    }
    if (!swapManager) {
      return {
        success: false,
        error: 'Cannot write to runtime.workingDir: this session runs without a daemon that can save a working-directory change. Nothing was changed; do not retry. To work in another directory, start goodvibes in that directory, or restart the daemon with --working-dir <path> (or GOODVIBES_WORKING_DIR), or set runtime.workingDir in settings.json in the daemon home and restart the daemon.',
      };
    }
    const result = await swapManager.requestSwap(newDir);
    if (!result.ok) {
      return { success: false, error: `Working directory not changed (${result.code ?? 'UNKNOWN'}): ${result.reason ?? 'unknown error'}` };
    }
    // Saved for the next start; this host keeps working in its current directory until then.
    return { success: true, output: JSON.stringify({
      mode: 'set', saved: true,
      workingDir: result.previous, savedWorkingDir: result.current ?? newDir,
      restartRequired: result.restartRequired ?? false,
      ...(result.requiresRestart?.length ? { movesOnRestart: result.requiresRestart } : {}),
      ...(result.note ? { note: result.note } : {}),
    }) };
  }

  // Reject writes to other read-only well-known keys
  const readonlyAttempts = Object.keys(values).filter((k) => WELL_KNOWN_READONLY_KEYS.has(k));
  if (readonlyAttempts.length > 0) {
    return {
      success: false,
      error: `Cannot write to read-only well-known key(s): ${readonlyAttempts.join(', ')}. These keys are immutable at runtime.`,
    };
  }
  const reservedAttempts = Object.keys(values).filter((k) => RESERVED_KEYS.has(k));
  if (reservedAttempts.length > 0) {
    return {
      success: false,
      error: `Cannot write reserved state key(s): ${reservedAttempts.join(', ')}.`,
    };
  }
  await kvState.set(values);
  const written = Object.keys(values);
  return {
    success: true,
    output: JSON.stringify({
      mode: 'set',
      keys_written: written.length,
      keys: written,
    }),
  };
}

async function runList(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const entries = await kvState.list(input.prefix);
  const view = input.view ?? 'summary';
  return {
    success: true,
    output: JSON.stringify({
      mode: 'list',
      view,
      prefix: input.prefix ?? null,
      count: Object.keys(entries).length,
      entries: view === 'full' ? entries : summarizeEntries(entries),
    }),
  };
}

async function runClear(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const keys = input.clearKeys ?? [];
  if (keys.length === 0) {
    return { success: false, error: 'mode "clear" requires a non-empty "clearKeys" array' };
  }
  const reservedAttempts = keys.filter((k) => RESERVED_KEYS.has(k));
  if (reservedAttempts.length > 0) {
    return {
      success: false,
      error: `Cannot clear reserved state key(s): ${reservedAttempts.join(', ')}.`,
    };
  }
  await kvState.clear(keys);
  return {
    success: true,
    output: JSON.stringify({
      mode: 'clear',
      keys_cleared: keys.length,
      keys,
    }),
  };
}

/** What this product has read or written in the workspace: the project index's count and estimate. */
function filesSeen(projectIndex: ProjectIndex): { count: number; estimated_tokens: number } {
  return { count: projectIndex.getFiles().length, estimated_tokens: projectIndex.getTotalTokens() };
}

const FILES_SEEN_NOTE = 'files_seen counts the files this product has read or written in this workspace (kept across restarts), not every file in the project.';
const UNBOUND_NOTE = 'No live session is bound to this tool here, so there is no token or context-window reading; the context_accounting tool says the same.';

/** The session's measured token usage and turns, from the live session the context_accounting tool reads. */
function runBudget(
  kvState: KVState,
  projectIndex: ProjectIndex,
  source: ContextAccountingSource | null,
): { success: boolean; output?: string; error?: string } {
  const tokens = source?.getTokenState();
  const turns = source?.getTurnState?.();
  return {
    success: true,
    output: JSON.stringify({
      mode: 'budget',
      session_id: kvState.getSessionId(),
      ...(source && tokens
        ? {
          scope: source.scope,
          tokens_used: {
            input: tokens.measured.input,
            output: tokens.measured.output,
            cache_read: tokens.measured.cacheRead,
            cache_write: tokens.measured.cacheWrite,
            total: tokens.measured.input + tokens.measured.output,
          },
          ...(turns ? { turns: { used: turns.used, limit: turns.limit } } : {}),
        }
        : { tokens_used: null }),
      files_seen: filesSeen(projectIndex),
      note: source ? FILES_SEEN_NOTE : `${UNBOUND_NOTE} ${FILES_SEEN_NOTE}`,
    }),
  };
}

/** The session's context window: what the last request put in it, its size, and compaction. */
function runContext(
  kvState: KVState,
  projectIndex: ProjectIndex,
  source: ContextAccountingSource | null,
): { success: boolean; output?: string; error?: string } {
  const tokens = source?.getTokenState();
  const compaction = source?.getCompactionState();
  const contextWindow = tokens?.contextWindow ?? null;
  return {
    success: true,
    output: JSON.stringify({
      mode: 'context',
      session_id: kvState.getSessionId(),
      ...(source && tokens
        ? {
          scope: source.scope,
          context_window: contextWindow,
          last_request_tokens: tokens.lastInputTokens,
          used_fraction: contextWindow && contextWindow > 0 ? Math.round((tokens.lastInputTokens / contextWindow) * 1000) / 1000 : null,
          ...(compaction ? { compacting: compaction.isCompacting, compactions: compaction.compactionCount ?? null } : {}),
        }
        : { context_window: null }),
      files_seen: filesSeen(projectIndex),
      note: source ? FILES_SEEN_NOTE : `${UNBOUND_NOTE} ${FILES_SEEN_NOTE}`,
    }),
  };
}

async function runMemory(
  input: StateInput,
  store: StateMemoryStore,
  options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void },
): Promise<{ success: boolean; output?: string; error?: string }> {
  const action = input.memoryAction ?? 'list';
  const view = action === 'get' ? (input.view ?? 'full') : (input.view ?? 'summary');
  const signal = options.signal;

  if (action === 'list') {
    try {
      const byKey = await listMemoryRecords(store, signal);
      const entries = [...byKey].sort(([a], [b]) => a.localeCompare(b));
      return {
        success: true,
        output: JSON.stringify({
          mode: 'memory',
          action: 'list',
          view,
          keys: entries.map(([key]) => key),
          ...(view === 'full' ? { entries: entries.map(([key, record]) => ({ key, bytes: Buffer.byteLength(record.detail ?? ''), cls: record.cls, review: record.reviewState, updatedAt: record.updatedAt })) } : {}),
        }),
      };
    } catch (err) {
      return { success: false, error: `Memory list failed: the memory store could not be read (${summarizeError(err)}). Try again; nothing was changed.` };
    }
  }

  const key = input.memoryKey;
  if (!key) {
    return { success: false, error: `memory action "${String(action)}" requires "memoryKey"` };
  }
  const safeKey = sanitizeMemoryKey(key);
  if (!safeKey) {
    return { success: false, error: 'Invalid memoryKey: must be alphanumeric, hyphens, or underscores only' };
  }

  if (action === 'get') {
    try {
      const record = (await memoryRecordsForKey(store, safeKey, signal))[0];
      if (!record) {
        return { success: true, output: JSON.stringify({ mode: 'memory', action: 'get', key: safeKey, value: null }) };
      }
      const raw = record.detail ?? record.summary;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      const facts = { cls: record.cls, review: record.reviewState, updatedAt: record.updatedAt };
      return {
        success: true,
        output: JSON.stringify(view === 'full'
          ? { mode: 'memory', action: 'get', view, key: safeKey, value, ...facts }
          : {
            mode: 'memory',
            action: 'get',
            view,
            key: safeKey,
            type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
            bytes: Buffer.byteLength(raw),
            ...facts,
          }),
      };
    } catch (err) {
      return { success: false, error: `Memory get failed: the memory store could not be read (${summarizeError(err)}). Try again.` };
    }
  }

  if (action === 'set') {
    const value = input.memoryValue;
    if (value === undefined || value === null) {
      return { success: false, error: 'memory action "set" requires "memoryValue"' };
    }
    const refusal = memoryValueRefusal(safeKey, value);
    if (refusal) return { success: false, error: `Memory ${safeKey} not saved: ${refusal}.` };
    try {
      options.assertCurrent();
      const saved = await saveMemoryRecord(store, safeKey, value, signal);
      return {
        success: true,
        output: JSON.stringify({ mode: 'memory', action: 'set', key: safeKey, bytes_written: Buffer.byteLength(value), retrievable: true,
          classification: 'pending', id: saved.id, ...(isClassicOperation() ? { provenance: 'classic' } : {}) }),
      };
    } catch (err) {
      return { success: false, error: `Memory ${safeKey} not saved: the memory store did not take the write (${summarizeError(err)}). Nothing was saved; try again.` };
    }
  }

  if (action === 'delete') {
    try {
      options.assertCurrent();
      const records = await memoryRecordsForKey(store, safeKey, signal);
      if (records.length === 0) {
        return { success: false, error: `No memory named "${safeKey}" exists. Use memoryAction=list to see the keys.` };
      }
      let removed = 0;
      for (const record of records) {
        if (await store.delete(record.id, signal ? { signal } : undefined)) removed++;
      }
      if (removed < records.length) {
        return { success: false, error: `Memory ${safeKey} was only partly deleted (${removed} of ${records.length} records); the rest may still be retrieved. Run delete again.` };
      }
      return { success: true, output: JSON.stringify({ mode: 'memory', action: 'delete', key: safeKey, records_deleted: removed }) };
    } catch (err) {
      return { success: false, error: `Memory delete failed: the memory store did not take the change (${summarizeError(err)}). Try again.` };
    }
  }

  return {
    success: false,
    error: `Unknown memory action: ${String(action)}`,
  };
}
