import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizePermissionMode, type GatePresetName } from './presets.js';

const executionMode = new AsyncLocalStorage<{ readonly mode: GatePresetName; readonly assertCurrent: (() => void) | undefined; readonly retainedCurrent: (() => void) | undefined; active: boolean; checking: boolean }>();
export { isInvocationAdmitted } from '../tools/registry.js';

export interface ExecutionModeOwner {
  getMode(): GatePresetName;
  getRevision(): number;
}
const executionOwner = new AsyncLocalStorage<ExecutionModeOwner>();

/** Host-owned invocation scope. Tool arguments never select the execution mode. */
export function withExecutionMode<T>(mode: unknown, run: () => Promise<T>, assertCurrent?: () => void): Promise<T>;
export function withExecutionMode<T>(mode: unknown, run: () => T, assertCurrent?: () => void): T;
export function withExecutionMode(mode: unknown, run: () => unknown, assertCurrent?: () => void): unknown {
  return runInMode(mode, run, assertCurrent, assertCurrent);
}

function runInMode(mode: unknown, run: () => unknown, assertCurrent?: () => void, retainedCurrent?: () => void): unknown {
  const scope = { mode: normalizePermissionMode(mode), assertCurrent, retainedCurrent, active: true, checking: false };
  return executionMode.run(scope, () => {
    try {
      const result = run();
      if (result instanceof Promise) return result.finally(() => { scope.active = false; });
      scope.active = false;
      return result;
    } catch (error) {
      scope.active = false;
      throw error;
    }
  });
}

export function currentExecutionMode(): GatePresetName | undefined {
  const scope = executionMode.getStore();
  if (scope && !scope.active) throw new Error('Execution mode is no longer current');
  if (scope?.assertCurrent) {
    if (scope.checking) throw new Error('Execution mode owner reentered its currentness check');
    scope.checking = true;
    try { scope.assertCurrent(); }
    finally { scope.checking = false; }
  }
  return scope?.mode ?? currentExecutionModeOwner()?.getMode();
}

/** Transfer host mode checks into a separately owned asynchronous lifetime. */
export function withRetainedExecutionMode<T>(run: () => Promise<T>): Promise<T> {
  const mode = currentExecutionMode();
  if (mode === undefined) return run();
  const owner = currentExecutionModeOwner();
  const ownerRevision = owner?.getRevision();
  const ownerMode = owner?.getMode();
  const assertCurrent = executionMode.getStore()?.retainedCurrent ?? (owner ? () => {
    if (currentExecutionModeOwner() !== owner || owner.getRevision() !== ownerRevision || owner.getMode() !== ownerMode) {
      throw new Error('Execution mode owner changed during retained execution');
    }
  } : undefined);
  return withExecutionMode(mode, run, assertCurrent);
}

/** Bind only mode/owner context; source and exact tool authority remain with each callback's caller. */
export function bindExecutionModeContext(): <T>(run: () => T) => T {
  currentExecutionMode();
  const scope = executionMode.getStore();
  const owner = currentExecutionModeOwner();
  return <T>(run: () => T): T => {
    const enterMode = () => scope ? executionMode.run(scope, run) : executionMode.exit(run);
    return owner ? executionOwner.run(owner, enterMode) : executionOwner.exit(enterMode);
  };
}

export function isYoloExecution(): boolean {
  return currentExecutionMode() === 'yolo';
}

/** Session-owned mode selection remains live while each invocation captures its own mode. */
export function withExecutionModeOwner<T>(owner: ExecutionModeOwner, run: () => T): T {
  owner.getRevision();
  return executionOwner.run(owner, run);
}

export function currentExecutionModeOwner(): ExecutionModeOwner | undefined {
  const owner = executionOwner.getStore();
  owner?.getRevision();
  return owner;
}

/** Tool proof expires at return; a retained job keeps only the host mode owner. */
export function withInvocationExecutionMode<T>(mode: unknown, run: () => Promise<T>, assertCurrent?: () => void, retainedCurrent?: () => void): Promise<T> {
  return runInMode(mode, run, assertCurrent, retainedCurrent ?? executionMode.getStore()?.retainedCurrent) as Promise<T>;
}
