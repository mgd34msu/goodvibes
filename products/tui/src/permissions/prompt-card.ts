/**
 * prompt-card.ts, the terminal app's approval card: the shared card
 * (terminal-shell renderer/ask-card.ts) drawn from the ask's own words
 * (permissions/ask-presentation.ts, through terminal-shell
 * permission-prompt-facts.ts). The layout, the buttons and the keys are the
 * shared ones, the same in the Agent; this file keeps only the wiring.
 */
import type { PermissionPromptRequest } from '@goodvibes/engine/platform/platform/permissions';
import { askPresentationFor, type TerminalAskContext } from '@goodvibes/engine/terminal-shell/permission-prompt-facts';
import { renderAskCard, type AskCardState } from '@goodvibes/engine/terminal-shell/renderer/ask-card';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';

export type PermissionCardState = AskCardState;

/** The approval card as a modal layer. */
export function renderPermissionCard(
  request: PermissionPromptRequest,
  state: PermissionCardState,
  screenWidth: number,
  screenHeight: number,
  context: TerminalAskContext,
): SurfaceLayer {
  return renderAskCard(askPresentationFor(request, context), request, state, screenWidth, screenHeight);
}
