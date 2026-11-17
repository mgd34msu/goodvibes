import { runWorkstreamCommand, WORKSTREAM_SHARED_USAGE } from '@goodvibes-jev/engine/terminal-shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';

/**
 * The Agent's `/workstream`: the shared terminal-shell verbs (contracts, unit
 * retry, budget, and the plan-review flow over drafts). Work is started here by
 * planning it (`propose`, then `approve` and `launch`), or by asking for it in
 * a message, which runs delegated work as a contract.
 */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    effect: 'delegated-work',
    description: 'Plan, inspect, stop, retry, re-budget or answer a workstream',
    usage: WORKSTREAM_SHARED_USAGE,
    argsHint: WORKSTREAM_SHARED_USAGE,
    handler: async (args, ctx: CommandContext) => {
      const action = args[0] ?? 'list';
      if (action === 'start') {
        throw commandRefusal('/workstream start is not a verb: nothing was started.', 'Plan the work with /workstream propose <goal>, then approve and launch the draft; or ask for it in a message, which runs delegated work as a contract.', 'USAGE');
      }
      try {
        const handled = await runWorkstreamCommand(action, args.slice(1), {
          print: (text) => ctx.print(text),
          sessionId: ctx.session.runtime.sessionId,
          contracts: ctx.session.contractOperator,
          drafts: ctx.session.workstreamDrafts,
        });
        ctx.renderRequest();
        if (!handled) throw commandRefusal(`Usage: /workstream ${WORKSTREAM_SHARED_USAGE}`);
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(`Workstream action failed: ${summarizeError(error)}`, undefined, 'COMMAND_FAILED');
      }
    },
  });
}
