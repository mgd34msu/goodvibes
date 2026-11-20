import type { HookDispatchOptions, HookWorkAdmission, TurnHookOwner } from './turn-ownership.js';
import { hookTimeoutSeconds, joinHookWithin, type HookExecutionOptions } from './execution.js';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import type { HookDefinition, HookChain, HookEvent, HookEventPath, HookResult, HookType } from './types.js';
import { matchesEventPath, matchesMatcher } from './matcher.js';
import { getHookPointContract, hookPatternProblem } from './contracts.js';
import { withHookWorkObserver } from './live-work.js';
import { HookActivityTracker } from './activity.js';
import { logger } from '../utils/logger.js';
import { withCostOriginAsync } from '../runtime/cost/cost-origin.js';
import type { HooksConfig } from './types.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ToolLLM } from '../config/tool-llm.js';
import * as commandRunner from './runners/command.js';
import * as promptRunner from './runners/prompt.js';
import * as agentRunner from './runners/agent.js';
import * as httpRunner from './runners/http.js';
import * as tsRunner from './runners/typescript.js';
import { ChainEngine } from './chain-engine.js';
import { fireHookActions } from '../workflow/hook-action-executor.js';
import { guardExecCommand } from '../tools/exec/ast-guard.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { HookActionManagerLike } from '../workflow/hook-action-executor.js';
import { summarizeError } from '../utils/error-display.js';
import { requireStopped } from '../utils/owned-work.js';

export type HookRunnerDeps = {
  readonly agentManager?: (Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'spawnOwned' | 'join'>>) | undefined;
  readonly toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  readonly projectRoot?: string | undefined;
};

function runHook(
  hook: HookDefinition,
  event: HookEvent,
  deps: HookRunnerDeps,
  hooksBaseDirectory: string | null,
  execution?: HookExecutionOptions,
): Promise<HookResult> {
  switch (hook.type) {
    case 'command': return commandRunner.run(hook, event, execution);
    case 'prompt': return promptRunner.run(hook, event, deps.toolLLM ?? null, execution);
    case 'agent':
      if (!deps.agentManager) {
        return Promise.resolve({ ok: false, error: 'agent hook runner is not configured in this runtime', ...(execution === undefined ? {} : { code: 'OWNED_AGENT_EXECUTION_UNSUPPORTED' as const }) });
      }
      return agentRunner.run(hook, event, deps.agentManager, execution);
    case 'http': return httpRunner.run(hook, event, execution);
    case 'ts': {
      const projectRoot = deps.projectRoot ?? hooksBaseDirectory;
      if (!projectRoot) {
        return Promise.resolve({ ok: false, error: 'ts hook runner requires an explicit project root' });
      }
      return tsRunner.run(hook, event, projectRoot, execution);
    }
    default:
      return Promise.resolve({ ok: false, error: `unknown hook type: ${(hook as HookDefinition).type}` });
  }
}

/**
 * Why a hooks file must not be loaded, or null. Hook commands run with this
 * process's privileges, so a file any local user can rewrite, or one owned by
 * a user other than this one (or root), is refused rather than executed.
 */
export function hooksFileRefusal(filePath: string): string | null {
  if (process.platform === 'win32') return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch (err) {
    logger.warn('HookDispatcher: failed to inspect hooks.json permissions; continuing with load', {
      filePath,
      error: summarizeError(err),
    });
    return null;
  }
  if ((st.mode & 0o002) !== 0) return 'it is writable by every user on this machine; remove that permission (chmod o-w) and reload';
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) return `it is owned by another user (uid ${st.uid}); take ownership of it and reload`;
  return null;
}

const VALID_HOOK_TYPES = new Set(['command', 'prompt', 'agent', 'http', 'ts']);

/**
 * What is wrong with a hook definition read from a file, or null when it is
 * accepted. With `pattern`, the key it is listed under, the key must be able
 * to fire (see hookPatternProblem) and an optional `match` must equal it: the
 * key is the only thing that decides which events the hook runs on.
 */
