import { withBackgroundPrivilegeCheck } from './agent-harness-background-privilege.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { homedir } from 'node:os';
import { mapLimit } from '@goodvibes-jev/judgment';
import { redactSensitiveData, resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';
import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { processClassificationOptions, spawnBackgroundProcess, type ProcessClassificationOptions } from './agent-harness-process-launch.ts';
import { detachedProcessLogPath, findDetachedProcess, forgetDetachedProcess, listDetachedProcesses, readDetachedProcessLog, recordDetachedProcess, stopDetachedProcess,
  type DetachedProcessRecord } from './agent-harness-detached-processes.ts';
import { operatorContractMethods, type OperatorContractMethodEntry } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { BackgroundProcess, ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { acquireInteractiveRuntimeSnapshot, type InteractiveRuntimeParity } from './agent-harness-interactive-runtime-records.ts';
import { DEFAULT_BACKGROUND_TIMEOUT_MS, clampTimeout, clampWaitTimeout, processAgeMs, processStatus } from './agent-harness-process-timeout-policy.ts';
import type {
  AgentHarnessBackgroundProcessArgs,
  BackgroundProcessLookupSource,
  BackgroundProcessResolution,
  ProcessCapabilityStatus,
} from './agent-harness-background-processes-types.ts';
import { clampReadLimit } from './agent-harness-read-helpers.ts';
export type {
  AgentHarnessBackgroundProcessArgs,
  BackgroundProcessResolution,
} from './agent-harness-background-processes-types.ts';

const MAX_LOG_PREVIEW_CHARS = 4_000;
const MAX_COMPACT_LOG_PREVIEW_CHARS = 600;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const PROCESS_PARITY_METHODS = ['terminal(background=true)', 'process(list)', 'process(poll)', 'process(wait)', 'process(log)', 'process(kill)', 'process(write)', 'pty', 'sudo'] as const;
const STDIN_WRITE_METHOD_NAMES = ['writeInput'] as const;
const PTY_METHOD_NAMES = ['spawnPty', 'openPty', 'createPty', 'pty'] as const;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function fieldMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function readField(args: AgentHarnessBackgroundProcessArgs, id: string): string {
  return fieldMap(args.fields)[id] ?? '';
}

function readData(args: AgentHarnessBackgroundProcessArgs): string {
  if (typeof args.data === 'string') return args.data;
  const fromFields = readField(args, 'data');
  return fromFields;
}

function managerFrom(context: CommandContext): ProcessManager | undefined {
  return context.workspace.processManager;
}

type OperatorContractMethod = OperatorContractMethodEntry;

function operatorMethodSearchText(method: OperatorContractMethod): string {
  // EXCLUDES title/description prose: discovery keys off what a method IS
  // (id/route/category/scopes), not how its docs read, platform 1.4.0's "terminal
  // turn.cancelled event" wording false-matched as a terminal/TTY capability.
  return [
    method.id,
    method.category,
    method.http?.method,
    method.http?.path,
    method.scopes?.join(' '),
  ].filter(Boolean).join('\n').toLowerCase();
}

function matchingOperatorMethodRoutes(tokens: readonly string[]): readonly Record<string, unknown>[] {
  if (tokens.length === 0) return [];
  // \b-anchored: a raw text.includes(token) false-matches short tokens like 'pty' inside an unrelated word ('empty').
  const patterns = tokens.map((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  return operatorContractMethods()
    .filter((method) => {
      const text = operatorMethodSearchText(method);
      return patterns.some((pattern) => pattern.test(text));
    })
    .map((method) => ({
      methodId: method.id,
      label: method.title ?? method.description ?? method.id,
      category: method.category ?? 'uncategorized',
      effect: method.scopes?.every((scope) => scope.startsWith('read:')) ? 'read-only-network' : method.access === 'admin' ? 'admitted-admin-connected-host-state' : 'admitted-connected-host-state',
      route: `${method.http?.method?.toUpperCase() ?? 'GET'} ${method.http?.path ?? '/'}`,
      modelRoute: `agent_operator_method methodId:"${method.id}"`,
    }))
    .sort((left, right) => String(left.methodId).localeCompare(String(right.methodId)))
    .slice(0, 12);
}

function managerMethodNames(manager: ProcessManager | undefined): readonly string[] {
  if (!manager) return [];
  const own = Object.keys(manager);
  const prototype = Object.getPrototypeOf(manager) as Record<string, unknown> | null;
  const protoNames = prototype ? Object.getOwnPropertyNames(prototype) : [];
  return [...new Set([...own, ...protoNames])]
    .filter((name) => name !== 'constructor' && typeof (manager as unknown as Record<string, unknown>)[name] === 'function')
    .sort((left, right) => left.localeCompare(right));
}

/** The operator contract is bundled with the program, so the three route lists are built once. */
let processOperatorRoutes: {
  readonly terminalRoutes: readonly Record<string, unknown>[];
  readonly sessionInputRoutes: readonly Record<string, unknown>[];
  readonly credentialRoutes: readonly Record<string, unknown>[];
} | undefined;

function operatorRoutesForProcesses(): NonNullable<typeof processOperatorRoutes> {
  processOperatorRoutes ??= Object.freeze({
    terminalRoutes: Object.freeze(matchingOperatorMethodRoutes(['terminal', 'pty', 'process.write', 'stdin'])),
    sessionInputRoutes: Object.freeze(matchingOperatorMethodRoutes(['sessions.inputs'])),
    credentialRoutes: Object.freeze(matchingOperatorMethodRoutes(['credential', 'sudo', 'privilege'])),
  });
  return processOperatorRoutes;
}

function processSubstrateReport(context?: CommandContext): Record<string, unknown> {
  const manager = context ? managerFrom(context) : undefined;
  const methodNames = managerMethodNames(manager);
  const localStdinMethod = STDIN_WRITE_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const localPtyMethod = PTY_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const { terminalRoutes, sessionInputRoutes, credentialRoutes } = operatorRoutesForProcesses();
  return {
    localProcessManager: {
      status: manager ? 'available' : 'unavailable',
      methodNames,
      supports: methodNames.filter((name) => ['spawn', 'list', 'getStatus', 'getOutput', 'stop', 'handleCommand', localStdinMethod, localPtyMethod].filter(Boolean).includes(name)),
      stdinWrite: localStdinMethod
        ? { status: 'contract-discovered', method: localStdinMethod, executableByHarness: true }
        : { status: 'blocked-contract-gap', missingAnyOf: STDIN_WRITE_METHOD_NAMES },
      pty: localPtyMethod
        ? { status: 'candidate-method', method: localPtyMethod, executableByHarness: false }
        : { status: 'blocked-contract-gap', missingAnyOf: PTY_METHOD_NAMES },
    },
    daemonOperatorContract: {
      status: terminalRoutes.length > 0 ? 'candidate-methods-found' : 'no-candidate-methods',
      terminalOrPtyRoutes: terminalRoutes,
      sessionInputRoutes,
      credentialRoutes,
      policy: 'Session input routes steer GoodVibes sessions; they are not equivalent to writing stdin into a tracked local process.',
    },
  };
}

/**
 * The last `max` characters of a stream, starting at a line boundary, masked
 * locally. Only the tail is masked: its cost follows the preview, not the
 * output the process has printed. Counts are of the raw stream.
 */
function outputTail(value: string, max: number): {
  readonly text: string;
  readonly chars: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly omittedChars: number;
} {
  let tail = value;
  if (value.length > max) {
    tail = value.slice(value.length - max);
    // Start at a line boundary so a credential cut in half is not shown half masked.
    const newline = tail.indexOf('\n');
    tail = newline >= 0 && newline < tail.length - 1 ? tail.slice(newline + 1) : tail.trimStart();
  }
  const omittedChars = Math.max(0, value.length - tail.length);
  return {
    text: redactSensitiveData(tail),
    chars: value.length,
    bytes: Buffer.byteLength(value),
    truncated: omittedChars > 0,
    omittedChars,
  };
}

function routeFor(processId: string, mode: 'background_process' | 'run_background_process', action?: string): string {
  if (mode === 'background_process') return `execution action:"process" processId:"${processId}"`;
  const processAction = action === 'stop' ? 'kill' : action || 'poll';
  return `process action:"${processAction}" processId:"${processId}"`;
}

function readProcessSessionId(args: AgentHarnessBackgroundProcessArgs): { readonly source: BackgroundProcessLookupSource; readonly input: string } | null {
  const processId = readString(args.processId) || readField(args, 'processId');
  if (processId) return { source: 'processId', input: processId };
  const processSessionId = readString(args.processSessionId) || readField(args, 'processSessionId');
  if (processSessionId) return { source: 'processSessionId', input: processSessionId };
  const sessionId = readString(args.sessionId) || readField(args, 'sessionId');
  if (sessionId) return { source: 'sessionId', input: sessionId };
  const snakeSessionId = readString(args.session_id) || readField(args, 'session_id');
  if (snakeSessionId) return { source: 'session_id', input: snakeSessionId };
  return null;
}

async function describeProcessEntry(
  context: CommandContext,
  manager: ProcessManager,
  entry: BackgroundProcess,
  options: CatalogRankingOptions & { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const detached = context.workspace.shellPaths ? findDetachedProcess(context.workspace.shellPaths, entry.id) : undefined;
  const output = manager.getOutput(entry.id) ?? { stdout: '', stderr: '' };
  const command = redactSensitiveData(entry.cmd);
  const maxOutputChars = options.includeParameters ? MAX_LOG_PREVIEW_CHARS : MAX_COMPACT_LOG_PREVIEW_CHARS;
  const stdout = outputTail(output.stdout, maxOutputChars);
  const stderr = outputTail(output.stderr, maxOutputChars);
  const includeOutput = options.includeParameters === true || Boolean(stdout.text || stderr.text);
  return {
    processId: entry.id,
    lifetime: detached ? 'detached' : 'task',
    ...(detached ? { log: detachedLogView(detached, maxOutputChars) } : {}),
    pid: entry.pid,
    status: processStatus(entry),
    done: entry.done,
    exitCode: entry.exitCode,
    ...(entry.timedOut === true ? { timedOut: true } : {}),
    ...(entry.signal ? { signal: entry.signal } : {}),
    command: options.includeParameters ? command : previewHarnessText(command, 120),
    startedAt: new Date(entry.startTime).toISOString(),
    ageMs: processAgeMs(entry),
    routes: {
      inspect: routeFor(entry.id, 'background_process'),
      poll: routeFor(entry.id, 'run_background_process', 'poll'),
      log: routeFor(entry.id, 'run_background_process', 'log'),
      wait: routeFor(entry.id, 'run_background_process', 'wait'),
      stop: routeFor(entry.id, 'run_background_process', 'stop'),
      visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
      liveTail: `workspace action:"open" surfaceId:"live-tail" target:"${entry.id}"`,
    },
    ...(includeOutput ? {
      output: {
        stdoutTail: stdout.text,
        stderrTail: stderr.text,
        stdoutChars: stdout.chars,
        stderrChars: stderr.chars,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        omittedStdoutChars: stdout.omittedChars,
        omittedStderrChars: stderr.omittedChars,
        maxOutputChars,
        fullOutputIncluded: !stdout.truncated && !stderr.truncated,
        policy: 'The tail shown is masked for credentials; counts describe the whole captured output.',
      },
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

function trackedProcesses(manager: ProcessManager): readonly BackgroundProcess[] {
  return manager.list().flatMap((entry) => {
    const current = manager.getStatus(entry.id);
    return current ? [current] : [];
  });
}

function lookupFromArgs(args: AgentHarnessBackgroundProcessArgs): { readonly source: BackgroundProcessLookupSource; readonly input: string } | null {
  const processSession = readProcessSessionId(args);
  if (processSession) return processSession;
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function processCatalogEntry(entry: BackgroundProcess) {
  return { id: entry.id, pid: entry.pid, cmd: entry.cmd, status: processStatus(entry), done: entry.done,
    startedAt: new Date(entry.startTime).toISOString(), exitCode: entry.exitCode, timedOut: entry.timedOut, signal: entry.signal };
}

/** One look at the tracked processes; a listing is correct for the moment it was taken. */
async function matchingProcesses(manager: ProcessManager, input: string, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted();
  const entries = trackedProcesses(manager).map(processCatalogEntry);
  const assertCurrent = (): void => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  if (!input) return { all: entries, matches: entries.map((entry) => ({ entry, judgment: undefined })), judgments: [], assertCurrent };
  const ranked = await rankHarnessCatalog(entries, input, (entry) => ({ id: entry.id,
    description: `${entry.id}\n${entry.pid}\n${redactSensitiveData(entry.cmd)}\n${entry.status}` }),
    'agent.harness.background-processes', options);
  return { ...ranked, all: entries, assertCurrent };
}

/** A detached process's log tail, read from its file. */
function detachedLogView(record: DetachedProcessRecord, maxChars: number): Record<string, unknown> {
  const log = readDetachedProcessLog(record, maxChars);
  return { tail: log.text, bytes: log.bytes, truncated: log.truncated, path: homeRelative(record.logPath) };
}

/** A path under the user's home is shown from `~`, not as an absolute path naming the account. */
function homeRelative(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** A detached process from an earlier session: the Agent did not start it in this runtime, so only its record and log are known. */
function describeDetachedRecord(record: DetachedProcessRecord, includeParameters: boolean): Record<string, unknown> {
  return {
    processId: record.processId,
    lifetime: 'detached',
    status: 'running',
    pid: record.pid,
    command: includeParameters ? record.command : previewHarnessText(record.command, 120),
    cwd: record.cwd,
    startedAt: record.startedAt,
    log: detachedLogView(record, includeParameters ? MAX_LOG_PREVIEW_CHARS : MAX_COMPACT_LOG_PREVIEW_CHARS),
    routes: {
      log: routeFor(record.processId, 'run_background_process', 'log'),
      stop: routeFor(record.processId, 'run_background_process', 'stop'),
    },
    note: 'Started detached in an earlier session; it keeps running until it is stopped.',
  };
}

/** Detached processes recorded by earlier sessions that this runtime does not track. */
function earlierDetached(context: CommandContext, manager: ProcessManager): readonly DetachedProcessRecord[] {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) return [];
  return listDetachedProcesses(shellPaths).filter(record => !manager.getStatus(record.processId));
}

function processToolParity(context: CommandContext | undefined, interactive: InteractiveRuntimeParity | null): readonly Record<string, unknown>[] {
  const substrate = processSubstrateReport(context);
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  const writeStatus: ProcessCapabilityStatus = stdinWrite.status === 'contract-discovered'
    ? 'supported'
    : interactive?.stdinWriteContract ? 'contract-discovered'
    : 'blocked-contract-gap';
  const ptyStatus: ProcessCapabilityStatus = interactive?.ptyContract ? 'contract-discovered' : 'blocked-contract-gap';
  const sudoStatus: ProcessCapabilityStatus = interactive?.sudoMediationContract ? 'contract-discovered' : 'visible-only';
  return [
    {
      capability: 'terminal(background=true)',
      status: 'supported',
      userOutcome: 'Start one visible tracked local command without blocking the conversation.',
      modelRoute: 'terminal command:"..." background:true',
    },
    {
      capability: 'process(list)',
      status: 'supported',
      userOutcome: 'See every tracked local background process from the shared ProcessManager.',
      modelRoute: 'execution action:"processes"',
    },
    {
      capability: 'process(poll)',
      status: 'supported',
      userOutcome: 'Poll one tracked process status without waiting.',
      modelRoute: 'process action:"poll" processId:"..."',
    },
    {
      capability: 'process(wait)',
      status: 'supported',
      userOutcome: 'Wait on one tracked process with a bounded timeout.',
      modelRoute: 'process action:"wait" processId:"..."',
    },
    {
      capability: 'process(log)',
      status: 'supported',
      userOutcome: 'Read redacted stdout/stderr tails with explicit truncation metadata.',
      modelRoute: 'process action:"log" processId:"..."',
    },
    {
      capability: 'process(kill)',
      status: 'supported',
      userOutcome: 'Stop and remove one tracked process from the shared ProcessManager.',
      modelRoute: 'process action:"kill" processId:"..."',
    },
    {
      capability: 'process(write)',
      status: writeStatus,
      userOutcome: writeStatus === 'supported'
        ? 'Write to a running tracked native stdin pipe under current recorded effect admission.'
        : writeStatus === 'contract-discovered'
          ? 'A published interactive session record advertises its own write route; process action:"write" is unavailable because the local ProcessManager writeInput contract is missing.'
          : 'Input requires the local guarded ProcessManager writeInput contract.',
      // process action:"write" runs the local writeInput; offering it without that contract is a route that fails.
      ...(writeStatus === 'supported' ? { modelRoute: 'process action:"write" processId:"..." data:"..."' } : {}),
    },
    {
      capability: 'pty',
      status: ptyStatus,
      userOutcome: ptyStatus === 'contract-discovered'
        ? 'A PTY-like contract is discoverable; Agent still requires an explicit session API before generic PTY spawn is enabled.'
        : 'Interactive CLIs need a published PTY/session API before Agent can make them safe and visible.',
      // No route is offered: terminal pty:true answers unsupported until a PTY contract exists.
    },
    {
      capability: 'sudo',
      status: sudoStatus,
      userOutcome: sudoStatus === 'contract-discovered' ? 'A certified daemon mediation route is published for visible credential prompts.' : 'Privilege prompts must stay foreground or use a future safe credential-prompt contract.',
      modelRoute: 'execution action:"route" id:"local-shell-command"',
    },
  ];
}

async function capabilities(context?: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const snapshot = context ? await acquireInteractiveRuntimeSnapshot(context, options) : null;
  snapshot?.assertCurrent();
  const sudoPosture = sudoExecutionPosture(context);
  const substrate = processSubstrateReport(context);
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  return {
    start: 'terminal command:"..." background:true',
    lifetimes: {
      task: 'Default. Ended when the Agent closes, and at timeoutMs when one is given.',
      detached: 'lifetime:"detached": keeps running after the Agent exits; output goes to a log file; listed, logged and stoppable from later sessions.',
    },
    inspect: 'execution action:"processes" or action:"process"',
    wait: 'process action:"wait" processId:"..."',
    stop: 'process action:"kill" processId:"..."',
    aliases: {
      actions: {
        poll: 'status',
        kill: 'stop',
        log: 'output',
        write: 'writeInput on a running tracked native stdin pipe',
      },
      ids: ['processId', 'processSessionId', 'sessionId', 'session_id'],
      userOutcome: 'Any of these names is accepted as input; answers carry the id once, as processId.',
    },
    parity: processToolParity(context, snapshot?.parityStatus ?? null),
    substrate: {
      ...substrate,
      auditedTerms: ['terminal', 'process.write', 'stdin', 'pty', 'sudo', 'sessions.inputs'],
    },
    interactiveRuntime: snapshot?.capabilitySummary ?? null,
    pty: {
      status: snapshot?.parityStatus.ptyContract ? 'contract-discovered-but-not-generic-executable' : 'not-yet-supported-in-agent-harness',
      guidance: snapshot?.parityStatus.ptyContract
        ? 'A certified PTY runtime record is published. Use its confirmed session routes; generic PTY spawn is not exposed.'
        : 'Use foreground exec for noninteractive commands. Interactive PTY needs a published platform/daemon session API before Agent can expose it safely.',
    },
    stdinWrite: {
      status: stdinWrite.status === 'contract-discovered' ? 'supported' : 'unavailable',
      // process action:"write" runs the local writeInput; offering it without that contract is a route that fails.
      ...(stdinWrite.status === 'contract-discovered' ? { modelRoute: 'process action:"write" processId:"..." data:"..."' } : {}),
      guidance: stdinWrite.status === 'contract-discovered'
        ? 'Tracked launches open a native stdin pipe. Writes require current recorded admission and retain the exact process until the platform write and flush finish.'
        : 'The local guarded ProcessManager writeInput contract is unavailable.',
    },
    sudo: {
      ...sudoPosture,
      guidance: sudoPosture.credentialSignal.guidance,
    },
  };
}

export function backgroundProcessCatalogStatus(context: CommandContext): Record<string, unknown> {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      modes: ['background_processes', 'background_process', 'run_background_process'],
      status: 'unavailable',
      tracked: 0,
      running: 0,
      readOnly: false,
      reason: 'ProcessManager is not wired into this runtime.',
    };
  }
  const entries = trackedProcesses(manager);
  return {
    modes: ['background_processes', 'background_process', 'run_background_process'],
    status: 'available',
    tracked: entries.length,
    running: entries.filter((entry) => !entry.done).length,
    completed: entries.filter((entry) => entry.done).length,
    readOnly: false,
  };
}

export async function backgroundProcessSummary(context: CommandContext, args: AgentHarnessBackgroundProcessArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'unavailable',
      processes: [],
      returned: 0,
      total: 0,
      capabilities: await capabilities(context, options),
      policy: 'Background process UX uses the shared GoodVibes ProcessManager when the current runtime wires it in.',
    };
  }
  const query = readString(args.query || args.target);
  const selected = await matchingProcesses(manager, query, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const entries = selected.matches;
  const detached = earlierDetached(context, manager);
  const all = selected.all;
  const limit = readLimit(args.limit, 100);
  const processes = await mapLimit<(typeof entries)[number], Record<string, unknown>>(entries.slice(0, limit), 4, async ({ entry, judgment }) => {
    const current = manager.getStatus(entry.id);
    // A process that ended and was pruned between the look and this row is shown as it was seen.
    if (!current) return { ...entry, ...(judgment ? { judgment } : {}) };
    return { ...await describeProcessEntry(context, manager, current, { ...options, includeParameters: args.includeParameters === true }), ...(judgment ? { judgment } : {}) };
  });
  const processCapabilities = await capabilities(context, { ...options, assertCurrent: selected.assertCurrent });
  selected.assertCurrent();
  return {
    status: 'available',
    summary: {
      tracked: all.length,
      running: all.filter((entry) => !entry.done).length,
      completed: all.filter((entry) => entry.done).length,
      visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
      liveTail: 'workspace action:"open" surfaceId:"live-tail"',
    },
    processes,
    ...(detached.length > 0 ? { detachedFromEarlierSessions: detached.map(record => describeDetachedRecord(record, args.includeParameters === true)) } : {}),
    judgments: selected.judgments,
    returned: processes.length,
    total: all.length,
    capabilities: processCapabilities,
    policy: 'List/status/log/wait routes are read-only and bounded. Starting or stopping a background process requires current recorded effect admission.',
  };
}

export async function describeBackgroundProcess(context: CommandContext, args: AgentHarnessBackgroundProcessArgs, options: CatalogRankingOptions = {}): Promise<BackgroundProcessResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'missing_lookup',
      usage: 'Background processes are unavailable because ProcessManager is not wired into this runtime.',
    };
  }
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"process" requires processId, target, or query. Use execution action:"processes" to inspect tracked process ids.',
    };
  }
  const exact = manager.getStatus(lookup.input);
  if (exact) {
    return {
      status: 'found',
      process: await describeProcessEntry(context, manager, exact, {
        ...options,
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'id' },
      }),
    };
  }
  const earlier = context.workspace.shellPaths ? findDetachedProcess(context.workspace.shellPaths, lookup.input) : undefined;
  if (earlier) return { status: 'found', process: { ...describeDetachedRecord(earlier, true), lookup: { ...lookup, resolvedBy: 'id' } } };
  const selected = lookup.source === 'target' || lookup.source === 'query'
    ? await matchingProcesses(manager, lookup.input, options) : { matches: [], judgments: [] };
  const matches = selected.matches;
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') {
    const current = manager.getStatus(matches[0]!.entry.id);
    if (!current) return { status: 'missing_lookup', usage: `Process ${matches[0]!.entry.id} ended and its record was pruned. Use execution action:"processes" to inspect tracked process ids.` };
    return {
      status: 'found',
      process: { ...await describeProcessEntry(context, manager, current, {
        ...options,
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'search' },
      }), judgment: matches[0]!.judgment },
    };
  }
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: matches.slice(0, 8).map(({ entry, judgment }) => ({ processId: entry.id, pid: entry.pid, status: entry.status,
        command: previewHarnessText(redactSensitiveData(entry.cmd), 96), judgment })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown background process ${lookup.input}. Use execution action:"processes" to inspect tracked process ids.`,
  };
}

function readProcessAction(args: AgentHarnessBackgroundProcessArgs): string {
  const action = (
    readString(args.processAction)
    || readString(args.action)
    || readField(args, 'action')
    || (readString(args.command) || readField(args, 'command') ? 'start' : '')
  ).toLowerCase();
  if (action === 'poll') return 'status';
  if (action === 'kill') return 'stop';
  return action;
}

function readCommand(args: AgentHarnessBackgroundProcessArgs): string {
  return readString(args.command) || readField(args, 'command');
}

function readProcessId(args: AgentHarnessBackgroundProcessArgs): string {
  return readProcessSessionId(args)?.input || readString(args.target);
}

function readCwd(context: CommandContext, args: AgentHarnessBackgroundProcessArgs): string | undefined {
  const raw = readString(args.cwd) || readField(args, 'cwd');
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths?.workingDirectory) throw new Error('Background process start needs the workspace working directory, and this Agent context has none. Start the Agent inside the project directory, then start the process again.');
  return realpathSync(resolveAndValidatePath(raw || '.', shellPaths.workingDirectory));
}

/** The model gets the directory relative to the workspace, not an absolute path under the user's home. */
function workspaceRelativeLabel(context: CommandContext, cwd: string | undefined): string {
  const root = context.workspace.shellPaths?.workingDirectory;
  if (!cwd || !root) return '.';
  const label = relative(realpathSync(root), cwd);
  return label === '' ? '.' : label.startsWith('..') ? '(outside the workspace)' : label;
}

/** Waits on the process manager's completion signal: returns the moment the process ends, not on the next poll. */
async function waitForProcess(manager: ProcessManager, processId: string, timeoutMs: number, options: CatalogRankingOptions): Promise<BackgroundProcess | undefined> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  await manager.whenSettled(processId, timeoutMs, options.signal);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return manager.getStatus(processId);
}

export async function runBackgroundProcessAction(context: CommandContext, args: AgentHarnessBackgroundProcessArgs,
  options: ProcessClassificationOptions & CatalogRankingOptions = {}, originalArgs?: Record<string, unknown>, executionOptions?: Parameters<Tool['execute']>[1],
): Promise<Record<string, unknown>> {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'unavailable',
      done: false,
      reason: 'ProcessManager is not wired into this runtime.',
      policy: 'Use foreground exec or connected-host delegation until background process lifecycle is available.',
    };
  }

  if (args.pty === true || readField(args, 'pty').toLowerCase() === 'true') {
    return {
      ...((await capabilities(context, options)).pty as Record<string, unknown>),
      status: 'unsupported',
      done: false,
      capability: 'pty',
    };
  }

  const action = readProcessAction(args);
  const assertEffect = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (!originalArgs || !harnessCatalogInvocationAuthority(originalArgs, executionOptions, 'write')) throw new ToolInputProjectionError('held');
    if (managerFrom(context) !== manager) throw new ToolInputProjectionError('held');
  };
  if (action === 'write') {
    assertEffect();
    const processId = readProcessId(args), data = readData(args);
    if (!processId) throw new Error('Background process input requires processId.');
    if (!data) throw new Error('Background process input requires nonempty data.');
    const entry = manager.getStatus(processId);
    if (!entry) return { status: 'not_found', done: false, processId, reason: `No tracked process matched "${processId}"; nothing was written. Use process action:"list" to see the tracked ids.` };
    if (entry.done) {
      return { status: 'not_running', done: false, processId, exitCode: entry.exitCode, ...(entry.signal ? { signal: entry.signal } : {}),
        reason: `The process has ended (${entry.signal ? `signal ${entry.signal}` : `exit code ${entry.exitCode}`}); nothing was written.`,
        next: [`process action:"log" processId:"${processId}"`, 'process action:"start" to run it again'] };
    }
    const assertCurrent = () => {
      assertEffect();
      if (entry.done) throw new Error(`Process ${processId} ended while its input was being written; check process action:"log" processId:"${processId}".`);
    };
    const bytesWritten = await manager.writeInput(processId, data, { signal: options.signal, assertCurrent });
    return { status: 'written', done: true, processId,
      bytesWritten, policy: 'Input was written and flushed to the captured native stdin pipe. Bytes already handed to the child cannot be recalled.' };
  }
  if (action === 'capabilities' || action === 'doctor' || action === 'parity') {
    return {
      status: 'available',
      done: true,
      capabilities: await capabilities(context, options),
      methods: PROCESS_PARITY_METHODS,
      policy: 'This is a read-only process UX contract report. It does not start, stop, or write to any process.',
    };
  }
  if (action === 'start' || action === 'spawn' || action === 'run') {
    assertEffect();
    const command = readCommand(args);
    if (!command) throw new Error('Background process start requires command.');
    return withBackgroundPrivilegeCheck(command, options, async (privileged, assertPrivilegeCurrent, assessment) => {
      if (privileged !== false) {
        return {
          status: 'blocked',
          done: false,
          capability: 'sudo',
          reason: privileged === null
            ? assessment === 'uncertain'
              ? 'Whether this command needs a privilege prompt could not be settled. Use foreground execution with owner approval for this command.'
              : 'Privilege requirements were not assessed (no decision model). Use foreground execution with owner approval for this command.'
            : 'Background sudo prompts are not exposed by Agent because they can hang or hide privilege escalation.',
          ...(privileged === null ? { privilegeAssessment: assessment ?? 'not-evaluated', ...(assessment === 'not-evaluated' ? { provenance: 'classic' } : {}) } : {}),
          guidance: (await capabilities(context, options)).sudo,
        };
      }
      const cwd = readCwd(context, args);
      const shellPaths = context.workspace.shellPaths;
      if (!shellPaths?.workingDirectory) throw new Error('Background process start needs the workspace working directory, and this Agent context has none. Start the Agent inside the project directory, then start the process again.');
      const timeoutMs = clampTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_BACKGROUND_TIMEOUT_MS);
      const detachedRequested = (readString(args.lifetime) || readField(args, 'lifetime')) === 'detached';
      const logPath = detachedRequested ? detachedProcessLogPath(shellPaths) : undefined;
      assertPrivilegeCurrent();
      const { lifetime, killOnTimeout, result } = await spawnBackgroundProcess(manager, args, command, cwd, timeoutMs,
        { signal: options.signal, assertCurrent: () => { assertPrivilegeCurrent(); assertEffect(); } }, logPath);
      const cwdLabel = workspaceRelativeLabel(context, cwd);
      if (lifetime === 'detached' && result.process_id && result.pid && logPath) {
        recordDetachedProcess(shellPaths, { processId: result.process_id, pid: result.pid, command, cwd: cwdLabel, startedAt: new Date().toISOString(), logPath });
      }
      return {
        status: 'started',
        done: true,
        lifetime,
        killOnTimeout,
        lifetimeBehavior: lifetime === 'detached'
          ? `Keeps running after the Agent exits; output goes to ${homeRelative(logPath ?? '')}. Later sessions list it under process action:"list" and can stop it with process action:"kill".`
          : 'Ended when the Agent closes.',
        timeoutBehavior: timeoutMs === 0 ? 'No automatic deadline; stop it explicitly with process action:"kill".' : killOnTimeout
          ? `SIGTERM then SIGKILL after ${timeoutMs}ms.`
          : `Left running past ${timeoutMs}ms; stop it explicitly with process action:"kill".`,
        processId: result.process_id,
        pid: result.pid,
        command: redactSensitiveData(command),
        cwd: cwdLabel,
        timeoutMs,
        routes: {
          inspect: result.process_id ? routeFor(result.process_id, 'background_process') : null,
          poll: result.process_id ? routeFor(result.process_id, 'run_background_process', 'poll') : null,
          log: result.process_id ? routeFor(result.process_id, 'run_background_process', 'log') : null,
          wait: result.process_id ? routeFor(result.process_id, 'run_background_process', 'wait') : null,
          stop: result.process_id ? routeFor(result.process_id, 'run_background_process', 'stop') : null,
          visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
          liveTail: result.process_id ? `workspace action:"open" surfaceId:"live-tail" target:"${result.process_id}"` : null,
        },
        policy: 'Started as a tracked local background process with visible monitor/live-tail routes.',
      };
    });
  }

  if (action === 'stop' || action === 'kill' || action === 'cancel') {
    assertEffect();
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process stop requires processId.');
    const earlier = !manager.getStatus(processId) && context.workspace.shellPaths ? findDetachedProcess(context.workspace.shellPaths, processId) : undefined;
    if (earlier && context.workspace.shellPaths) {
      const signalled = stopDetachedProcess(context.workspace.shellPaths, earlier);
      return { status: signalled ? 'stopped' : 'not_found', done: signalled, processId, lifetime: 'detached',
        policy: signalled ? 'SIGTERM was sent to the detached process group started in an earlier session, and its record removed.' : 'The detached process had already ended; its record was removed.' };
    }
    const stopped = manager.stop(processId);
    // A detached process stopped in the session that started it leaves no record behind.
    if (stopped && context.workspace.shellPaths) forgetDetachedProcess(context.workspace.shellPaths, processId);
    return {
      status: stopped ? 'stopped' : 'not_found',
      done: stopped,
      processId,
      policy: stopped
        ? 'The process was signaled and removed from the shared ProcessManager.'
        : 'No tracked process matched that id.',
    };
  }

  if (action === 'wait') {
    const current = processClassificationOptions(context), supplied = options;
    const waiting = { ...supplied, assertCurrent: () => { current.assertCurrent?.(); supplied.assertCurrent?.(); } };
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process wait requires processId.');
    const { timeoutMs, capped } = clampWaitTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_WAIT_TIMEOUT_MS);
    const entry = await waitForProcess(manager, processId, timeoutMs, waiting);
    waiting.assertCurrent();
    return {
      status: entry?.done ? 'completed' : entry ? 'still_running' : 'not_found',
      // A wait is an observation: it succeeded when the process was found, running or not.
      done: entry !== undefined,
      processId,
      timeoutMs,
      ...(entry ? { process: await describeProcessEntry(context, manager, entry, { ...waiting, includeParameters: true }) } : {}),
      policy: `Wait observes the tracked process and does not send input or signals. timeoutMs 0 returns the current status without waiting${capped ? `; the requested wait was capped at ${timeoutMs}ms, wait again to keep watching` : ''}.`,
    };
  }

  if (action === 'list') return { ...await backgroundProcessSummary(context, args, options), done: true };
  if (action === 'status' || action === 'log' || action === 'output') {
    const resolved = await describeBackgroundProcess(context, args, options);
    if (resolved.status === 'found') return { ...resolved.process, done: true };
    return {
      status: resolved.status,
      done: false,
      ...(resolved.status === 'ambiguous' ? { input: resolved.input, candidates: resolved.candidates } : { usage: resolved.usage }),
    };
  }

  throw new Error('run_background_process requires processAction start, stop/kill, wait, list, status/poll, log/output, write, or capabilities.');
}
