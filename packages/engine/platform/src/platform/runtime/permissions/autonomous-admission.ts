/**
 * The one scope an autonomous admission (localhost fetch, sandbox escalation,
 * terminal control) runs in: one invalidation subscription, one combined
 * signal, and the operation's source captured once and frozen.
 *
 * "Still current" is integer-cheap and does not re-read anything: the combined
 * signal, the caller's own execution check, the operation's own check, and the
 * workspace-trust capability (an identity compare plus its prepared assertion).
 * The request the caller admits is a value it built and nobody else holds, so
 * it is captured once by the caller and never deep-compared again.
 */
import { captureAutonomousSource, type AutonomousToolSource } from '../../permissions/autonomous.js';
import type { ExternalOperationSource } from '../../permissions/external-request.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';

export interface AutonomousAdmissionScope {
  readonly signal: AbortSignal;
  /** The operation's source as it was when the scope opened. */
  readonly source: AutonomousToolSource;
  /** Throws when the scope is closed, cancelled, invalidated, or the operation or workspace trust moved. */
  readonly assertCurrent: () => void;
  /** Release the subscription; idempotent. */
  readonly close: () => void;
}

/**
 * Open the scope, or undefined when the host cannot admit autonomously (no
 * workspace-trust decision, or a trust manager without the capability).
 */
export async function openAutonomousAdmission(
  host: AutonomousToolPromptHost,
  operation: ExternalOperationSource,
  execution: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void },
  access: 'read' | 'execute',
  label: string,
): Promise<AutonomousAdmissionScope | undefined> {
  if (host.workspaceTrust === undefined) return undefined;
  const workspaceTrust = host.workspaceTrust;
  const prepareTrust = workspaceTrust?.prepareAutonomousConstraint;
  if (workspaceTrust !== null && typeof prepareTrust !== 'function') return undefined;
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; unsubscribe(); } };
  try {
    const signal = AbortSignal.any([host.signal, invalidation.signal, ...(execution.signal ? [execution.signal] : []),
      ...(operation.signal ? [operation.signal] : [])]);
    const assertTrust = await prepareTrust?.call(workspaceTrust, access, signal);
    const source = captureAutonomousSource(operation.sourceOf());
    const assertCurrent = (): void => {
      if (closed) throw new Error(`${label} admission closed`);
      signal.throwIfAborted(); execution.assertCurrent(); operation.assertCurrent(); assertTrust?.();
      if (host.workspaceTrust !== workspaceTrust || workspaceTrust?.prepareAutonomousConstraint !== prepareTrust) throw new Error('Workspace trust capability changed');
    };
    return { signal, source, assertCurrent, close };
  } catch (error) { close(); throw error; }
}