export function hookDefinitionProblem(def: unknown, pattern?: string): string | null {
  if (pattern !== undefined) {
    const keyProblem = hookPatternProblem(pattern);
    if (keyProblem !== null) return keyProblem;
  }
  if (typeof def !== 'object' || def === null) return 'hook definition must be an object';
  const d = def as Record<string, unknown>;
  if (typeof d.type !== 'string' || !VALID_HOOK_TYPES.has(d.type)) return 'hook is missing a valid "type" field';
  if (d.match !== undefined && typeof d.match !== 'string') return 'hook "match" must be a string when present';
  if (pattern !== undefined && typeof d.match === 'string' && d.match !== pattern) {
    return `hook "match" is "${d.match}" but it is listed under "${pattern}", which decides when it fires; move it under "${d.match}" or remove "match"`;
  }
  if (d.timeout !== undefined && (typeof d.timeout !== 'number' || !Number.isFinite(d.timeout) || d.timeout < 0)) {
    return 'hook "timeout" must be a number of seconds, 0 or more';
  }
  if (d.timeout === 0 && d.async !== true) {
    return 'hook "timeout" is 0 (no deadline), which only a background hook may have; give it a timeout in seconds or set "async": true';
  }
  return null;
}

/** What is wrong with a chain read from a file, or null when it is accepted. */
export function chainProblem(chain: unknown): string | null {
  if (typeof chain !== 'object' || chain === null) return 'chain entry must be an object';
  const c = chain as Record<string, unknown>;
  if (typeof c.name !== 'string') return 'chain is missing its "name" field';
  if (!Array.isArray(c.steps)) return `chain "${c.name}" is missing its "steps" array`;
  if (typeof c.action !== 'object' || c.action === null) return `chain "${c.name}" is missing its "action" object`;
  const action = c.action as Record<string, unknown>;
  if (typeof action.type !== 'string' || !VALID_HOOK_TYPES.has(action.type)) return `chain "${c.name}" action is missing a valid "type" field`;
  if (typeof action.match !== 'string') return `chain "${c.name}" action is missing its "match" field`;
  return null;
}

export class HookDispatcher {
  private hooks = new Map<string, HookDefinition[]>();
  private chains: HookChain[] = [];
  /** Hooks and chains that came from a hooks file, so a reload replaces only those. */
  private readonly loadedHooks = new WeakSet<HookDefinition>();
  private readonly loadedChains = new WeakSet<HookChain>();
  private readonly chainEngine: ChainEngine;
  private hookActions: HookActionManagerLike | null = null;
  private hooksBaseDirectory: string | null = null;
  private readonly runnerDeps: HookRunnerDeps;
  private readonly activityTracker: HookActivityTracker;
  private activeInvocations = 0;
  private readonly activityListeners = new Set<() => void>();

  constructor(runnerDeps: HookRunnerDeps = {}, activityTracker: HookActivityTracker = new HookActivityTracker()) {
    this.runnerDeps = runnerDeps;
    this.activityTracker = activityTracker;
    // A chain's action runs through the runner directly, never back through
    // fire(): its event path is the action's own and would otherwise feed the
    // chain that just completed.
    this.chainEngine = new ChainEngine(this, (chain, event) => this.runChainAction(chain, event));
  }

  /** Actual runner lifetimes, including detached asynchronous hooks. */
  get activeInvocationCount(): number { return this.activeInvocations; }

  onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    this.notifyActivity(listener);
    return () => { this.activityListeners.delete(listener); };
  }

  private notifyActivity(listener?: () => void): void {
    for (const observer of listener ? [listener] : [...this.activityListeners]) {
      try { observer(); } catch { /* Observation never changes hook execution. */ }
    }
  }

  private async runTrackedHook(hook: HookDefinition, event: HookEvent, execution?: HookExecutionOptions): Promise<HookResult> {
    this.activeInvocations++;
    this.notifyActivity();
    let outstanding = 1, settled = false;
    const release = () => {
      if (--outstanding === 0) { settled = true; this.activeInvocations--; this.notifyActivity(); }
    };
    const retain = (work: Promise<unknown>) => { if (!settled) { outstanding++; void work.then(release, release); } };
    try {
      const work = withHookWorkObserver(retain, () => runHook(hook, event, this.runnerDeps, this.hooksBaseDirectory, execution));
      // A run left behind past its deadline and grace still counts as active until it really ends.
      retain(work);
      return await joinHookWithin(work, { name: hook.name ?? hook.type, timeoutSeconds: hookTimeoutSeconds(hook, hook.type), signal: execution?.signal });
    }
    finally { release(); }
  }

  /**
   * Attach the workflow tool's hook actions so hook events start the matching
   * ones. The manager's commands are admitted against the exec tool's command
   * guard (with `featureFlags` for its AST setting) once, when a hook action or
   * schedule is added; a fire runs the admitted argv. Returns a disposer that
   * detaches the manager and kills that manager's actions still running; other
   * runtimes' actions are left alone.
   */
  setHookActions(tm: HookActionManagerLike | null, featureFlags?: Pick<FeatureFlagManager, 'isEnabled'>): () => Promise<void> {
    this.hookActions = tm;
    tm?.commands.setCommandGuard(async (command) => {
      const guard = await guardExecCommand(command, featureFlags ?? null);
      return guard.allowed ? undefined : (guard.denialMessage ?? 'Command refused by the command guard.');
    });
    // Resolves once the manager's running actions have exited; rejects naming any that could not be ended.
    return async () => {
      if (this.hookActions === tm) this.hookActions = null;
      if (tm) requireStopped('Hook actions', await tm.commands.stop('hook-action'));
    };
  }

  /** Load hooks from hooks.json file */
  loadFromFile(filePath: string): void {
    this.hooksBaseDirectory = dirname(filePath);
    // No hooks file is the normal state for most installs, skip quietly
    // instead of emitting a WARN (permission probe) + ERROR (read) pair on
    // every startup for a file that was never created.
    if (!existsSync(filePath)) {
      logger.debug('HookDispatcher: no hooks file present, skipping load', { filePath });
      return;
    }
    try {
      const refusal = hooksFileRefusal(filePath);
      if (refusal !== null) {
        logger.warn(`HookDispatcher: hooks file not loaded because ${refusal}`, { filePath });
        return;
      }

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Validate and load hooks
      if (parsed.hooks !== undefined) {
        if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) {
          logger.info('HookDispatcher: hooks.json "hooks" field must be an object, skipping', { filePath });
        } else {
          for (const [pattern, defs] of Object.entries(parsed.hooks as Record<string, unknown>)) {
            if (!Array.isArray(defs)) {
              this.refuseLoadedHook(filePath, pattern, undefined, 'the value must be an array of hook definitions');
              continue;
            }
            for (const def of defs as unknown[]) {
              const problem = hookDefinitionProblem(def, pattern);
              if (problem !== null) {
                this.refuseLoadedHook(filePath, pattern, def, problem);
                continue;
              }
              const loaded = def as HookDefinition;
              this.register(pattern, loaded);
              this.loadedHooks.add(loaded);
            }
          }
        }
      }

      // Validate and load chains
      if (parsed.chains !== undefined) {
        if (!Array.isArray(parsed.chains)) {
          logger.info('HookDispatcher: hooks.json "chains" field must be an array, skipping', { filePath });
        } else {
          for (const chain of parsed.chains as unknown[]) {
            const problem = chainProblem(chain);
            if (problem !== null) {
              logger.info(`HookDispatcher: ${problem}, skipping`, { filePath });
              continue;
            }
            const loaded = chain as HookChain;
            if (this.registerChain(loaded)) this.loadedChains.add(loaded);
          }
        }
      }
    } catch (err) {
      logger.error('HookDispatcher: failed to load hooks file', {
        filePath,
        error: summarizeError(err),
      });
    }
  }

  /**
   * A hooks-file entry that was not loaded: logged at warn and listed in the
   * hook activity, so a hook the owner believes is active is not silently absent.
   */
  private refuseLoadedHook(filePath: string, pattern: string, def: unknown, reason: string): void {
    logger.warn(`HookDispatcher: hook under "${pattern}" not loaded because ${reason}`, { filePath, pattern });
    const fields = typeof def === 'object' && def !== null ? def as Record<string, unknown> : {};
    const hookType = typeof fields.type === 'string' && VALID_HOOK_TYPES.has(fields.type) ? fields.type as HookType : 'command';
    this.activityTracker.record({
      path: pattern as HookEventPath,
      phase: 'Lifecycle',
      category: 'config',
      specific: 'hooks-load',
      sessionId: '',
      timestamp: Date.now(),
      payload: { filePath },
    }, {
      pattern,
      hookName: typeof fields.name === 'string' ? fields.name : undefined,
      hookType,
      result: { ok: false, error: `not loaded from ${filePath}: ${reason}` },
      durationMs: 0,
      async: false,
    });
  }

  /** Register a hook programmatically */
  register(eventPattern: string, hook: HookDefinition): void {
    const existing = this.hooks.get(eventPattern);
    if (existing) {
      existing.push(hook);
    } else {
      this.hooks.set(eventPattern, [hook]);
    }
  }

  /**
   * Register a chain programmatically. Returns false, and logs why, when a
   * chain of that name is already registered: chains are tracked by name.
   */
  registerChain(chain: HookChain): boolean {
    try {
      this.chainEngine.register(chain);
    } catch (err) {
      logger.warn('HookDispatcher: chain not registered', { chain: chain.name, error: summarizeError(err) });
      return false;
    }
    this.chains.push(chain);
    return true;
  }

  /**
   * Fire an event and run all matching hooks.
   *
   * All matching hooks run sequentially. For Pre phase, the first deny sets
   * the aggregated decision; subsequent hooks still execute (for
   * logging/auditing) but their deny decisions don't change the outcome.
   * For all hooks: additionalContext strings are concatenated.
   * At a point whose contract is `fail_closed`, a hook that fails without a decision denies.
   * Once hooks are removed as they are selected to run, so two overlapping fires run one once.
   * Chains advance on every event and run their action when their last step matches.
   * Async hooks fire and forget.
   */
  async fire(event: HookEvent, options?: HookDispatchOptions): Promise<HookResult> {
    // Attribute any LLM usage a hook drives to the hook path (cost-origin scope),
    // so cost.attribution.get grouped by 'hook' reflects hook-caused spend.
    const owner = options?.owner;
    if (owner && event.sessionId !== owner.sessionId) throw new Error('Hook event session does not match its turn owner');
    const fire = (admitHook?: HookWorkAdmission) => withCostOriginAsync({ hook: event.path }, () => this.fireInScope(event, owner, admitHook));
    return owner ? owner.dispatch(fire) : fire();
  }

  private async fireInScope(event: HookEvent, owner?: TurnHookOwner, admitHook?: HookWorkAdmission): Promise<HookResult> {
    const contract = getHookPointContract(event.path);
    const matchingEntries: Array<{ pattern: string; hook: HookDefinition }> = [];

    for (const [pattern, defs] of this.hooks.entries()) {
      if (matchesEventPath(pattern, event.path)) {
        for (const hook of defs) {
          // Skip hooks explicitly disabled via disableHook() or `enabled: false`
          // in hooks.json. Strict === false preserves the default (undefined = enabled).
          if (hook.enabled === false) continue;
          const specificValue = event.specific;
          if (matchesMatcher(hook.matcher, specificValue)) {
            matchingEntries.push({ pattern, hook });
          }
        }
      }
    }

    const aggregated: HookResult = { ok: true };
    const contextParts: string[] = [];
    let updatedInput = undefined as Record<string, unknown> | undefined;

    const canDeny = contract?.canDeny ?? event.phase === 'Pre';
    // At a fail-closed point a guard that failed has not said yes: its failure refuses.
    const failClosed = canDeny && contract?.failurePolicy === 'fail_closed';
    // Folds one hook's (or chain action's) result into the event's outcome.
    const absorb = (result: HookResult, hookName?: string): void => {
      if (!result.ok) {
        aggregated.ok = false;
        if (!aggregated.error) aggregated.error = result.error;
        if (!aggregated.code) aggregated.code = result.code;
      }

      // For Pre hooks: first deny wins
      if (canDeny && result.decision === 'deny') {
        if (aggregated.decision !== 'deny') {
          aggregated.decision = 'deny';
          aggregated.reason = result.reason;
        }
      } else if (result.decision && canDeny && aggregated.decision !== 'deny') {
        aggregated.decision = result.decision;
        if (result.reason) aggregated.reason = result.reason;
      } else if (!result.ok && result.decision === undefined && failClosed && aggregated.decision !== 'deny') {
        aggregated.decision = 'deny';
        aggregated.reason = `Hook ${hookName ? `'${hookName}' ` : ''}at ${event.path} failed (${result.error ?? 'no reason given'}), so the call was refused. Fix or remove the hook, then retry.`;
      }

      // Last updatedInput wins
      if (result.updatedInput && (contract?.canMutateInput ?? true)) {
        updatedInput = result.updatedInput;
      }

      if (result.additionalContext && (contract?.canInjectContext ?? true)) {
        contextParts.push(result.additionalContext);
      }
    };

    for (const { pattern, hook } of matchingEntries) {
      if (owner?.signal.aborted) break;
      // A once hook is claimed before it runs, so a second fire that selected
      // it while this one is still awaiting it does not run it again.
      if (hook.once && !this.claimOnce(pattern, hook)) continue;
      // Async hooks run in the background under their own deadline: the turn neither waits for them nor cancels them.
      if (hook.async) {
        const asyncStart = Date.now();
        const execute = (signal?: AbortSignal) => this.runTrackedHook(hook, event, signal ? { signal } : undefined)
          .then((result) => {
            this.activityTracker.record(event, {
              pattern,
              hookName: hook.name,
              hookType: hook.type,
              result,
              durationMs: Date.now() - asyncStart,
              async: true,
              turnId: owner?.turnId,
            });
          })
          .catch((err) => {
            const message = summarizeError(err);
            logger.error('HookDispatcher: async hook error', {
              path: event.path,
              error: message,
            });
            this.activityTracker.record(event, {
              pattern,
              hookName: hook.name,
              hookType: hook.type,
              result: { ok: false, error: message },
              durationMs: Date.now() - asyncStart,
              async: true,
              turnId: owner?.turnId,
            });
          });
        // The dispatcher counts it (activeInvocationCount) until it ends; its deadline and grace bound it.
        void execute();
        continue;
      }

      let result: HookResult;
      const hookStart = Date.now();
      try {
        result = await (admitHook
          ? admitHook((signal) => this.runTrackedHook(hook, event, { signal }))
          : this.runTrackedHook(hook, event));
      } catch (err) {
        const message = summarizeError(err);
        logger.error('HookDispatcher: hook threw unexpectedly', {
          path: event.path,
          error: message,
        });
        result = { ok: false, error: message };
      }
      this.activityTracker.record(event, {
        pattern,
        hookName: hook.name,
        hookType: hook.type,
        result,
        durationMs: Date.now() - hookStart,
        async: false,
        turnId: owner?.turnId,
      });

      absorb(result, hook.name);
    }

    // Chains advance on every event, including one no hook matched.
    if (!owner?.signal.aborted) {
      try {
        const chainResult = await this.chainEngine.evaluate(event, (chain, chainEvent) => this.runChainAction(chain, chainEvent, owner, admitHook));
        if (chainResult) absorb(chainResult);
      } catch (err) {
        logger.error('HookDispatcher: chain evaluation failed', { path: event.path, error: summarizeError(err) });
      }
    }

    if (updatedInput) aggregated.updatedInput = updatedInput;
    if (contextParts.length > 0) aggregated.additionalContext = contextParts.join('\n');

    // Hook action dispatch is asynchronous; failures are logged and do not change
    // the hook result returned to the caller.
    if (this.hookActions && !owner?.signal.aborted) {
      fireHookActions(event, this.hookActions).catch((err) => {
        logger.warn('HookDispatcher: hook action dispatch failed', {
          path: event.path,
          error: summarizeError(err),
        });
      });
    }

    return aggregated;
  }

  /** Removes a once hook from the registry; false when another fire already took it. */
  private claimOnce(pattern: string, hook: HookDefinition): boolean {
    const defs = this.hooks.get(pattern);
    const idx = defs?.indexOf(hook) ?? -1;
    if (!defs || idx === -1) return false;
    defs.splice(idx, 1);
    if (defs.length === 0) this.hooks.delete(pattern);
    return true;
  }

  private async runChainAction(
    chain: HookChain,
    event: HookEvent,
    owner?: TurnHookOwner,
    admitHook?: HookWorkAdmission,
  ): Promise<HookResult> {
    const hook = chain.action;
    if (hook.enabled === false) return { ok: true };
    const start = Date.now();
    let result: HookResult;
    try {
      result = await (admitHook
        ? admitHook((signal) => this.runTrackedHook(hook, event, { signal }))
        : this.runTrackedHook(hook, event));
    } catch (err) {
      const message = summarizeError(err);
      logger.error('HookDispatcher: chain action threw unexpectedly', { chain: chain.name, path: event.path, error: message });
      result = { ok: false, error: message };
    }
    this.activityTracker.record(event, {
      pattern: `chain:${chain.name}`,
      hookName: hook.name ?? chain.name,
      hookType: hook.type,
      result,
      durationMs: Date.now() - start,
      async: false,
      turnId: owner?.turnId,
    });
    return result;
  }

  /** Get all registered hooks (for debugging/inspection) */
  getHooks(): Map<string, HookDefinition[]> {
    return new Map(this.hooks);
  }

  /** Get all registered chains */
  getChains(): HookChain[] {
    return [...this.chains];
  }

  /** Remove all hooks (for testing) */
  clear(): void {
    this.hooks.clear();
    this.chains = [];
    this.chainEngine.clear();
  }

  /**
   * Remove the hooks and chains that were read from a hooks file, leaving
   * those registered at runtime (for example by an approved `hooks add`).
   * A reload calls this before loading the file again.
   */
  clearLoaded(): void {
    for (const [pattern, defs] of [...this.hooks.entries()]) {
      const kept = defs.filter((hook) => !this.loadedHooks.has(hook));
      if (kept.length === 0) this.hooks.delete(pattern);
      else this.hooks.set(pattern, kept);
    }
    this.chains = this.chains.filter((chain) => {
      if (!this.loadedChains.has(chain)) return true;
      this.chainEngine.unregister(chain.name);
      return false;
    });
  }

  /**
   * List all registered hooks as a flat array with their event pattern included.
   */
  listHooks(): Array<{ pattern: string; hook: HookDefinition }> {
    const result: Array<{ pattern: string; hook: HookDefinition }> = [];
    for (const [pattern, defs] of this.hooks.entries()) {
      for (const hook of defs) {
        result.push({ pattern, hook });
      }
    }
    return result;
  }

  /**
   * Enable a named hook (sets enabled: true).
   * Returns true if found, false if no hook with that name exists.
   */
  enableHook(name: string): boolean {
    for (const defs of this.hooks.values()) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = true;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Disable a named hook (sets enabled: false).
   * Returns true if found, false if no hook with that name exists.
   */
  disableHook(name: string): boolean {
    for (const defs of this.hooks.values()) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = false;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Remove a named hook from the registry.
   * Returns true if removed, false if not found.
   */
  unregister(name: string): boolean {
    for (const [pattern, defs] of this.hooks.entries()) {
      const idx = defs.findIndex((h) => h.name === name);
      if (idx !== -1) {
        defs.splice(idx, 1);
        if (defs.length === 0) this.hooks.delete(pattern);
        return true;
      }
    }
    return false;
  }
}
