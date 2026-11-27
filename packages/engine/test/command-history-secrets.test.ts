// Proves: A secret typed on a command line is written in plain text to the input-history file.
// Red when: A command's declared secret arguments are no longer applied before the line reaches history, or the history's own rule for token flags stops matching.
// Proves: A message holding a pasted block, recalled from input history after a restart, comes back without the text that was pasted.
// Red when: Input history keeps a pasted block's marker but not its content file, so the recalled message sends the marker in place of the forty pasted lines.
/**
 * A secret typed as a command argument is not written to input history.
 *
 * The owner types a command line and presses Enter through the terminal's real
 * command route (command-mode-route.ts, the same handler both apps build), with
 * the real command registry and the real input history persisting to a file in
 * a temp directory. What is on disk afterwards, and what a fresh history
 * recalls from it, must not hold the value; the rest of the line is kept so it
 * can still be recalled and corrected: a token flag typed on any command line,
 * also on a command this app does not register.
 *
 * A pasted block in a sent message is kept by the same history: a message is
 * sent through the real prompt key route with a forty-line paste folded in
 * it, and a second composer with its own history read from the same files
 * (the list and the paste file beside it, as the next start of the program
 * has) recalls it with Up and sends it again.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandModeTokenHandler, type CommandRouteContext } from '../terminal-shell/src/command-mode-route.ts';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.ts';
import {
  createFeedTokenRoutes,
  type FeedCommandContext,
  type IndicatorFocusRouteState,
  type KeyRouteState,
  type MouseRouteState,
  type TextRouteState,
} from '../terminal-shell/src/feed-token-routes.ts';
import { expandPrompt, registerPasteForHost } from '../terminal-shell/src/input-content.ts';
import { TerminalInputHandlerState } from '../terminal-shell/src/input-handler-state.ts';
import { InputHistory } from '../terminal-shell/src/input-history.ts';
import { getWrappedPromptInfo } from '../terminal-shell/src/prompt-buffer.ts';
import { splitSlashCommand } from '../terminal-shell/src/slash-command-parser.ts';

type Ctx = CommandRouteContext & { readonly print: (text: string) => void };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** One terminal: the command registry, a persisted history, and the command route, ready to take one line. */
function terminal() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-history-secrets-')));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const historyPath = join(home, 'input-history.json');
  const { CommandRegistry } = createTerminalCommandRegistry<Ctx>();
  const registry = new CommandRegistry();

  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => { settled = resolve; });
  const context: Ctx = {
    workspace: { shellPaths: { workingDirectory: project, homeDirectory: home } },
    print: () => settled(),
    executeCommand: async () => false,
  };
  const state = {
    commandMode: true, prompt: '', cursorPos: 0, autocomplete: null,
    inputHistory: new InputHistory({ historyPath }),
    commandRegistry: registry, commandContext: context,
    conversationManager: { dismissSplash() {}, log: () => settled() },
    requestRender: () => settled(),
    handleEscape() {},
  };
  const route = createCommandModeTokenHandler<Ctx, typeof state>({
    surfaceRoot: 'goodvibes',
    prepare(ctx, current, raw) {
      const split = splitSlashCommand(raw, (name) => current.commandRegistry.get(name));
      return split.ok ? { name: split.name, args: split.args, context: ctx } : undefined;
    },
  });

  return {
    historyPath,
    /** Type the line, press Enter, and wait until the command has answered. */
    async enter(line: string): Promise<void> {
      state.commandMode = true;
      state.prompt = line;
      state.cursorPos = line.length;
      expect(route(state, { type: 'key', name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false })).toBe(true);
      await done;
    },
  };
}

/** Everything a later session could get back: the file's bytes and what a fresh history recalls from it. */
function remembered(historyPath: string): string {
  const fresh = new InputHistory({ historyPath });
  const recalled: string[] = [];
  for (let entry = fresh.up(''); entry !== null; entry = fresh.up(entry.text)) recalled.push(entry.text);
  return `${readFileSync(historyPath, 'utf8')}\n${recalled.join('\n')}`;
}

