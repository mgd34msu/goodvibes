import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/**
 * Counts a composed prompt's injected memories without letting a failure to
 * persist the counters reach the turn: usage counting is telemetry, the prompt
 * is the product. Returns whether the count was recorded.
 */
export function recordComposedPromptUsage(onComposed: () => void): boolean {
  try {
    onComposed();
    return true;
  } catch (error) {
    logger.warn('memory usage counters were not updated for this prompt', { error: summarizeError(error) });
    return false;
  }
}
