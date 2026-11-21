import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { getHookPointContract } from './contracts.js';
import { matchesEventPath, matchesMatcher } from './matcher.js';
import { chainProblem, hookDefinitionProblem, hooksFileRefusal, type HookDispatcher } from './dispatcher.js';
import type { HookChain, HookDefinition, HookEvent, HookResult, HookType, HooksConfig } from './types.js';
import type { ConfigManager } from '../config/manager.js';
import type { RepositoryFileGate } from '../runtime/workspace-trust.js';
import { summarizeError } from '../utils/error-display.js';

export interface HookAuthoringAction {
  readonly kind: 'load' | 'save' | 'reload' | 'scaffold-hook' | 'scaffold-chain' | 'remove' | 'toggle' | 'simulate' | 'export' | 'import' | 'inspect';
  readonly target: string;
  readonly timestamp: number;
  readonly detail?: string | undefined;
}

export interface HookSimulationResult {
  readonly eventPath: string;
  readonly matchedHooks: readonly {
    readonly pattern: string;
    readonly name: string;
    readonly type: HookType;
    readonly contract: string;
  }[];
  readonly matchedChains: readonly {
    readonly name: string;
    readonly stepMatches: number;
  }[];
  readonly capturedAt: number;
}

export interface HookConfigInspection {
  readonly path: string;
  readonly hookCount: number;
  readonly chainCount: number;
  readonly patterns: readonly string[];
}

/** What the workbench drives on the dispatcher; `setLoadedHooksCheck` is absent on a dispatcher that cannot hold a check. */
export type WorkbenchHookDispatcher = Pick<HookDispatcher, 'clearLoaded' | 'loadFromFile'> & Partial<Pick<HookDispatcher, 'setLoadedHooksCheck'>>;

export interface HookWorkbenchOptions {
  readonly hookDispatcher: WorkbenchHookDispatcher;
  readonly configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory'>;
  readonly hooksFilePathResolver?: (() => string) | undefined;
}

/**
 * Whether a hooks file may load: a file the workspace's repository could have
 * brought waits until the owner trusts the workspace. Bound by the product's composition.
 */
export type HooksFileTrustGate = RepositoryFileGate;

/** The hooks file was not loaded because the workspace it sits in is not trusted yet. */
export class HooksFileAwaitingTrustError extends Error {
  constructor(readonly path: string) {
    super(`The hooks file ${path} is in this workspace, which you have not trusted, so its hooks are not loaded and run nothing. Run /security trust-folder to load them.`);
    this.name = 'HooksFileAwaitingTrustError';
  }
}

const EMPTY_CONFIG: HooksConfig = Object.freeze({ hooks: {}, chains: [] });

function cloneConfig(config: HooksConfig): HooksConfig {
  return {
    hooks: Object.fromEntries(
      Object.entries(config.hooks ?? {}).map(([pattern, defs]) => [pattern, defs.map((def) => ({ ...def }))]),
    ),
    chains: (config.chains ?? []).map((chain) => ({
      ...chain,
      steps: chain.steps.map((step) => ({ ...step })),
      action: { ...chain.action },
    })),
  };
}

function ensureConfigShape(parsed: unknown): HooksConfig {
  if (!parsed || typeof parsed !== 'object') return cloneConfig(EMPTY_CONFIG);
  const candidate = parsed as Partial<HooksConfig>;
  return {
    hooks: candidate.hooks && typeof candidate.hooks === 'object' ? candidate.hooks : {},
    chains: Array.isArray(candidate.chains) ? candidate.chains : [],
  };
}

/** Splits an imported config into the entries the dispatcher would accept and a reason for each it would drop. */
function screenImport(config: HooksConfig): { config: HooksConfig; rejected: string[] } {
  const rejected: string[] = [];
  const hooks: Record<string, HookDefinition[]> = {};
  for (const [pattern, defs] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(defs)) { rejected.push(`${pattern}: the value must be an array of hook definitions`); continue; }
    for (const def of defs) {
      // The key too: a dead key, or a `match` that disagrees with it, is refused on reload.
      const problem = hookDefinitionProblem(def, pattern);
      if (problem !== null) rejected.push(`${pattern}: ${problem}`);
      else (hooks[pattern] ??= []).push(def);
    }
  }
  const chains: HookChain[] = [];
  for (const chain of config.chains ?? []) {
    const problem = chainProblem(chain);
    if (problem !== null) rejected.push(problem);
    else chains.push(chain);
  }
  return { config: { hooks, chains }, rejected };
}

