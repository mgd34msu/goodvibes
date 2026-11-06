import { parseNativeShellCli, shellMetadataResult } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
import { extractNativeHeadlessOptions } from './native-headless-options.ts';
import { parseGoodVibesCli } from './parser.ts';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesVersion } from './help.ts';

export type MetadataCliResult = { readonly stdout?: string; readonly stderr?: string; readonly exitCode: number };

/** Preserve the normal CLI parser and help precedence without runtime setup. */
export function metadataCliResult(argv: readonly string[], binary = 'goodvibes-agent'): MetadataCliResult | null {
  const { cli } = parseNativeShellCli(argv, binary, extractNativeHeadlessOptions, parseGoodVibesCli);
  if (cli.errors.length > 0) return { stderr: `${cli.errors.join('\n')}\n\n${renderGoodVibesHelp(binary)}`, exitCode: 2 };
  return shellMetadataResult(cli, binary, {
    help: renderGoodVibesHelp,
    commandHelp: renderGoodVibesCommandHelp,
    version: renderGoodVibesVersion,
    completion: renderCompletion,
  });
}
