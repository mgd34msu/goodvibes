import { drainOwned } from '../drain-owned.ts';
import { JudgmentError } from './errors.ts';

/**
 * Run a currentness check that must be synchronous and return nothing. A
 * returned value (a promise from an async check) is drained and refused, so a
 * check cannot authorise through work it has not finished. This is the one
 * place that rule is written: callers pick only the refusal they throw, either
 * a judgment role or their own error.
 */
export function assertSynchronousJudgmentGuard(check?: () => unknown, role: 'attempt' | 'retention' | (() => Error) = 'attempt'): void {
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