export class HookWorkbench {
  private managedConfig: HooksConfig = cloneConfig(EMPTY_CONFIG);
  private recentActions: HookAuthoringAction[] = [];
  private lastSimulation: HookSimulationResult | null = null;
  private lastLoadedPath: string | null = null;
  /** Why the last load could not read the hooks file; while set, nothing may overwrite it. */
  private loadFailure: string | null = null;
  private lastImportRejections: string[] = [];
  private trustGate: HooksFileTrustGate | null = null;
  /** The hooks file waiting on the owner's trust of the workspace, or null. */
  private awaitingTrust: string | null = null;

  constructor(
    private readonly hookDispatcher: WorkbenchHookDispatcher,
    private readonly hooksFilePathResolver: () => string,
  ) {}

  getHooksFilePath(): string {
    return this.hooksFilePathResolver();
  }

  /**
   * Hold a hooks file the workspace's repository could have brought until the
   * owner trusts the workspace, load it the moment he does, and stop its hooks
   * the moment the workspace is restricted again (here or in another process).
   * Returns the unbinding.
   */
  bindTrustGate(gate: HooksFileTrustGate): () => void {
    this.trustGate = gate;
    const unsubscribe = gate.onLevelChanged((level) => {
      const path = this.getHooksFilePath();
      if (this.awaitingTrust === null) {
        // Restricted: nothing from a file the decision now holds back runs from here on.
        if (!existsSync(path) || !gate.holds(path)) return;
        this.hookDispatcher.clearLoaded();
        this.awaitingTrust = path;
        this.recordAction({ kind: 'reload', target: path, timestamp: Date.now(), detail: 'workspace restricted; its hooks were stopped' });
        return;
      }
      void this.loadAndApplyManagedHooks().catch((error: unknown) => {
        if (error instanceof HooksFileAwaitingTrustError) return;
        logger.warn('HookWorkbench: the hooks file was not applied after the workspace trust changed', { level, error: summarizeError(error) });
      });
    });
    // A process with no permission ask in flight (the daemon) still sees another
    // process's restriction before a hook from the file runs: while hooks from a
    // file are loaded, each dispatch costs one stat of the workspace register,
    // and a changed level reaches the listener above before any hook runs.
    this.hookDispatcher.setLoadedHooksCheck?.(() => gate.load());
    return () => {
      unsubscribe();
      if (this.trustGate === gate) {
        this.trustGate = null;
        this.hookDispatcher.setLoadedHooksCheck?.(null);
      }
    };
  }

  /** The hooks file waiting on the owner's trust of the workspace, or null when none waits. */
  getAwaitingTrust(): string | null {
    return this.awaitingTrust;
  }

