import { SessionViews as PlatformSessionViews, type SessionViewsDeps } from '@goodvibes-jev/engine/terminal-shell/session-views';
import { MessageLineCache } from '../core/conversation-line-cache.ts';
import { renderAgentView } from '../core/agent-view-render.ts';
import { renderHeaderLine } from '../renderer/header-line.ts';
export type { SessionViewsDeps, SessionViewFrame } from '@goodvibes-jev/engine/terminal-shell/session-views';
export class SessionViews extends PlatformSessionViews {
  constructor(deps: SessionViewsDeps) {
    super(deps, {
      renderHeader: (width, model, title, version, view) => renderHeaderLine(width, model, title, undefined, version, undefined, view), renderAgentView,
      createLineCache: () => new MessageLineCache(),
      preferSourceMessages: true, preferRunnerContract: false,
    });
  }
}
