/** Own input dispatch order and snapshot write-back once, with typed product route ports. */
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { InfiniteBuffer } from './conversation-history.js';
import type { FeedContextMutableInit } from './input-feed-context.js';
import { handleSessionViewToken, type SessionViewControls } from './session-view-input.js';
import type { SurfaceModalHost } from './surface-modal-host.js';

type KeyToken = InputToken & { type: 'key' };
type MouseToken = InputToken & { type: 'mouse' };
export interface FeedPipelineContext extends FeedContextMutableInit {
  readonly focusTracker: { setFocused(focused: boolean): void };
  readonly keybindingsManager: { matches(action: 'clear-cancel', token: KeyToken): boolean };
  readonly surfaceModals?: Pick<SurfaceModalHost, 'active' | 'handleToken'> | undefined;
  readonly getSessionView: () => SessionViewControls | null;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly handleCtrlC: () => void;
  readonly handleEscape: () => void;
  readonly saveUndoState: () => void;
  requestRender: () => void;
}
export interface FeedEnvironment {
  readonly history: InfiniteBuffer;
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly lineCount: number;
  /** One timestamp per drain; tokens in a paste arrive together. */
  readonly now: number;
}
type Handled<Fields extends keyof FeedContextMutableInit> = Pick<FeedContextMutableInit, Fields> & { readonly handled: boolean };
type PromptResult = Handled<'prompt' | 'cursorPos' | 'commandMode'>;
type ModalResult = Handled<
  | 'selectionCallback'
  | 'helpOverlayActive'
  | 'helpScrollOffset'
  | 'shortcutsOverlayActive'
  | 'shortcutsScrollOffset'
  | 'prompt'
  | 'cursorPos'
  | 'nextImageId'
