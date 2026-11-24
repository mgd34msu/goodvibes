import { askPresentationFor, type TerminalAskContext } from '@goodvibes/engine/terminal-shell/permission-prompt-facts';
import { renderAskCard, type AskCardState } from '@goodvibes/engine/terminal-shell/renderer/ask-card';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';

import type {
  PermissionPromptRequest,
  PermissionPromptDecision,
  PermissionRequestHandler,
  PermissionRequest,
} from '@goodvibes/engine/platform/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/**
 * PermissionPromptUI, the Agent's approval card: the shared card
 * (terminal-shell renderer/ask-card.ts) drawn from the ask's own words, the
 * same card, buttons and keys as the terminal app's. Its keys are terminal-shell
 * ask-card-input.ts, through shell/blocking-input.ts: `y` yes, `a` don't ask
 * again (when the ask can be remembered), `n` no, `d` details, typing a
 * reason to refuse; Enter presses the selected button, which opens on the
 * yes, or on `No` for what cannot be undone or weakens a protection.
 */
export class PermissionPromptUI {
  /** The approval card as a modal layer, stamped over the dimmed screen above every other modal. */
  static createPromptLayer(
    screenWidth: number,
    screenHeight: number,
    request: PermissionRequest & AskCardState,
    view: { readonly awaitingTab?: boolean | undefined; readonly queueCount?: number | undefined; readonly context: TerminalAskContext },
  ): SurfaceLayer {
    const state: AskCardState = { ...request, awaitingTab: view.awaitingTab, queueCount: view.queueCount };
    return renderAskCard(askPresentationFor(request, view.context), request, state, screenWidth, screenHeight);
  }
}
