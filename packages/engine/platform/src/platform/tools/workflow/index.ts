import { isNativeConversationTurn, NATIVE_TURN_EXECUTION_REFUSAL } from '../../core/native-turn-scope.js';
import { readDelegationRequest } from '../../core/delegation-request-context.js';
import { delegationPlanHolds, delegationPlanKey } from '../../agents/delegation-plan-holds.js';
import { assertAgentBriefFidelity, DelegationPlanHeldError } from '../../agents/brief-fidelity.js';
import { readCompletionRepairContext } from '../../core/completion-repair-context.js';
import { assertCurrentToolInvocation } from '../registry.js';
import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { AutomationCommands, type AutomationCommandExit } from '../../workflow/automation-commands.js';
import { conditionProblem, HOOK_ACTION_TIMEOUT_MS, type HookActionFireResult } from '../../workflow/hook-action-executor.js';
import { shellSplit } from '../../utils/shell-split.js';
import { requireStopped } from '../../utils/owned-work.js';
import type { ContractRunner } from '../../contract/runner.js';
import { workflowSchema } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

interface WorkflowDefinition {
  name: string;
  states: string[];
  transitions: Record<string, string[]>;
  description: string;
}

/**
 * The definition that is not a tracked state machine: `start` with it hands
 * the task to a new contract through the contract runner, whose units are
 * checked against their acceptance criteria while they work.
 */
export const CONTRACT_WORKFLOW_DEFINITION = 'contract';

export const WORKFLOW_DEFINITIONS: Readonly<Record<string, WorkflowDefinition>> = Object.freeze(JSON.parse(JSON.stringify({
  fix_loop: {
    name: 'Fix Loop',
    states: ['apply', 'test', 'verify', 'complete'],
    transitions: { apply: ['test'], test: ['verify', 'apply'], verify: ['complete'] },
    description: 'Apply fix, test, verify',
  },
  test_then_fix: {
    name: 'Test Then Fix',
    states: ['test', 'fix', 'verify', 'complete'],
    transitions: { test: ['fix'], fix: ['verify'], verify: ['complete', 'fix'] },
    description: 'Run tests, fix failures, verify',
  },
  review_only: {
    name: 'Review Only',
    states: ['review', 'complete'],
    transitions: { review: ['complete'] },
    description: 'Skip to review phase',
  },
})));

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export interface WorkflowInstance {
  id: string;
  definition: string;
  currentState: string;
  task: string;
  startedAt: number;
  /** When it last started or moved; one left without a move for an hour is cancelled as abandoned. */
  lastActivityAt: number;
  completedAt?: number | undefined;
  transitions: number;
  context: Record<string, unknown>;
  cancelled?: boolean | undefined;
  /** Cancelled because it went an hour without a move; completedAt is then the moment that hour ran out. */
  abandoned?: boolean | undefined;
}

/** How long a finished workflow is kept, and how long an unfinished one may go without a move before it is cancelled as abandoned. */
const WORKFLOW_EVICT_AFTER_MS = 60 * 60 * 1000; // 1 hour
const WORKFLOW_MAX_COMPLETED = 50;

export class WorkflowManager {
  private workflows = new Map<string, WorkflowInstance>();

  start(definition: string, task: string): WorkflowInstance {
    const def = WORKFLOW_DEFINITIONS[definition]!;
    if (!def) {
      throw new Error(`Unknown workflow definition: ${definition}`);
    }

    const now = Date.now();
    this.prune(now);
    const id = `wf-${crypto.randomUUID().slice(0, 8)}`;
    const instance: WorkflowInstance = {
      id,
      definition,
      currentState: def.states[0]!,
      task,
      startedAt: now,
      lastActivityAt: now,
      transitions: 0,
      context: {},
    };

    this.workflows.set(id, instance);
    return instance;
  }

  getStatus(id: string): WorkflowInstance | null {
    return this.lookup(id) ?? null;
  }

