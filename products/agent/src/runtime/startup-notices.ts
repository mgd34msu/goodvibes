import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

interface NoticeRouter {
  high(message: string): void;
}

export interface StartupNotices {
  /** Shows the message now when the router exists, otherwise holds it for `flush()`. */
  report(message: string): void;
  /** Delivers everything held; a no-op until the router exists. */
  flush(): void;
  /**
   * Runs a startup task whose rejection would otherwise surface only in the
   * unhandled-rejection log, and reports it once as a visible message.
   */
  guard(description: string, task: () => Promise<unknown>): void;
}

/**
 * Boot-time faults that happen before the conversation can show anything: the
 * message router is built later, so a failure is held and shown the moment it exists.
 */
export function createStartupNotices(getRouter: () => NoticeRouter | null): StartupNotices {
  const pending: string[] = [];
  const flush = (): void => {
    const router = getRouter();
    if (!router) return;
    for (const message of pending.splice(0)) router.high(message);
  };
  const report = (message: string): void => {
    pending.push(message);
    flush();
  };
  return {
    report,
    flush,
    guard(description, task) {
      void (async () => {
        try {
          await task();
        } catch (error) {
          logger.error(`startup task failed: ${description}`, { error: summarizeError(error) });
          report(`[Startup] ${description}: ${summarizeError(error)}`);
        }
      })();
    },
  };
}
