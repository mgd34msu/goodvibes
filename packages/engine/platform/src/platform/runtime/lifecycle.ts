/**
 * Lifecycle management for a GoodVibes runtime host.
 *
 * Handles ordered teardown: persist session, fire lifecycle hooks,
 * stop background managers. Terminal teardown remains in main.ts.
 */
import type { HookDispatcher } from '../hooks/index.js';
import type { HookPhase, HookCategory, HookEventPath } from '../hooks/types.js';
import type { ScheduleManager } from '../tools/workflow/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
export { saveSession } from './session-persistence.js';
import { saveSession, type SessionPersistenceOptions, type SessionSnapshot } from './session-persistence.js';
import type { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import { summarizeError } from '../utils/error-display.js';

// ── Startup lifecycle ────────────────────────────────────────────────────────

/**
 * Fire the session:start lifecycle hook.
 * Hook failures are logged and do not block startup.
 */
export function fireSessionStart(
  sessionId: string,
  hookDispatcher: Pick<HookDispatcher, 'fire'> | null,
): void {
  if (!hookDispatcher) return;
  try {
    hookDispatcher.fire({
      path: 'Lifecycle:session:start' as HookEventPath,
      phase: 'Lifecycle' as HookPhase,
      category: 'session' as HookCategory,
      specific: 'start',
      sessionId,
      timestamp: Date.now(),
      payload: { sessionId },
    }).catch((err: unknown) => {
      logger.warn('fireSessionStart hook failed', { error: summarizeError(err) });
    });
  } catch (err) {
    logger.warn('fireSessionStart hook dispatch failed', { error: summarizeError(err) });
  }
}

// ── Shutdown lifecycle ───────────────────────────────────────────────────────

/**
 * Ordered logical shutdown of all background runtime subsystems.
 *
 * Sequence:
 * 1. Persist conversation to sessions store
 * 2. Fire session:end and session:save lifecycle hooks and wait for them
 * 3. Destroy ScheduleManager (cancels pending scheduled tasks)
 * 4. Stop provider registry file-watcher
 *
 * This function does NOT touch the terminal (alt-screen, raw mode, etc.),
 * that remains the responsibility of main.ts.
 *
 * @param sessionId  - Active session identifier.
 * @param sessionData - Latest conversation to persist.
 * @param model      - Active model identifier.
 * @param provider   - Active provider identifier.
 * @param title      - Conversation title (may be empty string).
 */
export async function shutdownRuntime(
  sessionId: string,
  sessionData: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  scheduleManager?: ScheduleManager | null,
  hookDispatcher?: Pick<HookDispatcher, 'fire'> | null,
  providerRegistry?: Pick<ProviderRegistry, 'stopWatching'> | null,
  sessionOrchestration?: Pick<CrossSessionTaskRegistry, 'dispose'> | null,
  persistenceOptions?: SessionPersistenceOptions,
  /** Called once the session is on disk, before the session hooks are waited for. */
  onSessionSaved?: () => void,
): Promise<void> {
  let shutdownError: Error | null = null;
  try {
    saveSession(sessionId, sessionData, model, provider, title, persistenceOptions);
    onSessionSaved?.();
  } catch (error) {
    const message = summarizeError(error);
    logger.warn('saveSession failed during shutdown', { error: message });
    shutdownError = new Error(`shutdownRuntime failed to persist session: ${message}`, {
      cause: error,
    });
  }

  // The session hooks finish before the runtime is torn down, so a backup or
  // sync hook acting on the saved session runs to its end. Each hook is bounded
  // by its own timeout, and the shell's shutdown deadline bounds the whole step;
  // a hook marked async still runs in the background without being waited on.
  const fireHook = async (specific: string): Promise<void> => {
    if (!hookDispatcher) return;
    try {
      await hookDispatcher.fire({
        path: `Lifecycle:session:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'session' as HookCategory,
        specific,
        sessionId,
        timestamp: Date.now(),
        payload: { sessionId },
      });
    } catch (err) {
      logger.warn('shutdownRuntime lifecycle hook failed', {
        specific,
        error: summarizeError(err),
      });
    }
  };

  await fireHook('end');
  // `save` tells subscribers (backup and sync scripts) the session is on disk,
  // which is false when the write above failed.
  if (!shutdownError) await fireHook('save');

  try {
    scheduleManager?.destroy();
  } catch (err) {
    logger.warn('ScheduleManager.destroy failed during shutdown', {
      error: summarizeError(err),
    });
  }

  try {
    providerRegistry?.stopWatching();
  } catch (err) {
    logger.warn('providerRegistry.stopWatching failed during shutdown', {
      error: summarizeError(err),
    });
  }

  // Dispose the cross-session orchestration registry if it is app-owned in this runtime.
  try {
    sessionOrchestration?.dispose();
  } catch (err) {
    logger.warn('sessionOrchestration.dispose failed during shutdown', {
      error: summarizeError(err),
    });
  }
  if (shutdownError) throw shutdownError;
}
