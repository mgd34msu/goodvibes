// Proves: A secret typed on a command line is written in plain text to the input-history file.
// Red when: A command's declared secret arguments are no longer applied before the line reaches history, or the history's own rule for token flags stops matching.
/**
 * A secret typed as a command argument is not written to input history.
 *
 * The owner types a command line and presses Enter through the terminal's real
 * command route (command-mode-route.ts, the same handler both apps build), with
 * the real command registry, the real `/secrets` command and the real input
 * history persisting to a file in a temp directory. What is on disk afterwards,
 * and what a fresh history recalls from it, must not hold the value; the rest
 * of the line is kept so it can still be recalled and corrected.
 *
 * Also covered: a command this app does not register (an Agent has no
 * `/local-auth`) and a token flag typed on any command line.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { createCommandModeTokenHandler, type CommandRouteContext } from '../terminal-shell/src/command-mode-route.ts';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.ts';
import { InputHistory } from '../terminal-shell/src/input-history.ts';
import { createSecretsCommand, type SecretsCommandContext } from '../terminal-shell/src/secrets-command.ts';
import { splitSlashCommand } from '../terminal-shell/src/slash-command-parser.ts';

interface Ctx extends CommandRouteContext, SecretsCommandContext {}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** One terminal: registry with /secrets, a persisted history, and the command route, ready to take one line. */
function terminal() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-history-secrets-')));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const historyPath = join(home, 'input-history.json');
  const secrets = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: home, projectRoot: project });
  const { CommandRegistry } = createTerminalCommandRegistry<Ctx>();
  const registry = new CommandRegistry();
  registry.register(createSecretsCommand<Ctx>({
    writeScope: (_key, requested) => requested, deleteScope: (_key, requested) => requested, relocationNote: () => '',
  }));

  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => { settled = resolve; });
  const context: Ctx = {
    workspace: { shellPaths: { workingDirectory: project, homeDirectory: home } },
    platform: { secretsManager: secrets },
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
    unknownCommand: (name) => `unknown /${name}`,
    commandError: (_error, name) => `/${name} failed`,
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
  for (let entry = fresh.up(''); entry !== null; entry = fresh.up(entry)) recalled.push(entry);
  return `${readFileSync(historyPath, 'utf8')}\n${recalled.join('\n')}`;
}

test('a value given to /secrets set is not written to history; the command line is', async () => {
  const term = terminal();
  await term.enter('/secrets set OPENAI_API_KEY sk-typed-secret-4f9a2c --scope user');
  const kept = remembered(term.historyPath);
  expect(kept).not.toContain('sk-typed-secret-4f9a2c');
  expect(kept).toContain('/secrets set OPENAI_API_KEY');
});

test('a token flag on any command line is not written', async () => {
  const term = terminal();
  await term.enter('/connect remote --token tok-typed-9d3e71 --operator-token=op-typed-5b8a20');
  const kept = remembered(term.historyPath);
  expect(kept).not.toContain('tok-typed-9d3e71');
  expect(kept).not.toContain('op-typed-5b8a20');
  expect(kept).toContain('/connect remote');
});
