import { JudgmentError } from '@goodvibes-jev/judgment';
import { executePolicyCheck } from '../gate/execute-policy-check.js';

/**
 * Permission code only: a cancelled approval surfaces as the judgment layer's
 * `aborted` error. Caller reasons can contain private context and never cross
 * permission boundaries. Any other cancellable wait (a socket read, a child
 * process, a model reading) uses `signal.throwIfAborted()` or
 * gate/execute-policy-check.ts, which reject with the signal's own reason.
 */
export function assertPermissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new JudgmentError('aborted', 'the permission request was cancelled');
}

/** Wait for permission work, releasing the caller on cancellation without adopting a late result. Permission code only. */
export async function awaitPermission<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  try { return await executePolicyCheck(work, signal); } catch (error) { assertPermissionActive(signal); throw error; }
}
