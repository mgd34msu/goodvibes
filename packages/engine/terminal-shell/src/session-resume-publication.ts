import type { SessionMeta } from '@goodvibes/engine/platform/platform/sessions';
import type { SharedSessionBroker } from '@goodvibes/engine/platform/platform/control-plane';
import type { HookDispatcher } from '@goodvibes/engine/platform/platform/hooks';
import type { ConfigManager, HelperModel } from '@goodvibes/engine/platform/platform/config';
import {
  formatReturnContextForDisplay,
  getReturnContextMode,
  maybeAssistReturnContextSummary,
  type SessionReturnContextSummary,
} from '@goodvibes/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { activeTokens } from './renderer/theme.js';
interface ResumePublicationOptions {
  readonly runtime: { readonly sessionId: string };
  readonly conversation: { readonly title: string; log(message: string, options: { fg: string }): void };
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  /** The runtime's one helper route; the assisted summary's spend is recorded with every other helper call. */
  readonly helperModel: Pick<HelperModel, 'chat'>;
  readonly onSessionIdChanged?: ((sessionId: string) => void) | undefined;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  readonly hookDispatcher: HookDispatcher;
  readonly requestRender: () => void;
}
/** Publish a completed restore; product adapters keep their resume admission and spine authority. */
export function publishResumedSession(
  options: ResumePublicationOptions,
  sessionId: string,
  meta: SessionMeta,
  policy: {
    /** False when the caller prints its own resume lines; the shared state is published either way. */
    readonly announce?: boolean | undefined;
    readonly reopen: () => void;
    readonly reentry: (summary: SessionReturnContextSummary) => string[];
    readonly hookError: string;
  },
): void {
  // Each step is independent: one that fails must not skip the others, and the
  // person is told which shared state did not follow the resume.
  const warn = (what: string, error: unknown): void => {
    logger.warn(`session resume: ${what}`, { error: summarizeError(error) });
    options.conversation.log(`Resumed, but ${what}: ${summarizeError(error)}`, { fg: activeTokens().warning });
    options.requestRender();
  };
  options.onSessionIdChanged?.(sessionId);
  try {
    options.writeLastSessionPointer(sessionId);
  } catch (error) {
    warn('the last-session pointer was not saved', error);
  }
  try {
    void options.sharedSessionBroker.reopenSession(sessionId).catch((error: unknown) => warn('the shared session was not reopened', error));
  } catch (error) {
    warn('the shared session was not reopened', error);
  }
  try {
    policy.reopen();
  } catch (error) {
    warn('the session state was not reopened', error);
  }
  const announce = policy.announce !== false;
  if (announce) options.conversation.log(`Resumed session: ${sessionId}`, { fg: activeTokens().secondary });
  const returnContextMode = getReturnContextMode(options.configManager);
  if (announce && returnContextMode !== 'off' && meta.returnContext) {
    for (const line of formatReturnContextForDisplay(meta.returnContext))
      options.conversation.log(`Resume: ${line}`, { fg: activeTokens().textMuted });
    for (const line of policy.reentry(meta.returnContext)) options.conversation.log(line, { fg: activeTokens().textMuted });
    if (returnContextMode === 'assisted') {
      void maybeAssistReturnContextSummary(options.configManager, options.helperModel, meta.returnContext)
        .then((assisted) => {
          if (!assisted.assistedNarrative || options.runtime.sessionId !== sessionId) return;
          options.conversation.log(`Resume: ${assisted.assistedNarrative}`, { fg: activeTokens().textMuted });
          options.requestRender();
        })
        .catch((error) => logger.debug('resume summary unavailable', { error: summarizeError(error) }));
    }
  }
  options.hookDispatcher
    .fire({
      path: 'Lifecycle:session:load',
      phase: 'Lifecycle',
      category: 'session',
      specific: 'load',
      sessionId: options.runtime.sessionId,
      timestamp: Date.now(),
      payload: { sessionId },
    })
    .catch((error: unknown) => {
      logger.debug(policy.hookError, { path: 'Lifecycle:session:load', error: summarizeError(error) });
      warn('the session load hook failed', error);
    });
}