  transition(id: string, targetState: string): { success: boolean; error?: string | undefined } {
    const instance = this.lookup(id);
    if (!instance) {
      return { success: false, error: `Workflow not found: ${id}` };
    }
    if (instance.abandoned) {
      return { success: false, error: `Workflow ${id} was cancelled as abandoned after an hour without a move; start a new one.` };
    }
    if (instance.cancelled) {
      return { success: false, error: 'Workflow is cancelled' };
    }

    const def = WORKFLOW_DEFINITIONS[instance.definition];
    const allowed = def?.transitions[instance.currentState] ?? [];

    if (!allowed.includes(targetState)) {
      return {
        success: false,
        error: `Invalid transition: ${instance.currentState} -> ${targetState}. Allowed: [${allowed.join(', ')}]`,
      };
    }

    instance.currentState = targetState;
    instance.transitions += 1;
    instance.lastActivityAt = Date.now();
    if (targetState === 'complete') {
      instance.completedAt = instance.lastActivityAt;
    }
    return { success: true };
  }

  /** Why this workflow cannot be cancelled (it already ended), or undefined when it can be or does not exist. */
  cancelRefusal(id: string): string | undefined {
    const instance = this.lookup(id);
    if (!instance) return undefined;
    if (instance.abandoned) return `Workflow ${id} was cancelled as abandoned after an hour without a move; there is nothing left to cancel. Start a new one if the work continues`;
    if (instance.cancelled) return `Workflow ${id} is already cancelled; there is nothing left to cancel`;
    if (instance.completedAt !== undefined) return `Workflow ${id} already finished (${instance.currentState}); a finished workflow cannot be cancelled`;
    return undefined;
  }

  cancel(id: string): boolean {
    const instance = this.lookup(id);
    if (!instance) return false;
    if (this.cancelRefusal(id) !== undefined) return false;
    instance.cancelled = true;
    instance.completedAt = Date.now();
    return true;
  }

  list(): WorkflowInstance[] {
    this.prune(Date.now());
    return Array.from(this.workflows.values());
  }

  /** The workflow with the abandonment rule applied to it, so every read and move sees the same state. */
  private lookup(id: string): WorkflowInstance | undefined {
    const instance = this.workflows.get(id);
    if (instance) this.settleAbandoned(instance, Date.now());
    return instance;
  }

  /**
   * A workflow left unfinished with no move for the eviction window is cancelled as
   * abandoned, as of the moment the window ran out, whichever call notices it first.
   */
  private settleAbandoned(wf: WorkflowInstance, now: number): void {
    if (wf.completedAt === undefined && now - wf.lastActivityAt > WORKFLOW_EVICT_AFTER_MS) {
      wf.cancelled = true;
      wf.abandoned = true;
      wf.completedAt = wf.lastActivityAt + WORKFLOW_EVICT_AFTER_MS;
    }
  }

  /**
   * Cancels a workflow left unfinished with no move for the eviction window
   * (abandoned), then drops finished ones past the window and beyond the cap.
   */
  private prune(now: number): void {
    for (const wf of this.workflows.values()) this.settleAbandoned(wf, now);
    // Evict expired completed/cancelled workflows
    for (const [id, wf] of this.workflows) {
      if (wf.completedAt !== undefined && now - wf.completedAt > WORKFLOW_EVICT_AFTER_MS) {
        this.workflows.delete(id);
      }
    }
    // Cap completed workflows at max
    const all = Array.from(this.workflows.values());
    const completed = all.filter(w => w.completedAt !== undefined);
    if (completed.length > WORKFLOW_MAX_COMPLETED) {
      completed.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      const toEvict = completed.slice(0, completed.length - WORKFLOW_MAX_COMPLETED);
      for (const wf of toEvict) this.workflows.delete(wf.id);
    }
  }
}

// ---------------------------------------------------------------------------
// HookActionManager: the workflow tool's hook actions
// ---------------------------------------------------------------------------

/**
 * A hook action of the workflow tool: `on <hook event> [if <condition>] run
 * <command>`. The fleet shows these as 'hook-action' nodes. Not to be confused
 * with the trigger family (platform/triggers: stream watchers, condition checks,
 * on-exit process triggers, persisted and supervised), which owns the
 * 'trigger' fleet kind and the `watchers.triggers.*` settings.
 */
