import { drainOwned } from '../drain-owned.ts';
import { JudgmentError } from './errors.ts';

/** A synchronous attempt or retention guard cannot authorize through returned work. */
export function assertSynchronousJudgmentGuard(check?: () => unknown, role: 'attempt' | 'retention' = 'attempt'): void {
  let checked: unknown;
  try { checked = check?.(); }
  catch (error) { drainOwned(error); throw error; }
  if (checked !== undefined) {
    drainOwned(checked);
    throw role === 'retention'
      ? new JudgmentError('rejected', 'the judgment request was rejected')
      : new JudgmentError('invalid-request', 'the judgment attempt guard must be synchronous and complete without a return value');
  }
}
