import { logger } from '@goodvibes/engine/platform/platform/utils';

/**
 * Builds the process-level unhandledRejection handler for the shell.
 *
 * Extracted from main() so the entrypoint stays under the architecture
 * line-count cap. Behavior is unchanged: isolated rejections surface as a
 * single "[Error]" line, while more than three within a rolling 10s window
 * escalate to a "[Critical]" restart suggestion so a cascading failure is
 * named instead of scrolling by as noise.
 */
export function createUnhandledRejectionHandler(deps: {
  readonly notifyHigh: (message: string) => void;
  readonly render: () => void;
  /** Injectable clock, so the rolling window can be driven without waiting. */
  readonly now?: () => number;
}): (reason: unknown) => void {
  const clock = deps.now ?? Date.now;
  let rejectionCount = 0;
  let windowStart = clock();
  return (reason: unknown): void => {
    const now = clock();
    if (now - windowStart > 10000) {
      rejectionCount = 0;
      windowStart = now;
    }
    rejectionCount++;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (rejectionCount > 3) {
      logger.error('CRITICAL: cascading unhandled rejections, consider restarting', {
        count: rejectionCount,
        windowMs: now - windowStart,
        error: String(reason),
      });
      deps.notifyHigh(
        `[Critical] Multiple errors detected (${rejectionCount} in 10s). If the issue persists, please restart. Latest: ${msg}`
      );
    } else {
      deps.notifyHigh(`[Error] ${msg}`);
      logger.error('unhandledRejection', { error: String(reason) });
    }
    deps.render();
  };
}
