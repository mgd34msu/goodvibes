import {
  createFeedTokenRoutes,
  type IndicatorFocusRouteState as SharedIndicatorState,
  type TextRouteState as SharedTextState,
  type KeyRouteState as SharedKeyState,
  type MouseRouteState as SharedMouseState,
} from '@goodvibes-jev/engine/terminal-shell/feed-token-routes';
import type { CommandContext } from './command-registry.ts';

export type IndicatorFocusRouteState = SharedIndicatorState & { processModal: { open: () => void } };
export type TextRouteState = SharedTextState<CommandContext>;
export type KeyRouteState = SharedKeyState<CommandContext> & { processModal: { open: () => void } };
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
    state.modalOpened('process');
    state.processModal.open();
  },
  openKeyIndicator(state) {
    state.modalOpened('process');
    state.processModal.open();
  },
  armCommandWithoutRegistry: false,
  recoverDesyncedCommands: false,
  scheduleCommandArguments: () => undefined,
  mouseRowOffset: 1,
  clipMouseToTranscript: false,
  requireBlockForCollapse: false,
});
