import { drainOwned } from '../drain-owned.ts';
import { JudgmentError } from './errors.ts';

/**
 * A currentness check whose type returns a promise does not compile: an
 * `async` arrow written at the call site is refused by the type checker.
 * The run-time test in assertSynchronousJudgmentGuard remains for a check whose type was widened to
 * `() => void` before it got here.
 */
export type SynchronousCheck<F extends () => unknown> = F & (ReturnType<F> extends PromiseLike<unknown> ? never : unknown);

/**
 * Run a currentness check that must be synchronous and return nothing. A
 * returned value (a promise from an async check) is drained and refused, so a
 * check cannot authorise through work it has not finished. This is the one
 * place that rule is written: callers pick only the refusal they throw, either
 * a judgment role or their own error.
 */
export function assertSynchronousJudgmentGuard<F extends () => unknown>(check?: SynchronousCheck<F>, role: 'attempt' | 'retention' | (() => Error) = 'attempt'): void {
  let checked: unknown;
  try { checked = check?.(); }
  catch (error) { drainOwned(error); throw error; }
  if (checked !== undefined) {
    drainOwned(checked);
    throw typeof role === 'function' ? role()
      : role === 'retention'
        ? new JudgmentError('rejected', 'the judgment request was rejected')
        : new JudgmentError('invalid-request', 'the judgment attempt guard must be synchronous and complete without a return value');
  }
}
