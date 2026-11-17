/**
 * cluster-runtime.ts, `/cluster` in the TUI.
 *
 * The same operations as the `goodvibes-daemon cluster` subcommands, reaching
 * the same daemon verbs through the same caller. There is no cluster logic in
 * this file and there must never be any: if `/cluster status` and
 * `cluster status` could disagree, one of them would be lying to somebody.
 *
 * The one honest difference is `join` without arguments. The CLI can stop and
 * ask which group and for the join key; a slash command has nowhere to ask, so
 * it requires `--group` and `--key` and says so, which is exactly what the
 * shared caller already reports for any non-interactive invocation.
 */
import { resolveDaemonHomeDir } from '@goodvibes-jev/engine/platform/platform/workspace';
import {
  CLUSTER_SUBCOMMANDS,
  describeIrreversibleClusterCommand,
  parseClusterCommand,
  runClusterCommand,
} from '@goodvibes-jev/engine/terminal-shell';
import type { CommandRegistry } from '../command-registry.ts';

/** Subcommand → argument hint, surfaced as the operator types. */
export const CLUSTER_SUBCOMMAND_ARG_HINTS: Record<string, string> = {
  status: '',
  create: '[--name "<group name>"] [--passphrase "<phrase>"]',
  join: '--group <id> --key <join key>',
  key: '',
  nodes: '',
  forget: '<machine>',
  rotate: '[--now]',
  leave: '',
  rename: '"<new name>"',
  groups: '',
};

export function registerClusterRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cluster',
    description: 'Share inbound channel work with your other goodvibes machines on this network',
    usage: `[${CLUSTER_SUBCOMMANDS.join('|')}]: status is the default; `
      + 'add --host https://<machine> (or a base URL), --port, --token to reach a daemon on another machine',
    argsHint: `[${CLUSTER_SUBCOMMANDS.join('|')}]`,
    subcommands: CLUSTER_SUBCOMMAND_ARG_HINTS,
    confirm(args) {
      const parsed = parseClusterCommand(args);
      if (parsed.errors.length > 0) return undefined;
      const irreversible = describeIrreversibleClusterCommand(parsed);
      if (irreversible === null) return undefined;
      const sentence = irreversible.charAt(0).toUpperCase() + irreversible.slice(1);
      return {
        title: `Run cluster ${parsed.subcommand}${parsed.positional ? ` ${parsed.positional}` : ''}${parsed.now ? ' --now' : ''}?`,
        detail: `${sentence}. It cannot be undone.`,
        confirmLabel: parsed.subcommand === 'rotate' ? 'Rotate' : parsed.subcommand === 'forget' ? 'Forget' : 'Leave',
      };
    },
    async handler(args, ctx) {
      // The registry has already asked the owner for an irreversible line (or
      // the owner typed --yes), so the shared caller is told it was confirmed.
      const base = args.length === 0 ? ['status'] : args;
      const argv = describeIrreversibleClusterCommand(parseClusterCommand(base)) !== null && !base.includes('--yes')
        ? [...base, '--yes']
        : base;
      const result = await runClusterCommand({
        argv,
        configManager: ctx.platform.configManager,
        daemonHomeDir: resolveDaemonHomeDir(),
        // A transcript is not a terminal for clipboard purposes: writing an
        // OSC 52 escape into the rendered conversation would put a control
        // sequence in the scrollback rather than on anyone's clipboard.
        isTerminal: false,
      });
      ctx.print(result.lines.join('\n'));
    },
  });
}
