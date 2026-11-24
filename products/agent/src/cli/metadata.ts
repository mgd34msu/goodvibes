import { cliUsageRefusalResult, parseNativeShellCli, shellMetadataResult } from '@goodvibes/engine/terminal-shell/cli-entrypoint';
import { parseGoodVibesCli } from './parser.ts';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesUsageLine, renderGoodVibesVersion } from './help.ts';

export type MetadataCliResult = { readonly stdout?: string; readonly stderr?: string; readonly exitCode: number };

/** Preserve the normal CLI parser and help precedence without runtime setup. */
export function metadataCliResult(argv: readonly string[], binary = 'goodvibes-agent'): MetadataCliResult | null {
  const { cli } = parseNativeShellCli(argv, binary, parseGoodVibesCli);
  // A `run` asking for JSON gets its refusal as the run's final frame, from the CLI entry.
  if (cli.errors.length > 0) return cliUsageRefusalResult(cli, cli.errors, renderGoodVibesUsageLine(cli, binary)) ?? null;
  return shellMetadataResult(cli, binary, {
    help: renderGoodVibesHelp,
    commandHelp: renderGoodVibesCommandHelp,
    version: renderGoodVibesVersion,
    completion: renderCompletion,
  });
}
