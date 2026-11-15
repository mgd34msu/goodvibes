import type { CommandRegistry } from '../command-registry.ts';
import { handleReplayCommand } from '@goodvibes-jev/engine/platform/platform/core';
import { requireReplayEngine } from './runtime-services.ts';

export function registerReplayRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'replay',
    aliases: ['rep'],
    description: 'Replay recorded runs: load, step, seek, compare two runs, and export',
    usage: '[load [runId] | step [n] | seek <rev> | diff <runId> | export <path>]',
    argsHint: '[load|step|seek|diff|export]',
    async handler(args, ctx) {
      const replayEngine = requireReplayEngine(ctx);
      const result = await handleReplayCommand({ replayEngine }, args[0] ?? 'help', args.slice(1));
      ctx.print(result.output);
    },
  });
}
