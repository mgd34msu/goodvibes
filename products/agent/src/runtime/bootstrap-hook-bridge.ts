import { publishResumedSession } from '@goodvibes-jev/engine/terminal-shell/session-resume-publication';
import type { ConversationManager } from '../core/conversation';
import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import '@/runtime/index.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { emitSessionResumed } from '@/runtime/index.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { SessionSpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { restoreLoadedSession } from '../core/session-resume-core.ts';
import { activeTokens } from '../renderer/theme.ts';

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly isGenerating?: () => boolean;
  readonly restoreTurnAnchors: (sessionId: string) => number;
  readonly surface?: import('@/runtime/index.ts').SessionSurface;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  readonly sessionSpineClient: Pick<SessionSpineClient, 'reopen'>;
  readonly projectRoot: string;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'require' | 'resolveModelPricing'>;
}

export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string) => void {
  return (sessionId: string): void => {
    try {
      if (options.isGenerating?.()) throw new Error('A turn is still running. Wait before resuming a session.');
      const { messages, meta } = options.sessionManager.load(sessionId);
      emitSessionResumed(
        options.runtimeBus,
        {
          sessionId: options.runtime.sessionId,
          traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
          source: 'bootstrap',
        },
        {
          sessionId,
          turnCount: messages.length,
        },
      );
      restoreLoadedSession(sessionId, { messages, meta }, options);
      publishResumedSession(options, sessionId, meta, {
        reopen: () => {
          options.sessionSpineClient.reopen({ sessionId, project: options.projectRoot });
        },
        reentry: (summary) => {
          return (summary.remoteRunners?.length ?? 0) > 0
            ? ['Resume: Remote build-host recovery belongs outside Agent; delegate explicit build/fix/review recovery from Agent.']
            : [];
        },
        hookError: 'Hook route fire error',
      });
    } catch (error) {
      logger.debug('resumeSession failed', { error: summarizeError(error) });
      options.conversation.log('Failed to resume session.', { fg: activeTokens().error });
    }
    options.requestRender();
  };
}
