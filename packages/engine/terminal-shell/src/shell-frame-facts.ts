import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import { emitUiPanelClose, emitUiPanelFocus, emitUiPanelOpen, emitUiViewChanged } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { captureNativeConversationInput, type ProductInputContext } from './native/native-conversation-input.js';
import type { SessionTarget } from './session-focus.js';
import { isTrackedModal, type StackedModal } from './surface-modal-host.js';
/** Per-frame observations shared by terminal renderers; presentation remains in each shell. */
export function readShellFrameFacts<PromptInfo>(
  processManager: { runningCount(): number },
  input: { readonly prompt: string; getWrappedPromptInfo(width: number): PromptInfo },
  promptWidth: () => number,
  argsHint: (prompt: string) => string | undefined,
) {
  const runningProcessCount = processManager.runningCount();
  const cw = promptWidth();
  return { runningProcessCount, cw, promptInfo: input.getWrappedPromptInfo(cw), commandArgsHint: argsHint(input.prompt) };
}
/** Capture original spoken input before the product's normal transformation and admission path. */
/**
 * The submission ports of a command context: `submitInput` is the composer
 * (its grammar applies), `submitTurn` sends text exactly as given, and speech
 * is sent as said.
 */
export function createShellSubmissionPorts(
  submit: (text: string, content?: ContentPart[], options?: ProductInputContext) => void,
  turn: (text: string, content?: ContentPart[], options?: ProductInputContext) => void,
  stop: () => boolean | void,
  paste: () => { readonly pasted: boolean },
) {
  return {
    submitInput: submit,
    submitTurn: turn,
    submitSpokenInput: (text: string, content?: ContentPart[]): void =>
      turn(text, content, { spokenOutput: true, source: captureNativeConversationInput(text, content) }),
    stopSpokenOutput: stop,
    pasteFromClipboard: paste,
  };
}

/** What the `ui` event stream describes, read from one frame: open panels bottom to top (the last is focused), and the view. */
export interface UiFrame {
  readonly panels: readonly string[];
  /** `main`, `agent:<id>` or `process:<id>`. */
  readonly view: string;
}

/**
 * The panels on screen and the view, from the input handler's modal stack
 * (bottom to top, the last one is the one taking keys) and the session focus.
 */
export function readUiFrame(
  input: { readonly surfaceModals: { modals(): readonly StackedModal[] } },
  view: SessionTarget | null | undefined,
): UiFrame {
  const panels: string[] = [];
  for (const modal of input.surfaceModals.modals()) {
    // A modal waiting under the top one to come back is not on screen.
    if (isTrackedModal(modal) && !modal.isOpen()) continue;
    if (!panels.includes(modal.name)) panels.push(modal.name);
  }
  return { panels, view: !view || view.kind === 'main' ? 'main' : `${view.kind}:${view.id}` };
}

/**
 * Publishes the `ui` domain from the frames a terminal app draws: one call per
 * frame, events only for what changed (UI_PANEL_CLOSE, UI_PANEL_OPEN, then
 * UI_PANEL_FOCUS for a new top panel, then UI_VIEW_CHANGED). An unchanged frame
 * costs a comparison of a few short strings and emits nothing.
 */
export function createUiEventPublisher(
  bus: Parameters<typeof emitUiPanelOpen>[0],
  sessionId: () => string,
): { observe(frame: UiFrame): void } {
  let panels: readonly string[] = [];
  let view = 'main';
  return {
    observe(frame) {
      const same = frame.view === view
        && frame.panels.length === panels.length
        && frame.panels.every((panel, index) => panel === panels[index]);
      if (same) return;
      const id = sessionId();
      const ctx = { sessionId: id, traceId: `${id}:ui`, source: 'terminal' };
      for (const panel of panels) if (!frame.panels.includes(panel)) emitUiPanelClose(bus, ctx, { panelId: panel });
      for (const panel of frame.panels) if (!panels.includes(panel)) emitUiPanelOpen(bus, ctx, { panelId: panel });
      const top = frame.panels[frame.panels.length - 1];
      if (top !== undefined && top !== panels[panels.length - 1]) emitUiPanelFocus(bus, ctx, { panelId: top });
      if (frame.view !== view) emitUiViewChanged(bus, ctx, { from: view, to: frame.view });
      panels = [...frame.panels];
      view = frame.view;
    },
  };
}