export interface HookActionDefinition {
  id: string;
  event: string;
  condition?: string | undefined;
  action: string;
  /** The action as admitted at add time (split and guarded once, behind the sandbox boundary when contained); every fire starts exactly this. */
  argv?: readonly string[] | undefined;
  /** Every fire runs inside the exec sandbox's boundary, described by `boundary`. */
  sandboxed?: boolean | undefined;
  boundary?: string | undefined;
  enabled: boolean;
  /** Fires that started the action or failed to. */
  fireCount?: number | undefined;
  /** The most recent fire: when, whether the action started, why not, and how it ended. */
  lastFire?: HookActionFire | undefined;
}

/** The most recent fire of a hook action. */
export interface HookActionFire {
  readonly at: number;
  readonly executed: boolean;
  readonly error?: string | undefined;
  readonly pid?: number | undefined;
  /** Set once the started action ended: its exit code, or null when a signal (the 60 s timeout or a kill) ended it. */
  readonly exitCode?: number | null | undefined;
  readonly timedOut?: boolean | undefined;
}

/** How an admitted automation command is contained: inside the exec sandbox's boundary, or not. */
interface AutomationContainment {
  readonly sandboxed: boolean;
  readonly boundary?: string | undefined;
}

/** An entry as the tool reports it: the command text and its boundary, not the argv the runner starts (the sandbox's own arguments included). */
function withoutArgv<T extends { argv?: readonly string[] | undefined }>(entry: T): Omit<T, 'argv'> {
  const { argv: _argv, ...shown } = entry;
  return shown;
}

/** What `add` says about how long an automation lives. */
export const WORKFLOW_AUTOMATION_LIFETIME = 'until this process exits; it is not saved and does not come back after a restart. For a routine that survives restarts use /schedule.';

export class HookActionManager {
  private actions = new Map<string, HookActionDefinition>();

  /** `commands` admits, starts, limits and tracks this manager's actions; WorkflowServices shares one with its schedules. */
  constructor(readonly commands: AutomationCommands = new AutomationCommands()) {}

  /**
   * Stores a hook action that can run. A condition that cannot be parsed and an
   * action that cannot be split are refused here, before anything is stored;
   * the command guard is applied by {@link admit} before this is called.
   */
  add(def: { event: string; condition?: string | undefined; action: string }, argv?: readonly string[], containment?: AutomationContainment): HookActionDefinition {
    const event = def.event.trim();
    if (!event) throw new Error('Hook action event is empty: give a hook event path such as Post:tool:exec or Post:tool:*.');
    const condition = def.condition?.trim() || undefined;
    if (condition) {
      const problem = conditionProblem(condition);
      if (problem) throw new Error(`Hook action condition cannot be evaluated: ${problem}. Use ===, !==, ==, !=, >, <, >=, <=, &&, ||, ! and parentheses over event.* and payload.* paths and literals.`);
    }
    let admitted: readonly string[];
    try {
      admitted = argv ?? shellSplit(def.action, { strict: true });
    } catch (err) {
      throw new Error(`Hook action command could not be parsed: ${summarizeError(err)}. Close the quote or escape the character.`);
    }
    if (admitted.length === 0) throw new Error('Hook action command is empty; give it a program to run.');
    const id = `hook-${crypto.randomUUID().slice(0, 8)}`;
    const hook: HookActionDefinition = {
      id,
      event,
      condition,
      action: def.action,
      argv: admitted,
      ...(containment?.sandboxed ? { sandboxed: true, boundary: containment.boundary } : {}),
      enabled: true,
      fireCount: 0,
    };
    this.actions.set(id, hook);
    return hook;
  }

  /** Admits the action against the command guard, then stores it; a refusal names why and stores nothing. */
  async admit(def: { event: string; condition?: string | undefined; action: string }): Promise<HookActionDefinition> {
    const admission = await this.commands.admit(def.action);
    if (!admission.admitted) throw new Error(`Hook action not added: ${admission.reason}`);
    return this.add(def, admission.argv, admission);
  }

