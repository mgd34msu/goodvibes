/** Per-runtime ownership of operator membership work, separate from a reply's
 * promise settlement. Stop cancels new effects and drains the actual work;
 * entered durable effects remain owned until acknowledged or explicitly unknown.
 */
export type MembershipOperationFailure = 'abandoned' | 'not-sent' | 'persistence-unknown';
export class ClusterMembershipOperationError extends Error {
  override readonly name = 'ClusterMembershipOperationError';
  constructor(readonly kind: MembershipOperationFailure) {
    super(kind === 'persistence-unknown' ? 'the group membership persistence outcome could not be confirmed'
      : kind === 'abandoned' ? 'the group membership operation was cancelled before its next effect'
      : 'another group membership operation is already in progress or the runtime is stopped');
  }
}
export interface ClusterMembershipOperation { readonly signal: AbortSignal }
interface OwnedOperation extends ClusterMembershipOperation { readonly controller: AbortController; task: Promise<unknown> | null }
export class ClusterMembershipOperations {
  private current: OwnedOperation | null = null;
  private accepting = true;
  private uncertain = false;
  get busy(): boolean { return this.current !== null; }
  get available(): boolean { return this.accepting && !this.uncertain; }
  start(): void { this.accepting = true; }
  reconciled(): void { this.uncertain = false; }
  stop(): void { this.accepting = false; this.current?.controller.abort(); }
  markUnknown(): void { this.uncertain = true; this.current?.controller.abort(); }
  assert(owner: ClusterMembershipOperation, finishingEnteredEffect = false): void {
    if (this.current !== owner || (!finishingEnteredEffect && owner.signal.aborted)) throw new ClusterMembershipOperationError('abandoned');
    if (this.uncertain) throw new ClusterMembershipOperationError('persistence-unknown');
  }
  run<T>(work: (owner: ClusterMembershipOperation) => Promise<T>, owner?: ClusterMembershipOperation): Promise<T> {
    if (owner) { this.assert(owner); return work(owner); }
    if (this.uncertain) return Promise.reject(new ClusterMembershipOperationError('persistence-unknown'));
    if (!this.accepting || this.current) return Promise.reject(new ClusterMembershipOperationError('not-sent'));
    const controller = new AbortController();
    const admitted: OwnedOperation = { controller, signal: controller.signal, task: null };
    this.current = admitted;
    const task = Promise.resolve().then(() => { this.assert(admitted); return work(admitted); });
    admitted.task = task;
    // Both outcomes release ONLY this fully drained operation; no cancellation
    // race settles a public promise while its mutation continues unowned.
    void task.then(() => { if (this.current === admitted) this.current = null; }, () => { if (this.current === admitted) this.current = null; });
    return task;
  }
  async join(): Promise<void> { const task = this.current?.task; if (task) await task.catch(() => {}); }
}
