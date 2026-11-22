import { AsyncLocalStorage } from 'node:async_hooks';

interface DelegationRequest {
  /** The work as the owner asked for it (agents/delegation-authority.ts standingWorkRequest), never only his latest message. */
  readonly request: string;
  /** Everything the owner said in this conversation, oldest first: his own messages, never a host-made one. */
  readonly ownerMessages: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
const current = new AsyncLocalStorage<DelegationRequest>();

export function withDelegationRequest<T>(source: DelegationRequest, run: () => T): T {
  return current.run(Object.freeze({ ...source, ownerMessages: Object.freeze([...source.ownerMessages]) }), run);
}
export function readDelegationRequest(): DelegationRequest | undefined { return current.getStore(); }