  remove(id: string): boolean {
    // The run keeps its slot until its exit is observed; the stop logs any child it could not end.
    void this.commands.stop('hook-action', id);
    return this.actions.delete(id);
  }

  enable(id: string): boolean {
    const hook = this.actions.get(id);
    if (!hook) return false;
    hook.enabled = true;
    return true;
  }

  disable(id: string): boolean {
    const hook = this.actions.get(id);
    if (!hook) return false;
    hook.enabled = false;
    return true;
  }

  list(): HookActionDefinition[] {
    return Array.from(this.actions.values());
  }

  /** Keeps a fire's outcome on the definition (a field write; the dispatcher already has the result). */
  recordFire(result: HookActionFireResult): void {
    const hook = this.actions.get(result.hookActionId);
    if (!hook) return;
    hook.fireCount = (hook.fireCount ?? 0) + 1;
    hook.lastFire = {
      at: Date.now(),
      executed: result.executed,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.pid !== undefined ? { pid: result.pid } : {}),
    };
  }

  /** Keeps how the most recent started action ended; the exit of an older run is not that fire's outcome. */
  recordExit(hookActionId: string, exit: AutomationCommandExit): void {
    const hook = this.actions.get(hookActionId);
    if (!hook?.lastFire?.executed || hook.lastFire.pid !== exit.pid) return;
    hook.lastFire = { ...hook.lastFire, exitCode: exit.exitCode, ...(exit.timedOut ? { timedOut: true } : {}) };
  }
}

// ---------------------------------------------------------------------------
// ScheduleManager
// ---------------------------------------------------------------------------

/**
 * A scheduled command of the workflow tool. It lives in the process that
 * created it (it is gone when that process exits); `/schedule` routines are the
 * durable kind.
 */
export interface ScheduleEntry {
  name: string;
  interval: string;
  command: string;
  /** The command as admitted at add time (split and guarded once, behind the sandbox boundary when contained); every run starts exactly this. */
  argv?: readonly string[] | undefined;
  /** Every run is inside the exec sandbox's boundary, described by `boundary`. */
  sandboxed?: boolean | undefined;
  boundary?: string | undefined;
  /** When the current or most recent run started. */
  lastRun?: number | undefined;
  nextRun?: number | undefined;
  enabled: boolean;
  /** True while a run of this schedule's command is executing. */
  running?: boolean | undefined;
  /** The exit code of the most recent finished run; null when it was killed by a signal (its timeout, or a remove). */
  lastExitCode?: number | null | undefined;
  /** When the most recent run finished. */
  lastExitAt?: number | undefined;
  /** Why the most recent tick did not run or did not finish cleanly; cleared by a clean run. */
  lastError?: string | undefined;
  /** Ticks skipped because the previous run was still going. */
  skippedTicks?: number | undefined;
}

/**
 * Parse an interval string like '30s', '5m', '1h' to milliseconds.
 * Returns null if the format is unrecognised.
 */
