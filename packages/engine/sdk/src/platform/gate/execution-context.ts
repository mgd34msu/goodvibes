import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizePermissionMode, type GatePresetName } from './presets.js';

const executionMode = new AsyncLocalStorage<{ readonly mode: GatePresetName; readonly assertCurrent: (() => void) | undefined; active: boolean; checking: boolean }>();
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
  const scope = { mode: normalizePermissionMode(mode), assertCurrent, active: true, checking: false };
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