>;
export interface FeedPipelinePorts<Context extends FeedPipelineContext> {
  readonly pairing?: ((context: Context, token: InputToken) => boolean) | undefined;
  readonly surfaceModalTokens: 'all' | 'text-key';
  readonly guardModalWrites: boolean;
  readonly modal: (context: Context, token: InputToken, env: FeedEnvironment) => ModalResult;
  readonly workTree: (context: Context, token: InputToken, env: FeedEnvironment) => boolean;
  readonly shortcut: (context: Context, token: KeyToken, env: FeedEnvironment) => PromptResult;
  readonly afterShortcut?: ((context: Context) => void) | undefined;
  readonly beforeComposer?: ((context: Context, token: InputToken, env: FeedEnvironment) => boolean) | undefined;
  readonly indicator: (context: Context, token: InputToken, env: FeedEnvironment) => Handled<'indicatorFocused'>;
  readonly text: (context: Context, token: InputToken, env: FeedEnvironment) => PromptResult;
  readonly command: (
    context: Context,
    token: KeyToken,
    env: FeedEnvironment,
  ) => Handled<'prompt' | 'cursorPos' | 'commandMode' | 'nextPasteId' | 'nextImageId'>;
  readonly key: (
    context: Context,
    token: KeyToken,
    env: FeedEnvironment,
  ) => Handled<'prompt' | 'cursorPos' | 'inputScrollTop' | 'commandMode' | 'indicatorFocused'>;
  readonly mouse: (context: Context, token: MouseToken, env: FeedEnvironment) => Handled<'mouseDownRow' | 'mouseDownCol'>;
  readonly expandPastes?: ((context: Context, text: string) => string) | undefined;
}
/** Product ports cannot reorder focus, cancellation, modal admission, views or composer dispatch. */
export function createFeedInputTokens<Context extends FeedPipelineContext>(ports: FeedPipelinePorts<Context>) {
  return (context: Context, tokens: readonly InputToken[]): void => {
    const history = context.getHistory();
    const env: FeedEnvironment = {
      history,
      viewportHeight: context.getViewportHeight(),
      scrollTop: context.getScrollTop(),
      lineCount: history.getLineCount(),
      now: Date.now(),
    };
    for (const token of tokens) {
      if (token.type === 'focus') {
        context.focusTracker.setFocused(token.action === 'in');
        continue;
      }
      if (ports.pairing?.(context, token)) continue;
      if (token.type === 'key' && context.keybindingsManager.matches('clear-cancel', token)) {
        context.handleCtrlC();
        continue;
      }
      if (context.surfaceModals?.active && (ports.surfaceModalTokens === 'all' || token.type === 'key' || token.type === 'text')) {
        if (token.type === 'key' && token.logicalName === 'escape') context.handleEscape();
        else context.surfaceModals.handleToken(token);
        context.requestRender();
        continue;
      }
      // Handler closures can update this same context while a route owns a
      // snapshot. Preserve those updates rather than restoring stale values.
      const before = {
        helpOverlayActive: context.helpOverlayActive,
        helpScrollOffset: context.helpScrollOffset,
        shortcutsOverlayActive: context.shortcutsOverlayActive,
        shortcutsScrollOffset: context.shortcutsScrollOffset,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
      };
      const modal = ports.modal(context, token, env);
      context.selectionCallback = modal.selectionCallback;
      if (!ports.guardModalWrites || context.helpOverlayActive === before.helpOverlayActive)
        context.helpOverlayActive = modal.helpOverlayActive;
      if (!ports.guardModalWrites || context.helpScrollOffset === before.helpScrollOffset)
        context.helpScrollOffset = modal.helpScrollOffset;
      if (!ports.guardModalWrites || context.shortcutsOverlayActive === before.shortcutsOverlayActive)
        context.shortcutsOverlayActive = modal.shortcutsOverlayActive;
      if (!ports.guardModalWrites || context.shortcutsScrollOffset === before.shortcutsScrollOffset)
        context.shortcutsScrollOffset = modal.shortcutsScrollOffset;
      if (!ports.guardModalWrites || context.prompt === before.prompt) context.prompt = modal.prompt;
      if (!ports.guardModalWrites || context.cursorPos === before.cursorPos) context.cursorPos = modal.cursorPos;
      context.nextImageId = modal.nextImageId;
      if (modal.handled) continue;

      const sessionView = context.getSessionView();
      const expandPastes = ports.expandPastes;
      const viewState = {
        controls: sessionView,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        saveUndoState: context.saveUndoState,
        requestRender: context.requestRender,
        ...(expandPastes ? { expandPastes: (text: string) => expandPastes(context, text) } : {}),
      };
      if (handleSessionViewToken(viewState, token)) {
        context.prompt = viewState.prompt;
        context.cursorPos = viewState.cursorPos;
        continue;
      }
      if (!sessionView?.active && ports.workTree(context, token, env)) continue;
      if (token.type === 'key') {
        const prompt = context.prompt,
          cursorPos = context.cursorPos,
          commandMode = context.commandMode;
        const shortcut = ports.shortcut(context, token, env);
        if (shortcut.handled) {
          if (context.prompt === prompt) context.prompt = shortcut.prompt;
          if (context.cursorPos === cursorPos) context.cursorPos = shortcut.cursorPos;
          if (context.commandMode === commandMode) context.commandMode = shortcut.commandMode;
          ports.afterShortcut?.(context);
          continue;
        }
      }
      if (ports.beforeComposer?.(context, token, env)) continue;
      const indicator = ports.indicator(context, token, env);
      context.indicatorFocused = indicator.indicatorFocused;
      if (indicator.handled) continue;
      const text = ports.text(context, token, env);
      if (text.handled) {
        context.prompt = text.prompt;
        context.cursorPos = text.cursorPos;
        context.commandMode = text.commandMode;
        continue;
      }
      if (token.type === 'key') {
        const command = ports.command(context, token, env);
        if (command.handled) {
          context.commandMode = command.commandMode;
          context.prompt = command.prompt;
          context.cursorPos = command.cursorPos;
          context.nextPasteId = command.nextPasteId;
          context.nextImageId = command.nextImageId;
          continue;
        }
        const key = ports.key(context, token, env);
        if (key.handled) {
          context.prompt = key.prompt;
          context.cursorPos = key.cursorPos;
          context.inputScrollTop = key.inputScrollTop;
          context.commandMode = key.commandMode;
          context.indicatorFocused = key.indicatorFocused;
        }
      } else if (token.type === 'mouse') {
        const mouse = ports.mouse(context, token, env);
        context.mouseDownRow = mouse.mouseDownRow;
        context.mouseDownCol = mouse.mouseDownCol;
      }
    }
    context.requestRender();
  };
}
