import { types as nodeTypes } from 'node:util';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { logger } from '../utils/logger.js';

function warn(message: string): void {
  // Reporting a failed notification cannot turn its acknowledged publication
  // into a failed import either. Never include callback values or errors.
  try { logger.warn(message); } catch (error) { drainOwned(error); }
}
/** Synchronous notification of an already acknowledged durable commit. This is
 * never an admission check or a rollback boundary. Observer failures cannot
 * invalidate the committed rows/receipt, and async work is observed without
 * making completion depend on an unbounded observer. Ordinary return values
 * (for example Array.push's count) have no bearing on publication. */
export function notifyKnowledgeCommitted(notification: (() => void) | undefined): void {
  let result: unknown;
  try { result = notification?.(); }
  catch (error) {
    drainOwned(error);
    warn('Knowledge import committed; its completion notification failed.');
    return;
  }
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
    drainOwned(result);
    if (nodeTypes.isPromise(result)) warn('Knowledge import committed; asynchronous completion notification work was observed separately.');
  }
}
