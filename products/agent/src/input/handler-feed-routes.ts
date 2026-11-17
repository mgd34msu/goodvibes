import {
  createFeedTokenRoutes,
  type IndicatorFocusRouteState as SharedIndicatorState,
  type TextRouteState as SharedTextState,
  type KeyRouteState as SharedKeyState,
  type MouseRouteState as SharedMouseState,
} from '@goodvibes-jev/engine/terminal-shell/feed-token-routes';
import type { CommandContext } from './command-registry.ts';

/**
 * The process monitor opened from the footer indicator goes on the modal stack
 * at once (syncModals), while the indicator still has focus, so Esc on the
 * monitor returns focus to the indicator.
 */
export type IndicatorFocusRouteState = SharedIndicatorState & { processModal: { open: () => void }; syncModals: () => void };
export type TextRouteState = SharedTextState<CommandContext>;
export type KeyRouteState = SharedKeyState<CommandContext> & { processModal: { open: () => void }; syncModals: () => void };
export type MouseRouteState = SharedMouseState<string>;
export const { handleIndicatorFocusToken, handlePromptTextToken, handlePromptKeyToken, handleMouseToken } = createFeedTokenRoutes<
  CommandContext,
  IndicatorFocusRouteState,
  TextRouteState,
  KeyRouteState,
  string,
  MouseRouteState
>({
  openIndicator(state) {
    state.processModal.open();
    state.syncModals();
  },
  openKeyIndicator(state) {
    state.processModal.open();
    state.syncModals();
  },
  // InputTokenizer already reports zero-based rows.
  mouseRowOffset: 0,
});
