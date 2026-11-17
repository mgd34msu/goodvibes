import { createOrderedShutdown, drainShutdownRegistry } from '@goodvibes-jev/engine/terminal-shell/ordered-shutdown';
/** Ordered teardown owned by bootstrap; the shell owns the exit deadline. */
import { shutdownRuntime } from '@/runtime/index.ts';

type Cleanup = () => unknown;

export interface BootstrapShutdownDeps {
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly conversationTitle: () => string;
  readonly bootstrapUnsubs: Cleanup[];
  readonly runtimeUnsubs: Cleanup[];
  readonly forensicsCollector: { dispose(): unknown };
  readonly sessionSpine: { close(sessionId: string): unknown; dispose(): unknown };
  readonly sessionInboundInputs: { dispose(): unknown };
  readonly sessionUnionCache: { dispose(): unknown };
  readonly leaveHostedSession: Cleanup;
  readonly deferredStartup: { drain(timeoutMs: number): Promise<unknown> };
  /** Wait for the admitted start and publish its handle before stopping it. */
  readonly settleExternalServices: Cleanup;
  readonly stopExternalServices: Cleanup;
  /** Final graph drain, after the save and every other release. */
  readonly closeRuntimeGraph: () => Promise<void>;
  readonly scheduleManager: Parameters<typeof shutdownRuntime>[5];
  readonly hookDispatcher: Parameters<typeof shutdownRuntime>[6];
  readonly providerRegistry: Parameters<typeof shutdownRuntime>[7];
  readonly sessionOrchestration: Parameters<typeof shutdownRuntime>[8];
  readonly persistenceOptions: Parameters<typeof shutdownRuntime>[9];
}

/**
 * Thrown by the shutdown handler when the session WAS saved durably and only
 * releasing other owned resources failed. The shell keeps this apart from a
 * failed save: recovery state is for a session that was not saved.
 */
export class ShutdownReleaseError extends AggregateError {
  constructor(errors: readonly unknown[], message: string) {
    super(errors, message);
    this.name = 'ShutdownReleaseError';
  }
}

/** The handler returned as bootstrapRuntime's public ctx.shutdown, plus whether its save has landed. */
export type BootstrapShutdown = ((sessionData: Parameters<typeof shutdownRuntime>[1]) => Promise<void>) & {
  /** True once the session is durably saved, even while releases are still running. */
  readonly sessionSaved: () => boolean;
};

/**
 * The same handler returned as bootstrapRuntime's public ctx.shutdown.
 *
 * The session is saved FIRST: it is one local write that needs nothing the
 * releases free, and the releases include network waits (the daemon spine, a
 * hosted-session detach, daemon discovery). Saving after them let a slow daemon
 * spend the exit deadline and cost the save.
 */
export function createBootstrapShutdown(deps: BootstrapShutdownDeps): BootstrapShutdown {
  // Publish ownership before callbacks run. Direct callers and the shell share
  // one completion; callbacks must not await this shutdown (even indirectly).
  let durablySaved = false;
  const shutdown = createOrderedShutdown<Parameters<typeof shutdownRuntime>[1]>(async (sessionData, attempt) => {
    let title = '';
    await attempt(() => {
      title = deps.conversationTitle();
    });
    // Keep its failure visible, so the shell cannot discard recovery on error.
    await attempt(async () => {
      await shutdownRuntime(
        deps.runtime.sessionId,
        sessionData,
        deps.runtime.model,
        deps.runtime.provider,
        title,
        deps.scheduleManager,
        deps.hookDispatcher,
        deps.providerRegistry,
        deps.sessionOrchestration,
        deps.persistenceOptions,
        // The save is durable before the session hooks are waited for; a slow
        // hook that meets the exit deadline must not read as a failed save.
        () => { durablySaved = true; },
      );
    });
    // Take each registry before invoking its callbacks. Failed owners cannot
    // retain subscriptions or prevent their siblings from being released.
    await drainShutdownRegistry(deps.bootstrapUnsubs, attempt);
    await drainShutdownRegistry(deps.runtimeUnsubs, attempt);
    await attempt(() => deps.forensicsCollector.dispose());
    await attempt(() => deps.sessionSpine.close(deps.runtime.sessionId));
    await attempt(() => deps.sessionSpine.dispose());
    await attempt(() => deps.sessionInboundInputs.dispose());
    await attempt(() => deps.sessionUnionCache.dispose());
    // These two owners already drain concurrently. Start both even if one
    // throws synchronously, and await both before touching external services.
    await Promise.all([attempt(deps.leaveHostedSession), attempt(() => deps.deferredStartup.drain(100))]);
    // Preserve the startup owner's authority: a pending admitted start must
    // publish its handle before stop. A failed start still permits stopping
    // the existing handle. The shell's deadline bounds a hang.
    await attempt(deps.settleExternalServices);
    await attempt(deps.stopExternalServices);
    await attempt(deps.closeRuntimeGraph);
  }, 'TUI shutdown failed to release one or more owned resources', (errors, message) => {
    // A failed save stays the plain failure the shell treats as "not saved".
    if (!durablySaved) return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
    return new ShutdownReleaseError(errors, 'TUI shutdown saved the session but failed to release one or more owned resources');
  });
  return Object.assign(shutdown, { sessionSaved: () => durablySaved });
}