export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  switch (match[2]) {
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

/** The longest delay a timer honours; a larger one is clamped to 1ms by the runtime, which would make the slowest schedule the fastest. */
const MAX_SCHEDULE_INTERVAL_MS = 2 ** 31 - 1;

/** The shortest interval the tool accepts; a scheduled command is a background job, not a loop. */
export const MIN_SCHEDULE_INTERVAL_MS = 1_000;

/**
 * A run is killed when it outlasts its own interval (at least the hook-action
 * timeout), so a hung run cannot block every later tick.
 */
function scheduleRunTimeoutMs(intervalMs: number): number {
  return Math.max(intervalMs, HOOK_ACTION_TIMEOUT_MS);
}

/** The interval in milliseconds, or the reason it cannot be scheduled. */
function checkInterval(interval: string): number {
  const intervalMs = parseInterval(interval);
  if (intervalMs === null) {
    throw new Error(`Unrecognised interval "${interval}": use a number followed by s, m, h or d, for example 30s, 5m or 1h.`);
  }
  if (intervalMs < MIN_SCHEDULE_INTERVAL_MS) throw new Error(`Interval "${interval}" is shorter than the ${MIN_SCHEDULE_INTERVAL_MS / 1000}s minimum; use 1s or longer.`);
  if (intervalMs > MAX_SCHEDULE_INTERVAL_MS) {
    throw new Error(`Interval "${interval}" is longer than the 24 day maximum a timer can hold; use a shorter one.`);
  }
  return intervalMs;
}

export class ScheduleManager {
  private schedules = new Map<string, ScheduleEntry>();
  /** Timer IDs keyed by schedule name */
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * `commands` admits scheduled commands, starts them in the project root with
   * the exec path's credential-env scrub, allows one run of a schedule at a
   * time, times runs out, and kills them on remove and destroy().
   */
  constructor(readonly commands: AutomationCommands = new AutomationCommands()) {}

  /**
   * Stores a schedule that can run and arms its timer. An interval or command
   * that could never run is refused before anything is stored; the command
   * guard is applied by {@link admit} before this is called.
   */
  add(name: string, interval: string, command: string, argv?: readonly string[], containment?: AutomationContainment): ScheduleEntry {
    const intervalMs = checkInterval(interval);
    let admitted: readonly string[];
    try {
      admitted = argv ?? shellSplit(command, { strict: true });
    } catch (err) {
      throw new Error(`Schedule command could not be parsed: ${summarizeError(err)}. Close the quote or escape the character.`);
    }
    if (admitted.length === 0) throw new Error('Schedule command is empty.');

    // Re-adding a name replaces the schedule: its timer and any run of the old command stop.
    this._clearTimer(name);
    void this.commands.stop('schedule', name);

    const entry: ScheduleEntry = {
      name,
      interval,
      command,
      argv: admitted,
      ...(containment?.sandboxed ? { sandboxed: true, boundary: containment.boundary } : {}),
      enabled: true,
      nextRun: Date.now() + intervalMs,
      skippedTicks: 0,
    };
    this.schedules.set(name, entry);
    this._arm(name, intervalMs);
    return entry;
  }

  /** Admits the command against the command guard, then stores the schedule; a refusal names why and stores nothing. */
  async admit(name: string, interval: string, command: string): Promise<ScheduleEntry> {
    checkInterval(interval);
    const admission = await this.commands.admit(command);
    if (!admission.admitted) throw new Error(`Schedule not added: ${admission.reason}`);
    return this.add(name, interval, command, admission.argv, admission);
  }

  /** Removes the schedule and stops its command if a run is executing. */
  remove(name: string): boolean {
    this._clearTimer(name);
    void this.commands.stop('schedule', name);
    return this.schedules.delete(name);
  }

  enable(name: string): boolean {
    const entry = this.schedules.get(name);
    if (!entry) return false;
    if (entry.enabled) return true;
    entry.enabled = true;
    const intervalMs = parseInterval(entry.interval);
    if (intervalMs !== null && !this.timers.has(name)) {
      entry.nextRun = Date.now() + intervalMs;
      this._arm(name, intervalMs);
    }
    return true;
  }

  /** Stops the timer; a run already executing finishes. */
  disable(name: string): boolean {
    const entry = this.schedules.get(name);
    if (!entry) return false;
    entry.enabled = false;
    this._clearTimer(name);
    entry.nextRun = undefined;
    return true;
  }

  list(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Stop all timers and clear state when the manager is disposed. Resolves once
   * every running scheduled command has exited; rejects naming each one that
   * could not be confirmed ended.
   */
  async destroy(): Promise<void> {
    for (const name of [...this.timers.keys()]) {
      this._clearTimer(name);
    }
    this.schedules.clear();
    requireStopped('Scheduled commands', await this.commands.stop('schedule'));
  }

  private _arm(name: string, intervalMs: number): void {
    const timer = setInterval(() => { void this._tick(name, intervalMs); }, intervalMs);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  /**
   * One tick: start the admitted command with GV_SCHEDULE_NAME set. One run of
   * a schedule at a time: a tick while the previous run is still going is
   * skipped and counted, so runs never pile up. How each run ended is kept on
   * the entry.
   */
  private async _tick(name: string, intervalMs: number): Promise<void> {
    const entry = this.schedules.get(name);
    if (!entry || !entry.enabled) return;
    entry.nextRun = Date.now() + intervalMs;
    const argv = entry.argv ?? shellSplit(entry.command, { strict: true });
    const outcome = await this.commands.start({
      kind: 'schedule',
      key: name,
      argv,
      sandboxed: entry.sandboxed,
      env: { GV_SCHEDULE_NAME: name },
      maxInFlight: 1,
      timeoutMs: scheduleRunTimeoutMs(intervalMs),
      onExit: (exit) => {
        const current = this.schedules.get(name);
        if (current !== entry) return;
        entry.running = false;
        entry.lastExitCode = exit.exitCode;
        entry.lastExitAt = exit.at;
        if (exit.timedOut) entry.lastError = `The run was killed after ${Math.round(scheduleRunTimeoutMs(intervalMs) / 1000)}s, its time limit.`;
        else if (exit.exitCode === 0) entry.lastError = undefined;
        else if (exit.exitCode === null) entry.lastError = 'The run was stopped by a signal.';
        else entry.lastError = `The run exited with code ${exit.exitCode}.`;
      },
    });
    if (this.schedules.get(name) !== entry) return;
    if (outcome.started) {
      // Recorded only once the command actually started, so `list` never shows a run that did not happen.
      entry.lastRun = Date.now();
      entry.running = this.commands.running('schedule', name) > 0;
    } else if (outcome.reason === 'busy') {
      entry.skippedTicks = (entry.skippedTicks ?? 0) + 1;
    } else if (outcome.reason === 'failed') {
      entry.lastError = `The command failed to start: ${outcome.message}`;
      logger.warn('[workflow] scheduled command failed to start', { workflow: name, command: entry.command, error: outcome.message });
    }
  }

  private _clearTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface WorkflowInput {
  mode: 'start' | 'status' | 'transition' | 'cancel' | 'list' | 'hook-actions' | 'schedule';
  definition?: string | undefined;
  task?: string | undefined;
  workflowId?: string | undefined;
  targetState?: string | undefined;
  hookAction?: 'list' | 'add' | 'remove' | 'enable' | 'disable' | undefined;
  hookActionId?: string | undefined;
  hookActionDefinition?: {
    event: string;
    condition?: string | undefined;
    action: string;
  };
  scheduleAction?: 'list' | 'add' | 'remove' | 'enable' | 'disable' | undefined;
  scheduleName?: string | undefined;
  scheduleInterval?: string | undefined;
  scheduleCommand?: string | undefined;
}

export interface WorkflowServices {
  readonly workflowManager: WorkflowManager;
  readonly hookActions: HookActionManager;
  readonly scheduleManager: ScheduleManager;
  /** Admits, starts and tracks this runtime's hook actions and scheduled commands; its scrub is the exec path's. */
  readonly commands: AutomationCommands;
}

/** `workingDirectory` is the project root hook actions and scheduled commands run in. */
export function createWorkflowServices(options: { readonly workingDirectory?: string | undefined } = {}): WorkflowServices {
  const commands = new AutomationCommands();
  commands.setWorkingDirectory(options.workingDirectory);
  return {
    workflowManager: new WorkflowManager(),
    hookActions: new HookActionManager(commands),
    scheduleManager: new ScheduleManager(commands),
    commands,
  };
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/** What the workflow tool's `contract` definition starts contracts with. */
export interface WorkflowContractStarter {
  readonly contractRunner: Pick<ContractRunner, 'start'>;
  /** The project a contract started here works in. */
  readonly projectRoot: string;
  /** The conversation session a contract started here belongs to, read on each call. */
  readonly resolveSessionId: () => string;
}

export function createWorkflowTool(services: WorkflowServices, contracts: WorkflowContractStarter): Tool {
  return {
    definition: workflowSchema,

    async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string | undefined }> {
      try {
        if (!args.mode || typeof args.mode !== 'string') {
          return { success: false, error: 'Missing required "mode" field' };
        }

        const input = args as unknown as WorkflowInput;
        const wm = services.workflowManager;
        const tm = services.hookActions;
        const sm = services.scheduleManager;

        switch (input.mode) {
        case 'start': {
          if (!input.definition) {
            return { success: false, error: 'mode "start" requires "definition"' };
          }
          if (typeof input.task !== 'string' || !input.task.trim()) {
            return { success: false, error: 'mode "start" requires "task"' };
          }
          if (input.definition === CONTRACT_WORKFLOW_DEFINITION) {
            if (isNativeConversationTurn()) return { success: false, error: NATIVE_TURN_EXECUTION_REFUSAL };
            const sessionId = contracts.resolveSessionId(), source = readDelegationRequest();
            const holds = delegationPlanHolds(contracts.contractRunner);
            const held = source ? holds.get(delegationPlanKey(sessionId, source.request))
              : [...holds.values()].find(plan => plan.sessionId === sessionId);
            if (held) return { success: false, error: 'Delegation remains held. Repair and revalidate the pending agent plan before starting a replacement contract.',
              output: JSON.stringify({ recovery: { kind: 'revise-delegation', ...held, requiredMode: held.mode } }) };
            const task = input.task, projectRoot = contracts.projectRoot, runner = contracts.contractRunner;
            const signal = source?.signal && options?.signal ? AbortSignal.any([source.signal, options.signal]) : source?.signal ?? options?.signal;
            // Still wanted: the call's signal, the registry's one invocation check,
            // the delegation's own check, and the session (the conversation can
            // move on while the brief is read).
            const assertCurrent = () => {
              signal?.throwIfAborted();
              assertCurrentToolInvocation(args, options);
              source?.assertCurrent?.();
              if (contracts.resolveSessionId() !== sessionId) {
                throw new Error(`Contract not started: the conversation moved from session ${sessionId} to ${contracts.resolveSessionId()} while the proposal was checked. Start it again from the current session.`);
              }
            };
            assertCurrent();
            if (source) {
              const repairContext = readCompletionRepairContext();
              try {
                await assertAgentBriefFidelity({ request: source.request, assignments: [{ task }],
                  ...(repairContext ? { repairContext } : {}) }, { signal, assertCurrent });
              } catch (error) {
                if (!(error instanceof DelegationPlanHeldError)) throw error;
                return { success: false, error: error.message, output: JSON.stringify({ recovery: {
                  kind: 'revise-delegation', request: source.request, assignments: [{ task }], fixes: error.fixes,
                  requiredMode: 'start', definition: CONTRACT_WORKFLOW_DEFINITION,
                  instruction: 'Repair these exact conflicts and resubmit this workflow contract proposal for Jev revalidation against the original request.' } }) };
              }
            }
            assertCurrent();
            const started = await runner.start({
              ask: task,
              sessionId,
              origin: 'agent-tool',
              projectRoot,
            }, { signal, assertCurrent });
            return {
              success: true,
              output: JSON.stringify({
                contractStarted: true,
                contractId: started.contract.id,
                ownerAgentId: started.owner.id,
                status: started.contract.status,
                task: input.task,
              }),
            };
          }
          if (!WORKFLOW_DEFINITIONS[input.definition]) {
            return { success: false, error: `Unknown workflow definition: ${input.definition}` };
          }
          const instance = wm.start(input.definition, input.task);
          return { success: true, output: JSON.stringify(instance) };
        }

        case 'status': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "status" requires "workflowId"' };
          }
          const instance = wm.getStatus(input.workflowId);
          if (!instance) {
            return { success: false, error: `Workflow not found: ${input.workflowId}` };
          }
          return { success: true, output: JSON.stringify(instance) };
        }

        case 'transition': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "transition" requires "workflowId"' };
          }
          if (!input.targetState) {
            return { success: false, error: 'mode "transition" requires "targetState"' };
          }
          const result = wm.transition(input.workflowId, input.targetState);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          const updated = wm.getStatus(input.workflowId);
          return { success: true, output: JSON.stringify(updated) };
        }

        case 'cancel': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "cancel" requires "workflowId"' };
          }
          const refusal = wm.cancelRefusal(input.workflowId);
          if (refusal) return { success: false, error: refusal };
          const cancelled = wm.cancel(input.workflowId);
          if (!cancelled) {
            return { success: false, error: `Workflow not found: ${input.workflowId}` };
          }
          return { success: true, output: JSON.stringify({ cancelled: true, workflowId: input.workflowId }) };
        }

        case 'list': {
          const workflows = wm.list();
          return { success: true, output: JSON.stringify({ workflows, count: workflows.length }) };
        }

        case 'hook-actions': {
          const action = input.hookAction ?? 'list';
          const notFound = (id: string) => ({ success: false, error: `Hook action not found: ${id}. List them with hookAction "list".` });
          switch (action) {
            case 'list': {
              const hookActions = tm.list().map(withoutArgv);
              return { success: true, output: JSON.stringify({ hookActions, count: hookActions.length, lifetime: WORKFLOW_AUTOMATION_LIFETIME }) };
            }
            case 'add': {
              const def = input.hookActionDefinition;
              if (!def || typeof def.event !== 'string' || typeof def.action !== 'string') {
                return { success: false, error: 'hook-actions/add requires "hookActionDefinition" with "event" and "action" strings.' };
              }
              const added = await tm.admit(def);
              return { success: true, output: JSON.stringify({ ...withoutArgv(added), lifetime: WORKFLOW_AUTOMATION_LIFETIME }) };
            }
            case 'remove':
            case 'enable':
            case 'disable': {
              const id = input.hookActionId;
              if (!id) return { success: false, error: `hook-actions/${action} requires "hookActionId"` };
              const done = action === 'remove' ? tm.remove(id) : action === 'enable' ? tm.enable(id) : tm.disable(id);
              if (!done) return notFound(id);
              const result = action === 'remove' ? { removed: true } : action === 'enable' ? { enabled: true } : { disabled: true };
              return { success: true, output: JSON.stringify({ ...result, hookActionId: id }) };
            }
            default: {
              const exhaustive: never = action;
              return { success: false, error: `Unknown hookAction: ${exhaustive as string}` };
            }
          }
        }

        case 'schedule': {
          const action = input.scheduleAction ?? 'list';
          switch (action) {
            case 'list': {
              const schedules = sm.list().map(withoutArgv);
              return { success: true, output: JSON.stringify({ schedules, count: schedules.length, lifetime: WORKFLOW_AUTOMATION_LIFETIME }) };
            }
            case 'add': {
              if (!input.scheduleName) {
                return { success: false, error: 'schedule/add requires "scheduleName"' };
              }
              if (!input.scheduleInterval) {
                return { success: false, error: 'schedule/add requires "scheduleInterval"' };
              }
              if (!input.scheduleCommand) {
                return { success: false, error: 'schedule/add requires "scheduleCommand"' };
              }
              const entry = await sm.admit(input.scheduleName, input.scheduleInterval, input.scheduleCommand);
              return { success: true, output: JSON.stringify({ ...withoutArgv(entry), lifetime: WORKFLOW_AUTOMATION_LIFETIME }) };
            }
            case 'remove':
            case 'enable':
            case 'disable': {
              if (!input.scheduleName) {
                return { success: false, error: `schedule/${action} requires "scheduleName"` };
              }
              const done = action === 'remove' ? sm.remove(input.scheduleName)
                : action === 'enable' ? sm.enable(input.scheduleName)
                  : sm.disable(input.scheduleName);
              if (!done) return { success: false, error: `Schedule not found: ${input.scheduleName}. List them with scheduleAction "list".` };
              const result = action === 'remove' ? { removed: true } : action === 'enable' ? { enabled: true } : { disabled: true };
              return { success: true, output: JSON.stringify({ ...result, scheduleName: input.scheduleName }) };
            }
            default: {
              const exhaustive: never = action;
              return { success: false, error: `Unknown scheduleAction: ${exhaustive as string}` };
            }
          }
        }

          default: {
            const exhaustive: never = input.mode;
            return { success: false, error: `Unknown mode: ${exhaustive as string}` };
          }
        }
      } catch (err) {
        return {
          success: false,
          error: summarizeError(err),
        };
      }
    },
  };
}
