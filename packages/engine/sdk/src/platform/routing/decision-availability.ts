import { JudgmentError } from '@goodvibes-jev/judgment';
import { JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';

/** A transport outage may be wrapped by a tool, but never becomes a request to try more tools. */
export function assertDecisionAvailable(error: unknown): void {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth++) {
    if (current instanceof JudgmentPortMissingError || current instanceof JudgmentError && current.kind === 'unavailable') {
      throw new JudgmentError('unavailable', 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.');
    }
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    const cause = Object.getOwnPropertyDescriptor(current, 'cause');
    if (!cause || !('value' in cause)) return;
    current = cause.value;
  }
}
