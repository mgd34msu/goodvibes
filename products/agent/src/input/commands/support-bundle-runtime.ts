/**
 * `/bundle`, described (command-actions/): a redacted support bundle of this
 * Agent's settings and setup, saved to a file, checked, or loaded back. The
 * work is the `goodvibes-agent bundle` command's (cli/bundle-command.ts); this
 * description is how a person reaches it from the composer.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleBundleCommand } from '../../cli/bundle-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';

const DEFAULT_BUNDLE_FILENAME = 'goodvibes-agent-bundle.json';
const TERMINAL_ONLY = 'A support bundle is written and read by the Agent on this machine.';

/** Run one `bundle` subcommand of the CLI; its output, or a refusal with its words. */
async function runBundle(ctx: CommandContext, words: readonly string[]): Promise<{ readonly output: string; readonly exitCode: number }> {
  const cli = parseGoodVibesCli(['bundle', ...words], 'goodvibes-agent');
  if (cli.errors.length > 0) throw commandRefusal(cli.errors.join('\n'));
  const shellPaths = requireShellPaths(ctx);
  const runtime: CliCommandRuntime = {
    cli,
    configManager: ctx.platform.configManager,
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
  };
  try {
    return await handleBundleCommand(runtime);
  } catch (error) {
    throw commandRefusal(`The support bundle could not be ${words[0] === 'export' ? 'written' : 'read'}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function succeeded(result: { readonly output: string; readonly exitCode: number }): string {
  if (result.exitCode !== 0) throw commandRefusal(result.output, undefined, 'COMMAND_FAILED');
  return result.output;
}

const FILE = textInput({ id: 'path', label: 'File', help: 'A support bundle file, such as goodvibes-agent-bundle.json', why: 'a file path on this machine', kind: 'path', typed: { position: 1 } });

const BUNDLE_COMMAND = defineCommand<CommandContext>({
  name: 'bundle',
  title: 'Support bundle',
  summary: 'Save this Agent\'s settings and setup to a redacted file, check one, or load settings back from one',
  group: 'Setup',
  report: 'preview',
  actions: [
    readAction<CommandContext>({
      id: 'preview', label: 'See what a support bundle would hold', word: 'preview',
      sentence: 'Builds a support bundle in a temporary place, shows what it holds (secrets taken out), and deletes it; nothing is kept.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) {
        const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-bundle-'));
        try {
          const path = join(scratch, DEFAULT_BUNDLE_FILENAME);
          succeeded(await runBundle(ctx, ['export', path]));
          return [succeeded(await runBundle(ctx, ['inspect', path])), '', `Nothing was kept. /bundle export [<file>] saves one.`].join('\n');
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    }),
    {
      id: 'save', label: 'Save a support bundle', word: 'export',
      inputs: [
        { ...FILE, help: 'Where to write it', required: { default: DEFAULT_BUNDLE_FILENAME, defaultMeans: `${DEFAULT_BUNDLE_FILENAME} in this folder` } },
        choiceInput({ id: 'existing', label: 'If the file exists', help: 'Stop, or write over what it holds', choices: [
          { value: 'stop', label: 'Stop and say so' },
          { value: 'replace', label: 'Replace it', help: 'What it holds now cannot be recovered.', risk: 'cannot-be-undone' },
        ], typed: { flag: '--replace', switchOn: 'replace' }, optional: { default: 'stop', means: 'stop and say so' } }),
      ],
      sentence: 'This Agent\'s settings and setup, with every secret taken out, are written to {path}.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { path: 'support.json' },
      async run(values, ctx) {
        const path = values.path || DEFAULT_BUNDLE_FILENAME;
        if (values.existing !== 'replace' && existsSync(requireShellPaths(ctx).resolveWorkspacePath(path))) {
          throw commandRefusal(`${path} already exists; nothing was written.`, `Choose another file, or replace it: /bundle export ${path} --replace`);
        }
        return succeeded(await runBundle(ctx, ['export', path]));
      },
    },
    readAction<CommandContext>({
      id: 'check', label: 'Check a support bundle', word: 'inspect', inputs: [FILE],
      sentence: 'Shows what {path} holds and which of your settings loading it would change, without changing anything.',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { path: 'support.json' },
      async run(values, ctx) {
        const inspected = succeeded(await runBundle(ctx, ['inspect', values.path!]));
        // The import's own reading, without --yes, is the list of what it would change.
        const preview = await runBundle(ctx, ['import', values.path!]);
        const changes = preview.exitCode === 2
          ? ['Loading it would change (current -> new):', ...preview.output.split('\n').slice(1).filter((line) => !line.startsWith('Usage:'))]
          : [preview.output];
        return [inspected, '', ...changes].join('\n');
      },
    }),
    {
      id: 'load', label: 'Load settings from a support bundle', word: 'import',
      inputs: [
        FILE,
        choiceInput({ id: 'security', label: 'Security settings', help: 'Settings that decide what runs unasked, what this machine exposes and where data is kept', choices: [
          { value: 'no', label: 'Leave them as they are' },
          { value: 'yes', label: 'Load them too', risk: 'loosens-a-protection' },
        ], typed: { flag: '--include-security', switchOn: 'yes' }, optional: { default: 'no', means: 'leave them as they are' } }),
      ],
      sentence: 'Each setting in {path} that differs from yours replaces it, until you change it; secrets are never in a bundle, so yours stay.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it changes your settings from a file', instead: 'Ask the owner to run /bundle import <file>; /bundle inspect <file> shows what it would change.' },
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { path: 'support.json' },
      async run(values, ctx) {
        return succeeded(await runBundle(ctx, ['import', values.path!, ...(values.security === 'yes' ? ['--include-security'] : []), '--yes']));
      },
    },
  ],
});

export function registerSupportBundleRuntimeCommands(registry: CommandRegistry): void {
  registry.register(BUNDLE_COMMAND);
}
