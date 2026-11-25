import {
  createFeedTokenRoutes,
  type IndicatorFocusRouteState as SharedIndicatorState,
  type TextRouteState as SharedTextState,
  type KeyRouteState as SharedKeyState,
  type MouseRouteState as SharedMouseState,
} from '@goodvibes/engine/terminal-shell/feed-token-routes';
import type { CommandContext } from './command-registry.ts';
import type { FooterTarget } from '../renderer/footer-targets.ts';

/**
 * The process monitor opened from the footer indicator goes on the modal stack
 * at once (syncModals), while the indicator still has focus, so Esc on the
 * monitor returns focus to the indicator.
 */
export type IndicatorFocusRouteState = SharedIndicatorState & { openAgentsView: () => void; syncModals: () => void };
export type TextRouteState = SharedTextState<CommandContext>;
export type KeyRouteState = SharedKeyState<CommandContext> & { openAgentsView: () => void; syncModals: () => void };
export type MouseRouteState = SharedMouseState<FooterTarget>;
export const { handleIndicatorFocusToken, handlePromptTextToken, handlePromptKeyToken, handleMouseToken } = createFeedTokenRoutes<
  CommandContext,
  IndicatorFocusRouteState,
  TextRouteState,
  KeyRouteState,
  FooterTarget,
  MouseRouteState
>({
  // The running indicator opens Your agents, as in the terminal app (F2 is the
  // key table's open-agents); a background process opens in the process monitor from there.
  openIndicator(state) {
    state.openAgentsView();
    state.syncModals();
  },
  // InputTokenizer already reports zero-based rows.
  mouseRowOffset: 0,
});
