import { runWorkstreamCommand, WORKSTREAM_SHARED_USAGE } from '@goodvibes-jev/engine/terminal-shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

/**
 * The Agent's `/workstream`: the shared terminal-shell verbs (contracts, unit
 * retry, budget, and the plan-review flow over drafts). Work is started here by
 * planning it (`propose`, then `approve` and `launch`), or by asking for it in
 * a message, which runs delegated work as a contract.
 */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Plan, inspect, stop, retry, re-budget or answer a workstream',
    usage: WORKSTREAM_SHARED_USAGE,
    argsHint: WORKSTREAM_SHARED_USAGE,
    handler: async (args, ctx: CommandContext) => {
      const action = args[0] ?? 'list';
      if (action === 'start') {
        ctx.print('Plan the work with /workstream propose <goal>, then approve and launch the draft; or ask for it in a message, which runs delegated work as a contract.');
        return;
      }
      try {
        const handled = await runWorkstreamCommand(action, args.slice(1), {
          print: (text) => ctx.print(text),
          sessionId: ctx.session.runtime.sessionId,
          contracts: ctx.session.contractOperator,
          drafts: ctx.session.workstreamDrafts,
        });
        if (!handled) ctx.print(`Usage: /workstream ${WORKSTREAM_SHARED_USAGE}`);
        ctx.renderRequest();
      } catch (error) {
        ctx.print(`Workstream action failed: ${summarizeError(error)}`);
      }
    },
  });
}
