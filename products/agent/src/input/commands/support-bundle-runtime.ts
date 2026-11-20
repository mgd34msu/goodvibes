import type { CommandRegistry } from '../command-registry.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleBundleCommand } from '../../cli/bundle-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { requireShellPaths } from './runtime-services.ts';
import { existsSync } from 'node:fs';
import { commandRefusal, stripYesFlag } from './confirmation.ts';

const DEFAULT_BUNDLE_FILENAME = 'goodvibes-agent-bundle.json';

export function registerSupportBundleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'bundle',
    effect: 'mixed',
    description: 'Export, inspect, or import redacted Agent support bundles from the TUI',
    firstScreen: false,
    usage: '[export [path]|inspect <path>|import <path> [--include-security] --yes]',
    argsHint: 'export|inspect|import',
    // A redacted export to a new file runs at once; over an existing file it
    // replaces what is there, so the registry asks once. Import keeps its own
    // preview (every setting it would change, current -> new) before --yes.
    confirm(args, ctx) {
      if ((args[0] ?? '').toLowerCase() !== 'export') return undefined;
      const path = args.slice(1).find((word) => !word.startsWith('--')) ?? DEFAULT_BUNDLE_FILENAME;
      const target = requireShellPaths(ctx).resolveWorkspacePath(path);
      if (!existsSync(target)) return undefined;
      return { title: `Replace ${target}?`, detail: `${target} already exists; the support bundle replaces it, and what it holds now cannot be recovered.`, confirmLabel: 'Replace' };
    },
    async handler(args, ctx) {
      // Import reads its own --yes: without it the shared import shows every
      // setting it would change (current -> new) and changes nothing.
      const isImport = (args[0] ?? '').toLowerCase() === 'import';
      const cli = parseGoodVibesCli(['bundle', ...(isImport ? args : stripYesFlag(args).rest)], 'goodvibes-agent');
      if (cli.errors.length > 0) {
        ctx.print(cli.errors.join('\n'));
        return;
      }

      const shellPaths = requireShellPaths(ctx);
      const runtime: CliCommandRuntime = {
        cli,
        configManager: ctx.platform.configManager,
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      };
      let result;
      try {
        result = await handleBundleCommand(runtime);
      } catch (error) {
        throw commandRefusal(`Could not complete bundle operation: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.exitCode !== 0) {
        const code = result.exitCode !== 2 ? 'COMMAND_FAILED' : result.output.startsWith('Refusing') ? 'CONFIRMATION_REQUIRED' : undefined;
        throw commandRefusal(result.output, undefined, code);
      }
      ctx.print(result.output);
    },
  });
}
