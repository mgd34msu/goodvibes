import { parseNativeShellCli, shellMetadataResult } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
import { parseWithCatalog } from '@goodvibes-jev/engine/terminal-shell/cli-parser-engine';
import { GOODVIBES_CLI_CATALOG } from '@goodvibes-jev/engine/terminal-shell/cli-command-catalog';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesVersion } from './help.ts';

export type MetadataCliResult = { readonly stdout?: string; readonly stderr?: string; readonly exitCode: number };

/** Preserve the normal CLI parser and help precedence without runtime setup. */
export function metadataCliResult(argv: readonly string[], binary = 'goodvibes'): MetadataCliResult | null {
  // `host` is parsed by its own command; the shared parser would refuse it.
  if (argv[0] === 'host') return null;
  const { cli } = parseNativeShellCli(argv, binary, (args, name) => parseWithCatalog(args, GOODVIBES_CLI_CATALOG, name));
  if (cli.errors.length > 0) return { stderr: `${cli.errors.join('\n')}\n\n${renderGoodVibesHelp(binary)}`, exitCode: 2 };
  return shellMetadataResult(cli, binary, {
    help: renderGoodVibesHelp,
    commandHelp: renderGoodVibesCommandHelp,
    version: renderGoodVibesVersion,
    completion: renderCompletion,
  });
}