test('a token flag on any command line is not written', async () => {
  const term = terminal();
  await term.enter('/connect remote --token tok-typed-9d3e71 --operator-token=op-typed-5b8a20');
  const kept = remembered(term.historyPath);
  expect(kept).not.toContain('tok-typed-9d3e71');
  expect(kept).not.toContain('op-typed-5b8a20');
  expect(kept).toContain('/connect remote');
});

const { handlePromptKeyToken } = createFeedTokenRoutes<
  FeedCommandContext,
  IndicatorFocusRouteState,
  TextRouteState<FeedCommandContext>,
  KeyRouteState<FeedCommandContext>,
  string,
  MouseRouteState
>({ openIndicator: () => {}, mouseRowOffset: 0 });

/** The composer state both terminal programs keep (their input handlers extend it), with its text. */
class Composer extends TerminalInputHandlerState {
  prompt = '';
}

/** One start of the program: a composer, its history read from the file, and what the model was sent. */
function composerOn(historyPath: string, project: string) {
  const composer = new Composer(8);
  composer.inputHistory = new InputHistory({ historyPath });
  const sent: string[] = [];
  const press = (key: 'enter' | 'up'): void => {
    const result = handlePromptKeyToken({
      prompt: composer.prompt, cursorPos: composer.prompt.length, inputScrollTop: 0, commandMode: false,
      contentWidth: 200, maxInputRows: 8, indicatorFocused: false,
      inputHistory: composer.inputHistory, pasteRegistry: composer.pasteRegistry, imageRegistry: composer.imageRegistry,
      restoreRecalledInput: (message) => composer.restoreRecalledInput(message),
      expandPrompt: (text) => expandPrompt(composer.pasteRegistry, composer.imageRegistry, text, project),
      conversationManager: null, autocomplete: null, blockActionsMenu: { open: () => {} },
      commandContext: { print: () => {}, submitInput: (text: string) => { sent.push(text); } },
      saveUndoState: () => {}, ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: (width) => getWrappedPromptInfo(composer.prompt, composer.prompt.length, 0, width, 8),
      moveCursorVertical: () => false, handlePathCompletion: () => false, handleBlockToggle: () => {},
      findMarkerAtPos: () => null, cleanupMarkerRegistry: () => {}, scroll: () => {}, exitApp: () => {}, requestRender: () => {},
    }, { type: 'key', name: key === 'enter' ? 'return' : 'up', logicalName: key, ctrl: false, shift: false, meta: false });
    expect(result.handled).toBe(true);
    composer.prompt = result.prompt;
  };
  return { composer, sent, press };
}

test('a pasted block recalled after a restart comes back folded with its text and is sent in full; a 3.4.3 line still loads', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-history-paste-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const historyPath = join(root, 'input-history.json');
  // What 3.4.3 wrote: the line with its marker only.
  writeFileSync(historyPath, JSON.stringify(['[TEXT: p1, 12 lines] saved by 3.4.3']));
  const pasted = Array.from({ length: 40 }, (_, line) => `pasted line ${line + 1}`).join('\n');

  const first = composerOn(historyPath, project);
  first.composer.prompt = `${registerPasteForHost(first.composer, pasted, project)} what do these say`;
  first.press('enter');
  expect(first.sent).toEqual([`${pasted} what do these say`]);

  const next = composerOn(historyPath, project);
  next.press('up');
  expect(next.composer.prompt).toBe('[TEXT: p1, 40 lines] what do these say');
  next.press('enter');
  expect(next.sent).toEqual([`${pasted} what do these say`]);
  // The line sent again is the same line, so the one before it is two presses up.
  next.press('up');
  next.press('up');
  expect(next.composer.prompt).toBe('[TEXT: p1, 12 lines] saved by 3.4.3');
  next.press('enter');
  expect(next.sent[1]).toBe('[TEXT: p1, 12 lines] saved by 3.4.3');
});
