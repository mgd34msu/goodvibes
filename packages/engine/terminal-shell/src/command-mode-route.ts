import { loadSkillByTrigger } from '@goodvibes/engine/platform/platform/tools';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import { formatRefusal, readRefusal } from '@goodvibes/engine/errors';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
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
  /** Sends text as a turn exactly as given (a skill's body is not composer input). */
  readonly submitTurn?: ((input: string) => unknown) | undefined;
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
    /** The line with the highlighted completion past a described command's name in place, or undefined. */
    completeArgument?(prompt: string): string | undefined;
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

/**
 * What a person reads when a slash command fails: a refusal reads as its reason
 * and next step, any other error as the command's failure, never as a crash.
 */
export function commandFailureMessage(name: string, error: unknown): string {
  const refused = readRefusal(error);
  return refused ? formatRefusal(refused) : `Command /${name} failed: ${summarizeError(error)}`;
}

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
  /** The product's surface folder, so `/<skill>` finds skills in `.goodvibes/<surface>/skills` too. */
  readonly surfaceRoot: string;
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
      const completed = state.autocomplete?.completeArgument?.(state.prompt);
      if (completed !== undefined) {
        state.prompt = completed;
        state.cursorPos = completed.length;
        state.autocomplete?.update(completed.slice(1));
        return true;
      }
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
        state.autocomplete?.update(state.prompt.startsWith('/') ? state.prompt.slice(1) : '');
      }
      return true;
    }
    if (token.logicalName === 'enter') {
      const selectedCmd = state.autocomplete?.isActive ? state.autocomplete.getSelected() : undefined;
      const originalCommand = selectedCmd ? `/${selectedCmd.name}` : state.prompt;
      const raw = originalCommand.trim();
      if (raw.startsWith('/') && state.commandRegistry && state.commandContext) {
        closeCommandMode();
        const prepared = presentation.prepare(state.commandContext, state, raw);
        if (!prepared) return true;
        const { name, args, context: ctx } = prepared;
        const registered = state.commandRegistry.get(name);
        state.inputHistory?.add(commandHistoryLine(raw, name, args, registered?.secretArgs));
        const commandPromise = registered
          ? state.commandRegistry.executeFromOwner(name, args, ctx, originalCommand)
          : (ctx.executeCommand?.(name, args) ?? Promise.resolve(false));
        commandPromise
          .then(async (handled) => {
            if (handled) {
              state.requestRender();
            } else {
              const shellPaths = state.commandContext?.workspace.shellPaths;
              const skillContent = shellPaths
                ? await loadSkillByTrigger('/' + name, {
                    workingDirectory: shellPaths.workingDirectory,
                    homeDirectory: shellPaths.homeDirectory,
                    surfaceRoot: presentation.surfaceRoot,
                  })
                : null;
              const submitTurn = state.commandContext?.submitTurn;
              if (skillContent && submitTurn) {
                // A skill file's body is sent as written: a leading `!` or `# ` in it is not the owner typing a shell command or a note.
                submitTurn(skillContent);
              } else if (skillContent) {
                state.conversationManager?.log(`The skill /${name} was found, but this surface cannot send it as a message.`, { fg: activeTokens().error });
                state.requestRender();
              } else {
                state.conversationManager?.log(`Unknown command: /${name}. Type /help for available commands.`, { fg: activeTokens().error });
                state.requestRender();
              }
            }
          })
          .catch((error: unknown) => {
            state.conversationManager?.log(commandFailureMessage(name, error), { fg: activeTokens().error });
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
