import {
  createFeedTokenRoutes,
  type IndicatorFocusRouteState as SharedIndicatorState,
  type TextRouteState as SharedTextState,
  type KeyRouteState as SharedKeyState,
  type MouseRouteState as SharedMouseState,
} from '@goodvibes-jev/engine/terminal-shell/feed-token-routes';
import type { CommandContext } from './command-registry.ts';
import { scheduleCommandArguments } from './commands/schedule-arguments.ts';
import type { FooterTarget } from '../renderer/footer-targets.ts';
import type { KillRing } from './kill-ring.ts';
export type IndicatorFocusRouteState = SharedIndicatorState & { openAgentsView: () => void };
export type TextRouteState = SharedTextState<CommandContext> & { killRing: KillRing; saveUndoStateForText: () => void };
export type KeyRouteState = SharedKeyState<CommandContext> & {
  getBlockAnchorLine: () => number;
  openAgentsView: () => void;
  breakUndoCoalesce: () => void;
  killRing: KillRing;
};
export type MouseRouteState = SharedMouseState<FooterTarget>;
export const { handleIndicatorFocusToken, handlePromptTextToken, handlePromptKeyToken, handleMouseToken } = createFeedTokenRoutes<
  CommandContext,
  IndicatorFocusRouteState,
  TextRouteState,
  KeyRouteState,
  FooterTarget,
  MouseRouteState
>({
  openIndicator(state) {
    state.openAgentsView();
  },
  openKeyIndicator(state) {
    state.openAgentsView();
  },
  armCommandWithoutRegistry: true,
  recoverDesyncedCommands: true,
  scheduleCommandArguments: scheduleCommandArguments,
  mouseRowOffset: 0,
  clipMouseToTranscript: true,
  requireBlockForCollapse: true,
});
