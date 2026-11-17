import { createOrderedShutdown, drainShutdownRegistry } from '@goodvibes-jev/engine/terminal-shell/ordered-shutdown';
/**
 * bootstrap-shutdown.ts, how a session lets go of everything it took.
 *
 * Teardown lives in one place rather than inline in bootstrapRuntime because
 * the order is load-bearing and easy to disturb by accident. The timers that
 * would fire into a half-torn-down runtime stop first, then the session is
 * saved (a local write, so no slow daemon can cost it), then the session's
 * registration on the spine, subscriptions, the things that own something
 * outside this process (real Chromium processes, external services), and
 * last the runtime graph.
 *
 * Every step is best-effort in the sense that a failure must not strand the
 * ones after it: a session that cannot reach the daemon still has to release
 * its browsers.
 */
import { shutdownRuntime } from '@/runtime/index.ts';
import { shutdownAgentBrowserSessions } from '../tools/agent-browser-tool.ts';

export interface RuntimeShutdownDependencies {
  readonly sessionId: string;
  readonly model: string;
  readonly provider: string;
  readonly conversationTitle: () => string;
  readonly sessionSpineClient: {
    close(sessionId: string): void | Promise<void>;
    dispose(): void | Promise<void>;
  };
  /** Reads and clears the memory-spine reachability recheck timer. */
  readonly takeMemorySpineTimer: () => ReturnType<typeof setInterval> | null;
  readonly bootstrapUnsubs: (() => void | Promise<void>)[];
  readonly runtimeUnsubs: (() => void)[];
  readonly forensicsCollector: { dispose(): void };
  readonly executionLedger: { dispose(): void };
  /**
   * `RuntimeServices.dispose()`, stops every poller the composed graph started.
   * Runs LAST, after every other release.
   */
  readonly disposeRuntimeGraph: () => void | Promise<void>;
  readonly deferredStartup: { drain(ms: number): Promise<unknown> };
  readonly agentExternalServices: { stop(): Promise<unknown> };
  /**
   * The collaborators shutdownRuntime takes after the session's own identity.
   * Named individually rather than spread from a tuple so a change to that
   * signature is a type error here, at the one place that supplies them.
   */
  readonly scheduleManager: Parameters<typeof shutdownRuntime>[5];
  readonly hookDispatcher: Parameters<typeof shutdownRuntime>[6];
  readonly providerRegistry: Parameters<typeof shutdownRuntime>[7];
  readonly sessionOrchestration: Parameters<typeof shutdownRuntime>[8];
  readonly shutdownOptions: Parameters<typeof shutdownRuntime>[9];
}

/** Build the session's `shutdown(sessionData)` handler. */
export function createRuntimeShutdown(
  deps: RuntimeShutdownDependencies,
): (sessionData: Parameters<typeof shutdownRuntime>[1]) => Promise<void> {
  // Latch before invoking any collaborator, including a synchronously reentrant
  // close. Repeated callers share the same completion and failure result.
  // Collaborators must not await this owner's shutdown from inside their own
  // disposal: that is a dependency cycle, including indirectly wrapped waits.
  return createOrderedShutdown<Parameters<typeof shutdownRuntime>[1]>(async (sessionData, attempt) => {
    // Local timers stop first so nothing fires into a half-torn-down runtime.
    await attempt(() => {
      const timer = deps.takeMemorySpineTimer();
      if (timer !== null) clearInterval(timer);
    });
    // Then the save: one local write that needs nothing the releases below free.
    // Those include daemon round trips, and a slow daemon must not delay the save.
    let title = '';
    await attempt(() => {
      title = deps.conversationTitle();
    });
    await attempt(() =>
      shutdownRuntime(
        deps.sessionId,
        sessionData,
        deps.model,
        deps.provider,
        title,
        deps.scheduleManager,
        deps.hookDispatcher,
        deps.providerRegistry,
        deps.sessionOrchestration,
        deps.shutdownOptions,
      ),
    );
    await attempt(() => deps.sessionSpineClient.close(deps.sessionId));
    await attempt(() => deps.sessionSpineClient.dispose());

    // Take subscriptions out of the live arrays before invoking callbacks. One
    // broken unsubscribe must neither retain itself nor strand its siblings.
    await drainShutdownRegistry(deps.bootstrapUnsubs, attempt);
    await drainShutdownRegistry(deps.runtimeUnsubs, attempt);
    await attempt(() => deps.forensicsCollector.dispose());
    await attempt(() => deps.executionLedger.dispose());
    await attempt(() => shutdownAgentBrowserSessions());
    await attempt(() => deps.deferredStartup.drain(100));
    await attempt(() => deps.agentExternalServices.stop());
    // Always last: final flushes and platform shutdown still need the graph.
    await attempt(() => deps.disposeRuntimeGraph());
  }, 'Agent shutdown failed to release one or more owned resources');
}
