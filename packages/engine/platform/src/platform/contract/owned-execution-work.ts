import { bindExecutionModeContext, withRetainedExecutionMode } from '../gate/execution-context.js';
import { OwnedWork } from '../utils/owned-work.js';

/** Contract callbacks retain their originating host mode until actual drainage. */
export class ContractExecutionWork extends OwnedWork {
  private readonly enter: <T>(callback: () => T) => T;

  constructor(settled: Promise<void>) {
    super();
    let enter!: <T>(callback: () => T) => T;
    // Capture before start returns (and before queued admission can move to
    // another contract's callback). Retention keeps host mode checks and the
    // session owner without extending the initiating tool proof. Terminal status alone
    // does not expire the scope: cancellation cleanup must really drain first.
    void withRetainedExecutionMode(() => {
      enter = bindExecutionModeContext();
      return settled;
    }).catch(() => { /* A failed settlement still ends the retained scope. */ });
    this.enter = enter;
  }

  override run<T>(callback: () => T | PromiseLike<T>): Promise<T> {
    return this.enter(() => super.run(callback));
  }
}