  getManagedConfig(): HooksConfig {
    return cloneConfig(this.managedConfig);
  }

  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }> {
    const entries: Array<{ pattern: string; hook: HookDefinition }> = [];
    for (const [pattern, defs] of Object.entries(this.managedConfig.hooks ?? {})) {
      for (const hook of defs) entries.push({ pattern, hook: { ...hook } });
    }
    return entries;
  }

  listManagedChains(): HookChain[] {
    return (this.managedConfig.chains ?? []).map((chain) => ({
      ...chain,
      steps: chain.steps.map((step) => ({ ...step })),
      action: { ...chain.action },
    }));
  }

  listRecentActions(limit = 8): HookAuthoringAction[] {
    return this.recentActions.slice(0, limit);
  }

  getLastSimulation(): HookSimulationResult | null {
    return this.lastSimulation;
  }

  /** Entries the last import left out, each with the reason; empty when it took everything. */
  getLastImportRejections(): readonly string[] {
    return [...this.lastImportRejections];
  }

  /** Refuses to change or write a config that was never read: the empty one would replace the real file. */
  private assertWritable(): void {
    if (this.loadFailure !== null) {
      throw new Error(`The hooks file${this.lastLoadedPath ? ` ${this.lastLoadedPath}` : ''} was not changed: it ${this.loadFailure.replace(/^it /, '')}. Fix or remove the file, then retry.`);
    }
  }

  private recordAction(action: HookAuthoringAction): void {
    this.recentActions.unshift(action);
    if (this.recentActions.length > 25) this.recentActions.length = 25;
  }

  loadManagedConfig(path = this.getHooksFilePath()): HooksConfig {
    this.lastLoadedPath = path;
    this.loadFailure = null;
    if (!existsSync(path)) {
      this.managedConfig = cloneConfig(EMPTY_CONFIG);
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: 'empty config' });
      return this.getManagedConfig();
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      this.managedConfig = ensureConfigShape(parsed);
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: `${this.listManagedHooks().length} hooks / ${this.listManagedChains().length} chains` });
    } catch (error) {
      logger.warn('HookWorkbench.loadManagedConfig failed, nothing may be written over it', { path, error: summarizeError(error) });
      this.managedConfig = cloneConfig(EMPTY_CONFIG);
      this.loadFailure = `it could not be read as JSON (${summarizeError(error)})`;
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: 'invalid JSON; file left untouched' });
    }
    return this.getManagedConfig();
  }

  async saveManagedConfig(path = this.lastLoadedPath ?? this.getHooksFilePath()): Promise<void> {
    this.assertWritable();
    mkdirSync(dirname(path), { recursive: true });
    // Written beside the target and renamed over it, so a failed write leaves the old file whole.
    // The shared writer stages under a name unique to each call, so two saves in one process cannot collide.
    let mode: number | undefined;
    try { mode = statSync(path).mode & 0o777; } catch { mode = undefined; }
    writeFileAtomic(path, `${JSON.stringify(this.managedConfig, null, 2)}\n`, { ...(mode === undefined ? {} : { mode }), durable: false });
    this.lastLoadedPath = path;
    this.recordAction({ kind: 'save', target: path, timestamp: Date.now(), detail: `${this.listManagedHooks().length} hooks / ${this.listManagedChains().length} chains` });
  }

  /** Throws when the hooks file would be refused at load (unparseable, world-writable, foreign-owned); call it before changing the file so a verb never saves what it cannot then apply. */
  assertHooksFileTrusted(path = this.getHooksFilePath()): void {
    this.assertWritable();
    const refusal = existsSync(path) ? hooksFileRefusal(path) : null;
    if (refusal !== null) throw new Error(`The hooks file ${path} was not changed: it was not loaded because ${refusal}. Fix the file, then retry.`);
  }

  async loadAndApplyManagedHooks(path = this.getHooksFilePath()): Promise<void> {
    const gate = this.trustGate;
    if (gate !== null && existsSync(path)) {
      await gate.load();
      if (gate.holds(path)) {
        // Nothing from it runs, including hooks an earlier load of it left registered.
        this.hookDispatcher.clearLoaded();
        this.awaitingTrust = path;
        this.recordAction({ kind: 'reload', target: path, timestamp: Date.now(), detail: 'waiting on workspace trust; not loaded' });
        throw new HooksFileAwaitingTrustError(path);
      }
    }
    this.awaitingTrust = null;
    this.loadManagedConfig(path);
    // Hooks already running stay as they are when the file cannot be trusted or read.
    if (this.loadFailure !== null) throw new Error(`The running hooks were left unchanged: ${path} ${this.loadFailure}.`);
    const refusal = existsSync(path) ? hooksFileRefusal(path) : null;
    if (refusal !== null) throw new Error(`The running hooks were left unchanged: ${path} was not loaded because ${refusal}.`);
    // Only what came from a file is replaced; hooks added at runtime stay.
    this.hookDispatcher.clearLoaded();
    this.hookDispatcher.loadFromFile(path);
    this.recordAction({ kind: 'reload', target: path, timestamp: Date.now(), detail: 'dispatcher refreshed' });
  }

  scaffoldHook(name: string, match: string, type: HookType): HookDefinition {
    this.assertWritable();
    const hook: HookDefinition = {
      name,
      match,
      type,
      enabled: false,
      description: `Managed hook scaffold for ${match}`,
      ...(type === 'command' ? { command: 'echo implement-hook' } : {}),
      ...(type === 'prompt' ? { prompt: 'Return a HookResult JSON object for $ARGUMENTS.' } : {}),
      ...(type === 'http' ? { url: 'http://localhost:3000/hooks' } : {}),
      ...(type === 'ts' ? { path: './hooks/handler.ts' } : {}),
      ...(type === 'agent' ? { prompt: 'Handle this hook event: $ARGUMENTS' } : {}),
    };
    const config = cloneConfig(this.managedConfig);
    config.hooks ??= {};
    config.hooks[match] ??= [];
    config.hooks[match]?.push(hook);
    this.managedConfig = config;
    this.recordAction({ kind: 'scaffold-hook', target: name, timestamp: Date.now(), detail: `${type} ${match}` });
    return hook;
  }

  scaffoldChain(name: string, matches: readonly string[]): HookChain {
    this.assertWritable();
    const chain: HookChain = {
      name,
      description: `Managed hook workflow for ${matches.join(' -> ')}`,
      steps: matches.map((match) => ({ match })),
      action: {
        name: `${name}-action`,
        match: matches[matches.length - 1] ?? 'Post:tool:*',
        type: 'command',
        command: 'echo chain-action',
        enabled: true,
      },
    };
    const config = cloneConfig(this.managedConfig);
    config.chains ??= [];
    config.chains.push(chain);
    this.managedConfig = config;
    this.recordAction({ kind: 'scaffold-chain', target: name, timestamp: Date.now(), detail: matches.join(' -> ') });
    return chain;
  }

  removeManagedEntry(name: string): boolean {
    this.assertWritable();
    const config = cloneConfig(this.managedConfig);
    let removed = false;
    for (const [pattern, defs] of Object.entries(config.hooks ?? {})) {
      const nextDefs = defs.filter((def) => def.name !== name);
      if (nextDefs.length !== defs.length) {
        removed = true;
        if (nextDefs.length === 0) delete config.hooks?.[pattern];
        else config.hooks![pattern] = nextDefs;
      }
    }
    const nextChains = (config.chains ?? []).filter((chain) => chain.name !== name);
    if (nextChains.length !== (config.chains ?? []).length) {
      removed = true;
      config.chains = nextChains;
    }
    if (removed) {
      this.managedConfig = config;
      this.recordAction({ kind: 'remove', target: name, timestamp: Date.now() });
    }
    return removed;
  }

  toggleManagedHook(name: string, enabled: boolean): boolean {
    this.assertWritable();
    let changed = false;
    const config = cloneConfig(this.managedConfig);
    for (const defs of Object.values(config.hooks ?? {})) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = enabled;
          changed = true;
        }
      }
    }
    if (changed) {
      this.managedConfig = config;
      this.recordAction({ kind: 'toggle', target: name, timestamp: Date.now(), detail: enabled ? 'enabled' : 'disabled' });
    }
    return changed;
  }

  async exportManagedConfig(path: string): Promise<string> {
    await this.saveManagedConfig(path);
    this.recordAction({ kind: 'export', target: path, timestamp: Date.now() });
    return path;
  }

  inspectManagedConfig(path: string): HookConfigInspection {
    const config = ensureConfigShape(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    const inspection: HookConfigInspection = {
      path,
      hookCount: Object.values(config.hooks ?? {}).reduce((sum, defs) => sum + defs.length, 0),
      chainCount: (config.chains ?? []).length,
      patterns: Object.keys(config.hooks ?? {}).sort((a, b) => a.localeCompare(b)),
    };
    this.recordAction({
      kind: 'inspect',
      target: path,
      timestamp: Date.now(),
      detail: `${inspection.hookCount} hooks / ${inspection.chainCount} chains`,
    });
    return inspection;
  }

  importManagedConfig(path: string, strategy: 'merge' | 'replace' = 'merge'): HooksConfig {
    this.assertWritable();
    const { config: incoming, rejected } = screenImport(ensureConfigShape(JSON.parse(readFileSync(path, 'utf-8'))));
    this.lastImportRejections = rejected;
    if (strategy === 'replace') {
      this.managedConfig = cloneConfig(incoming);
    } else {
      const merged = cloneConfig(this.managedConfig);
      merged.hooks ??= {};
      for (const [pattern, defs] of Object.entries(incoming.hooks ?? {})) {
        const existing = merged.hooks[pattern]! ?? [];
        const byName = new Map(existing.map((def) => [def.name ?? `${pattern}:${JSON.stringify(def)}`, { ...def }]));
        for (const def of defs) {
          byName.set(def.name ?? `${pattern}:${JSON.stringify(def)}`, { ...def });
        }
        merged.hooks[pattern] = [...byName.values()];
      }
      const existingChains = new Map((merged.chains ?? []).map((chain) => [chain.name, {
        ...chain,
        steps: chain.steps.map((step) => ({ ...step })),
        action: { ...chain.action },
      }]));
      for (const chain of incoming.chains ?? []) {
        existingChains.set(chain.name, {
          ...chain,
          steps: chain.steps.map((step) => ({ ...step })),
          action: { ...chain.action },
        });
      }
      merged.chains = [...existingChains.values()];
      this.managedConfig = merged;
    }
    this.recordAction({
      kind: 'import',
      target: path,
      timestamp: Date.now(),
      detail: `${strategy} -> ${this.listManagedHooks().length} hooks / ${this.listManagedChains().length} chains${rejected.length > 0 ? `; ${rejected.length} rejected` : ''}`,
    });
    return this.getManagedConfig();
  }

  simulate(eventPath: string, payload: Record<string, unknown> = {}): HookSimulationResult {
    const [phase, category, ...specificParts] = eventPath.split(':');
    const specific = specificParts.join(':');
    const event: HookEvent = {
      path: eventPath as HookEvent['path'],
      phase: phase as HookEvent['phase'],
      category: category as HookEvent['category'],
      specific,
      sessionId: 'hook-sim',
      timestamp: Date.now(),
      payload,
    };
    const matchedHooks = this.listManagedHooks()
      .filter(({ pattern, hook }) => matchesEventPath(pattern, event.path) && matchesMatcher(hook.matcher, event.specific, event.effects))
      .map(({ pattern, hook }) => ({
        pattern,
        name: hook.name ?? '(unnamed)',
        type: hook.type,
        contract: getHookPointContract(event.path)?.description ?? 'No exact contract',
      }));
    const matchedChains = this.listManagedChains()
      .map((chain) => ({
        name: chain.name,
        stepMatches: chain.steps.filter((step) => matchesEventPath(step.match, event.path)).length,
      }))
      .filter((chain) => chain.stepMatches > 0);
    const result: HookSimulationResult = {
      eventPath,
      matchedHooks,
      matchedChains,
      capturedAt: Date.now(),
    };
    this.lastSimulation = result;
    this.recordAction({
      kind: 'simulate',
      target: eventPath,
      timestamp: result.capturedAt,
      detail: `${matchedHooks.length} hooks / ${matchedChains.length} chains`,
    });
    return result;
  }

  clear(): void {
    this.managedConfig = cloneConfig(EMPTY_CONFIG);
    this.recentActions = [];
    this.lastSimulation = null;
    this.lastLoadedPath = null;
    this.loadFailure = null;
    this.lastImportRejections = [];
  }
}

export function createHookWorkbench(options: HookWorkbenchOptions): HookWorkbench {
  const hooksFilePathResolver = options.hooksFilePathResolver ?? (() => {
    const workingDirectory = options.configManager.getWorkingDirectory();
    if (!workingDirectory) {
      throw new Error('createHookWorkbench requires configManager.getWorkingDirectory() when no hooksFilePathResolver is provided');
    }
    return resolve(workingDirectory, options.configManager.get('tools.hooksFile') as string);
  });
  return new HookWorkbench(
    options.hookDispatcher,
    hooksFilePathResolver,
  );
}
