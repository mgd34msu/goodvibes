import { loadSkillByTrigger } from '@goodvibes-jev/engine/platform/platform/tools';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { activeTokens } from './renderer/theme.js';
import { commandHistoryLine, type CommandSecretArgs } from './command-registry.js';
export interface CommandRouteContext {
  readonly workspace: {
    readonly shellPaths?:
      | {
          readonly workingDirectory: string;
          readonly homeDirectory: string;
        }
      | undefined;
  };
  readonly executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
  readonly submitInput?: ((input: string) => unknown) | undefined;
}
export interface CommandRouteState<Context extends CommandRouteContext> {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: {
    readonly isActive: boolean;
    reset(): void;
    moveUp(): void;
    moveDown(): void;
    update(query: string): void;
    getSelected():
      | {
          readonly name: string;
        }
      | null
      | undefined;
  } | null;
  /** Executed command lines are recalled with Up and Ctrl+R like sent messages. */
  inputHistory?: { add(text: string): void } | null | undefined;
  commandRegistry: {
    get(name: string): { readonly secretArgs?: CommandSecretArgs | undefined } | undefined;
    executeFromOwner(name: string, args: string[], context: Context, rawInput?: string | undefined): Promise<boolean>;
  } | null;
  commandContext?: Context | undefined;
  conversationManager: {
    dismissSplash(): void;
    log(
      message: string,
      style: {
        readonly fg: string;
      },
    ): unknown;
  } | null;
  readonly requestRender: () => void;
  readonly handleEscape: () => void;
}
const COMMAND_LINE_CURSOR_KEYS: readonly string[] = ['left', 'right', 'home', 'end'];
export function createCommandModeTokenHandler<Context extends CommandRouteContext, State extends CommandRouteState<Context>>(presentation: {
  readonly prepare: (
    context: Context,
    state: State,
    raw: string,
  ) =>
    | {
        readonly name: string;
        readonly args: string[];
        readonly context: Context;
      }
    | undefined;
  readonly unknownCommand: (name: string) => string;
  readonly commandError: (error: unknown, name: string) => string;
}) {
  function handleCommandModeToken(state: State, token: InputToken): boolean {
    if (!state.commandMode) return false;
    const closeCommandMode = (): void => {
      state.commandMode = false;
      state.autocomplete?.reset();
      state.prompt = '';
      state.cursorPos = 0;
    };
    if (token.type !== 'key') return false;
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') {
      state.autocomplete?.moveUp();
      return true;
    }
    if (token.logicalName === 'down') {
      state.autocomplete?.moveDown();
      return true;
    }
    if (token.logicalName === 'tab') {
      const selected = state.autocomplete?.getSelected();
      if (selected) {
        state.prompt = `/${selected.name} `;
        state.cursorPos = state.prompt.length;
        state.autocomplete?.reset();
      }
      return true;
    }
    if (token.logicalName === 'backspace') {
      if (state.cursorPos > 0) {
        state.prompt = state.prompt.slice(0, state.cursorPos - 1) + state.prompt.slice(state.cursorPos);
        state.cursorPos--;
      }
      if (state.prompt === '') {
        closeCommandMode();
        state.autocomplete?.reset();
      } else {
        const query = state.prompt.startsWith('/') ? state.prompt.slice(1) : '';
        const spaceIdx = query.indexOf(' ');
        if (spaceIdx === -1) state.autocomplete?.update(query);
      }
      return true;
    }
    if (token.logicalName === 'enter') {
      const selectedCmd = state.autocomplete?.isActive ? state.autocomplete.getSelected() : undefined;
      const originalCommand = selectedCmd ? `/${selectedCmd.name}` : state.prompt;
      const raw = originalCommand.trim();
      if (raw.startsWith('/') && state.commandRegistry && state.commandContext) {
        closeCommandMode();
        state.conversationManager?.dismissSplash(); // command input retires the splash, same as text input
        const prepared = presentation.prepare(state.commandContext, state, raw);
        if (!prepared) return true;
        const { name, args, context: ctx } = prepared;
        const registered = state.commandRegistry.get(name);
        state.inputHistory?.add(commandHistoryLine(raw, name, args, registered?.secretArgs));
        const commandPromise = registered
          ? state.commandRegistry.executeFromOwner(name, args, ctx, originalCommand)
          : (ctx.executeCommand?.(name, args) ?? Promise.resolve(false));
        commandPromise
          .then((handled) => {
            if (handled) {
              state.requestRender();
            } else {
              const shellPaths = state.commandContext?.workspace.shellPaths;
              const skillContent = shellPaths
                ? loadSkillByTrigger('/' + name, {
                    workingDirectory: shellPaths.workingDirectory,
                    homeDirectory: shellPaths.homeDirectory,
                  })
                : null;
              if (skillContent) {
                state.commandContext?.submitInput?.(skillContent);
              } else {
                state.conversationManager?.log(presentation.unknownCommand(name), { fg: activeTokens().error });
                state.requestRender();
              }
            }
          })
          .catch((error: unknown) => {
            // A command that refused threw its refusal; it reads as the reason and the next step, not as a crash.
            const refused = readRefusal(error);
            const message = refused ? formatRefusal(refused) : presentation.commandError(error, name);
            state.conversationManager?.log(message, { fg: activeTokens().error });
            state.requestRender();
          });
      } else {
        closeCommandMode();
      }
      return true;
    }
    // Cursor keys fall through to the composer's key route, so a command line is edited like any other text.
    return !COMMAND_LINE_CURSOR_KEYS.includes(token.logicalName);
  }
  return handleCommandModeToken;
}
