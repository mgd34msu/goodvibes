import { AsyncLocalStorage } from 'node:async_hooks';
import { assertCurrentToolEffect, isInvocationAdmitted } from '../registry.js';
import { ToolInputProjectionError } from '../input-projection.js';
import type { ToolExecuteOptions } from '../../types/tools.js';
import type { FetchInput, FetchUrlInput } from './schema.js';

interface FetchInvocation {
  readonly input: FetchInput;
  readonly assertCurrent: () => void;
  active: boolean;
}
interface FetchRequest {
  readonly invocation: FetchInvocation;
  readonly url: string;
}
const invocations = new AsyncLocalStorage<FetchInvocation>();
const requests = new AsyncLocalStorage<FetchRequest>();
const sockets = new AsyncLocalStorage<FetchRequest>();

/** Only the exact registry-admitted fetch body may reuse its initial request decision. */
export async function runFetchInvocation<T>(args: Record<string, unknown>, options: ToolExecuteOptions | undefined,
  input: FetchInput, run: () => Promise<T>): Promise<T> {
  if (!isInvocationAdmitted('fetch', args)) return withoutFetchInvocation(run);
  const invocation: FetchInvocation = { input, active: true, assertCurrent: () => {
    if (!invocation.active || !isInvocationAdmitted('fetch', args)
      || !assertCurrentToolEffect(args, options, 'send')) throw new ToolInputProjectionError('stale');
  } };
  return invocations.run(invocation, async () => {
    try { invocation.assertCurrent(); return await run(); }
    finally { invocation.active = false; }
  });
}

export function hasDifferentFetchInvocation(input: FetchInput): boolean {
  const invocation = invocations.getStore();
  return invocation !== undefined && invocation.input !== input;
}

/** A raw nested service call cannot inherit another fetch's native request authority. */
export function withoutFetchInvocation<T>(run: () => T): T {
  return invocations.exit(() => requests.exit(() => sockets.exit(run)));
}

export function runFetchRequest<T>(input: FetchInput, request: FetchUrlInput, url: string, run: () => T): T {
  const invocation = invocations.getStore();
  if (!invocation || invocation.input !== input || !input.urls.includes(request)) return requests.exit(run);
  invocation.assertCurrent();
  return requests.run({ invocation, url: new URL(url).href }, run);
}

/** Redirect hops acquire their own checks instead of inheriting the initial URL's decision. */
export function runFetchSocketHop<T>(url: string, redirectCount: number, run: () => T): T {
  const request = requests.getStore();
  if (!request || redirectCount !== 0 || request.url !== new URL(url).href) return sockets.exit(run);
  request.invocation.assertCurrent();
  return sockets.run(request, run);
}

export function isAdmittedFetchRequest(url: string): boolean {
  const request = requests.getStore();
  if (!request || request.url !== new URL(url).href) return false;
  request.invocation.assertCurrent();
  return true;
}

export function isAdmittedFetchSocket(url: string): boolean {
  const request = sockets.getStore();
  if (!request || request.url !== new URL(url).href) return false;
  request.invocation.assertCurrent();
  return true;
}
