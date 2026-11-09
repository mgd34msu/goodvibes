import type { SessionMeta } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import { HelperModel, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import {
  formatReturnContextForDisplay,
  getReturnContextMode,
  maybeAssistReturnContextSummary,
  type SessionReturnContextSummary,
} from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { activeTokens } from './renderer/theme.js';
interface ResumePublicationOptions {
  readonly runtime: { readonly sessionId: string };
  readonly conversation: { readonly title: string; log(message: string, options: { fg: string }): void };
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'require' | 'resolveModelPricing'>;
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
    readonly reopen: () => void;
    readonly reentry: (summary: SessionReturnContextSummary) => string[];
    readonly hookError: string;
  },
): void {
  options.onSessionIdChanged?.(sessionId);
  options.writeLastSessionPointer(sessionId);
  void options.sharedSessionBroker.reopenSession(sessionId).catch((err) => {
    logger.debug('session broker reopen session failed', { err });
  });
  policy.reopen();
  options.conversation.log(`Resumed session: ${sessionId}`, { fg: activeTokens().secondary });
  const returnContextMode = getReturnContextMode(options.configManager);
  if (returnContextMode !== 'off' && meta.returnContext) {
    for (const line of formatReturnContextForDisplay(meta.returnContext))
      options.conversation.log(`Resume: ${line}`, { fg: activeTokens().textMuted });
    for (const line of policy.reentry(meta.returnContext)) options.conversation.log(line, { fg: activeTokens().textMuted });
    if (returnContextMode === 'assisted') {
      const helperModel = new HelperModel({ configManager: options.configManager, providerRegistry: options.providerRegistry });
      void maybeAssistReturnContextSummary(options.configManager, helperModel, meta.returnContext)
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
    .catch((error: unknown) => logger.debug(policy.hookError, { path: 'Lifecycle:session:load', error: summarizeError(error) }));
}
