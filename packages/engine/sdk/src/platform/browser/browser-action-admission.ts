import { currentExecutionMode, isInvocationAdmitted } from '../gate/execution-context.js';
import { assertCurrentToolInvocation } from '../tools/registry.js';
import type { ToolExecuteOptions } from '../types/tools.js';
import type { BrowserActionLifetime } from './browser-engine-contract.js';

const actions = new WeakMap<() => void, { readonly engine: object; readonly args: Record<string, unknown>; readonly sessionId: string; readonly pageId: string }>();
const controlWork = new WeakMap<object, () => void>();
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Retain the exact registered browser invocation; arbitrary lifetime callbacks carry no admission. */
export function retainAdmittedBrowserAction(engine: object, args: Record<string, unknown>, options: ToolExecuteOptions,
  additional: () => void, sessionId: string, pageId: string): BrowserActionLifetime | undefined {
  if (!isInvocationAdmitted('browser', args) || !assertCurrentToolInvocation(args, options)) return undefined;
  const assertCurrent = () => {
    currentExecutionMode(); additional();
    if (!isInvocationAdmitted('browser', args) || !assertCurrentToolInvocation(args, options)) throw new Error('Browser invocation is no longer current');
    additional();
  };
  const lifetime = Object.freeze({ assertCurrent, signal: options.signal });
  actions.set(assertCurrent, { engine, args, sessionId, pageId });
  assertCurrent();
  return lifetime;
}

/** Only the original engine, action, target and payload may reuse the shared decision. */
export function isAdmittedBrowserAction(engine: object, lifetime: BrowserActionLifetime | undefined,
  sessionId: string, pageId: string, action: string, actual: Readonly<Record<string, unknown>>): boolean {
  if (!lifetime) return false;
  const captured = actions.get(lifetime.assertCurrent);
  if (!captured || captured.engine !== engine || captured.sessionId !== sessionId || captured.pageId !== pageId) return false;
  lifetime.assertCurrent();
  const args = captured.args;
  if (text(args.action).toLowerCase().replace(/-/g, '_') !== action || text(args.ref) !== actual.ref
    || (text(args.sessionId) && text(args.sessionId) !== sessionId) || (text(args.pageId) && text(args.pageId) !== pageId)) return false;
  if (action === 'type' && ((typeof args.text === 'string' ? args.text : '') !== actual.text
    || (args.submit === true) !== (actual.submit === true) || (args.replace !== false) !== (actual.replace !== false))) return false;
  if (action === 'press' && text(args.key) !== actual.key) return false;
  if (action === 'click' && ((args.button === 'right' || args.button === 'middle' ? args.button : 'left') !== (actual.button ?? 'left')
    || (actual.clickCount ?? 1) !== 1)) return false;
  if (action === 'select') {
    const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean) : [];
    if (JSON.stringify(values) !== JSON.stringify(actual.values)) return false;
  }
  lifetime.assertCurrent();
  return true;
}

/** Private work retention; the public ref resolver cannot accept a caller-written grant. */
export function retainAdmittedBrowserWork(work: object, engine: object, lifetime: BrowserActionLifetime | undefined,
  sessionId: string, pageId: string, action: string, args: Readonly<Record<string, unknown>>, current: () => void): void {
  const allowed = () => currentExecutionMode() === 'yolo' || isAdmittedBrowserAction(engine, lifetime, sessionId, pageId, action, args);
  if (!allowed()) return;
  controlWork.set(work, () => { current(); if (!allowed()) throw new Error('Browser action decision is no longer current'); current(); });
}

export function hasAdmittedBrowserWork(work: object): boolean {
  const current = controlWork.get(work);
  if (!current) return false;
  current();
  return true;
}
