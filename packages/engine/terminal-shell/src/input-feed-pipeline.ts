/** Own input dispatch order and the one route write-back rule, with typed product route ports. */
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { InfiniteBuffer } from './conversation-history.js';
import type { FeedContextMutableInit } from './input-feed-context.js';
import { handleSessionViewToken, type SessionViewControls } from './session-view-input.js';
import type { SurfaceModalHost } from './surface-modal-host.js';
import { routeConcealedToken } from './concealed-input-route.js';
import type { ConcealedInputRequest } from './concealed-input.js';
import { keyTokenFromText, type NavigationTranslation } from './keybindings.js';

type KeyToken = InputToken & { type: 'key' };
type MouseToken = InputToken & { type: 'mouse' };
export interface FeedPipelineContext extends FeedContextMutableInit {
  readonly focusTracker: { setFocused(focused: boolean): void };
  readonly keybindingsManager: {
    matches(action: 'clear-cancel', token: KeyToken): boolean;
    lookup?(token: KeyToken): string | null | undefined;
    /** The action the key after the leader completes (keybindings.ts). */
    lookupAfterLeader?(token: { readonly logicalName?: string | undefined; readonly ctrl?: boolean | undefined; readonly shift?: boolean | undefined; readonly meta?: boolean | undefined }): string | null | undefined;
    /** The navigation keys read through the table (keybindings.ts). */
    translateNavigation?(token: KeyToken): NavigationTranslation<KeyToken> | { readonly kind: 'drop' };
  };
  readonly surfaceModals?: (Pick<SurfaceModalHost, 'kitModalOnTop' | 'handleToken'> & Partial<Pick<SurfaceModalHost, 'top'>>) | undefined;
  readonly getSessionView: () => SessionViewControls | null;
  /** True while the composer collects a concealed value; command dispatch must not see that text. */
  readonly isConcealedInput?: (() => boolean) | undefined;
  /** The open concealed request: while there is one, concealed-input-route.ts takes every key and text token. */
  readonly concealedRequest?: (() => ConcealedInputRequest | null) | undefined;
  /** Delivers a concealed value to its request. */
  readonly submitConcealedInput?: ((value: string) => boolean) | undefined;
  /** The clipboard's text, for the paste key inside a concealed prompt. */
  readonly readClipboardText?: (() => string | null) | undefined;
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
  | 'prompt'
  | 'cursorPos'
  | 'nextImageId'
>;
type MutableKey = keyof FeedContextMutableInit;
const PROMPT_KEYS = ['prompt', 'cursorPos', 'commandMode'] as const satisfies readonly MutableKey[];
const MODAL_RESULT_KEYS = ['selectionCallback', 'prompt', 'cursorPos', 'nextImageId'] as const satisfies readonly MutableKey[];
const INDICATOR_KEYS = ['indicatorFocused'] as const satisfies readonly MutableKey[];
const COMMAND_KEYS = ['prompt', 'cursorPos', 'commandMode', 'nextPasteId', 'nextImageId'] as const satisfies readonly MutableKey[];
const KEY_KEYS = ['prompt', 'cursorPos', 'inputScrollTop', 'commandMode', 'indicatorFocused'] as const satisfies readonly MutableKey[];
const MOUSE_KEYS = ['mouseDownRow', 'mouseDownCol'] as const satisfies readonly MutableKey[];

function snapshot<Key extends MutableKey>(context: FeedContextMutableInit, keys: readonly Key[]): Pick<FeedContextMutableInit, Key> {
  const values = {} as Pick<FeedContextMutableInit, Key>;
  for (const key of keys) values[key] = context[key];
  return values;
}
/** Write a route's result into the owner field by field, only where the route
 * changed the value it was handed; returns whether the route handled the token. */
function adopt<Key extends MutableKey>(
  context: FeedContextMutableInit,
  before: Pick<FeedContextMutableInit, Key>,
  result: Pick<FeedContextMutableInit, Key> & { readonly handled: boolean },
  keys: readonly Key[],
): boolean {
  const after: Pick<FeedContextMutableInit, Key> = result;
  for (const key of keys) {
    if (!Object.is(after[key], before[key])) context[key] = after[key];
  }
  return result.handled;
}
export interface FeedPipelinePorts<Context extends FeedPipelineContext> {
  readonly pairing?: ((context: Context, token: InputToken) => boolean) | undefined;
  readonly surfaceModalTokens: 'all' | 'text-key';
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
  /**
   * The leader sequence (leader-key.ts): `canArm` says whether the leader is
   * read here now (the terminal app's config screens read their own), `run`
   * does the action a completed sequence names, as its own key would.
   */
  readonly leader?: {
    readonly state: (context: Context) => { readonly armed: boolean; arm(screen?: readonly (readonly [key: string, action: string])[]): void; disarm(): void } | undefined;
    readonly canArm: (context: Context) => boolean;
    readonly run: (context: Context, action: string, env: FeedEnvironment) => PromptResult;
    /**
     * The screen on top takes the key after the leader when it has an action
     * on it (a config screen's letter); true when it did. Asked before the table.
     */
    readonly screenFollow?: ((context: Context, follow: { readonly logicalName?: string | undefined; readonly shift?: boolean | undefined }) => boolean) | undefined;
    /** The keys `screenFollow` takes now (key as the strip shows it, then what it does), listed first on the strip. */
    readonly screenKeys?: ((context: Context) => readonly (readonly [key: string, action: string])[]) | undefined;
  } | undefined;
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
    const dispatch = (incoming: InputToken): void => {
      if (incoming.type === 'focus') {
        context.focusTracker.setFocused(incoming.action === 'in');
        return;
      }
      let token = incoming;
      // A modal choosing a key to keep (the Keys place) gets the key exactly as pressed.
      const top = context.surfaceModals?.kitModalOnTop ? context.surfaceModals.top?.() : undefined;
      const capturing = (top as { readonly takesEveryKey?: boolean } | undefined)?.takesEveryKey === true;
      // Every key is read through the table first: a key bound to Tab, Enter,
      // Esc or an arrow is that key to every route below; one of those keys
      // bound to another action stands for that action (keybindings.ts).
      if (!capturing && token.type === 'key' && context.keybindingsManager.translateNavigation) {
        const read = context.keybindingsManager.translateNavigation(token);
        if (read.kind === 'drop') return;
        if (read.kind === 'rewrite') token = read.token;
      }
      if (ports.pairing?.(context, token)) return;
      // The leader: armed, the next key completes the sequence or cancels it;
      // not armed, the leader's own key arms it. A concealed value never sees it.
      const leader = ports.leader?.state(context);
      if (leader && ports.leader && !context.concealedRequest?.()) {
        if (leader.armed) {
          const follow = token.type === 'key' ? token : token.type === 'text' ? keyTokenFromText(token.value) : undefined;
          if (follow) {
            leader.disarm();
            if (follow.logicalName !== 'escape' && ports.leader.screenFollow?.(context, follow)) {
              context.requestRender();
              return;
            }
            const action = follow.logicalName === 'escape' ? null : context.keybindingsManager.lookupAfterLeader?.(follow) ?? null;
            if (action && adopt(context, snapshot(context, PROMPT_KEYS), ports.leader.run(context, action, env), PROMPT_KEYS)) ports.afterShortcut?.(context);
            context.requestRender();
            return;
          }
        } else if (token.type === 'key' && context.keybindingsManager.lookup?.(token) === 'leader' && ports.leader.canArm(context)) {
          leader.arm(ports.leader.screenKeys?.(context) ?? []);
          context.requestRender();
          return;
        }
      }
      // A concealed value is typed in its own state: no shortcut, undo, kill
      // ring, history search or command sees it, and Ctrl+C cancels it
      // (concealed-input-route.ts). A kit modal opened on top keeps its tokens.
      if (!context.surfaceModals?.kitModalOnTop && routeConcealedToken(context, token)) return;
      if (token.type === 'key' && context.keybindingsManager.matches('clear-cancel', token)) {
        context.handleCtrlC();
        return;
      }
      // A kit modal on top of the modal stack takes the token itself; a tracked
      // modal on top takes it through its route in ports.modal.
      if (context.surfaceModals?.kitModalOnTop && (ports.surfaceModalTokens === 'all' || token.type === 'key' || token.type === 'text')) {
        if (token.type === 'key' && token.logicalName === 'escape') context.handleEscape();
        else context.surfaceModals.handleToken(token);
        context.requestRender();
        return;
      }
      // A route works on a snapshot of the composer; a closure it calls may edit
      // the owner (the handler) directly. One rule for every route: a field is
      // written back only when the route itself changed it.
      const modal = adopt(context, snapshot(context, MODAL_RESULT_KEYS), ports.modal(context, token, env), MODAL_RESULT_KEYS);
      if (modal) return;

      const sessionView = context.getSessionView();
      const expandPastes = ports.expandPastes;
      const viewState = {
        controls: sessionView,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        saveUndoState: context.saveUndoState,
        requestRender: context.requestRender,
        ...(context.keybindingsManager.lookup ? { lookup: (key: KeyToken) => context.keybindingsManager.lookup?.(key) } : {}),
        ...(expandPastes ? { expandPastes: (text: string) => expandPastes(context, text) } : {}),
      };
      const viewBefore = snapshot(context, PROMPT_KEYS);
      if (handleSessionViewToken(viewState, token)) {
        adopt(context, viewBefore, { ...viewState, handled: true }, ['prompt', 'cursorPos']);
        return;
      }
      if (!sessionView?.active && ports.workTree(context, token, env)) return;
      if (token.type === 'key') {
        if (adopt(context, snapshot(context, PROMPT_KEYS), ports.shortcut(context, token, env), PROMPT_KEYS)) {
          ports.afterShortcut?.(context);
          return;
        }
      }
      if (ports.beforeComposer?.(context, token, env)) return;
      if (adopt(context, snapshot(context, INDICATOR_KEYS), ports.indicator(context, token, env), INDICATOR_KEYS)) return;
      if (adopt(context, snapshot(context, PROMPT_KEYS), ports.text(context, token, env), PROMPT_KEYS)) return;
      if (token.type === 'key') {
        // A concealed value is never a slash command, even when it starts with '/'.
        if (!context.isConcealedInput?.()) {
          if (adopt(context, snapshot(context, COMMAND_KEYS), ports.command(context, token, env), COMMAND_KEYS)) return;
        }
        adopt(context, snapshot(context, KEY_KEYS), ports.key(context, token, env), KEY_KEYS);
      } else if (token.type === 'mouse') {
        adopt(context, snapshot(context, MOUSE_KEYS), ports.mouse(context, token, env), MOUSE_KEYS);
      }
    };
    for (const token of tokens) dispatch(token);
    context.requestRender();
  };
}
