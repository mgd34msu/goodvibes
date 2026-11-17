import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { renderContractStatus, runWorkstreamCommand, WORKSTREAM_SHARED_USAGE } from '@goodvibes-jev/engine/terminal-shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { directOwnerWorkstreamInput, type CommandContext, type CommandRegistry } from '../command-registry.ts';

const USAGE = `start <request> | ${WORKSTREAM_SHARED_USAGE}`;

export { renderContractStatus };

/**
 * `start` uses native intake; every other verb (contracts, unit retry, budget,
 * and the plan-review flow over drafts) is the shared terminal-shell command.
 */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Start, plan, inspect, stop, retry, re-budget or answer a workstream',
    usage: USAGE,
    argsHint: USAGE,
    handler: async (args, ctx: CommandContext) => {
      const action = args[0] ?? 'list';
      if (action === 'start') {
        const source = directOwnerWorkstreamInput(ctx);
        if (!source) { ctx.print('Start work from the terminal with /workstream start <request>. Original owner input is required.'); return; }
        if (!source.text.trim()) { ctx.print('Usage: /workstream start <request>'); return; }
        if (!ctx.dispatchNativeIntakeTurn) { ctx.print('Native conversation intake is unavailable. No ordinary turn was started.'); return; }
        const state = await routeNativeConversationInput({ intake: ctx.nativeConversationIntake, source,
          notify: line => ctx.print(line), dispatch: ctx.dispatchNativeIntakeTurn });
        // Refused because another input is still being admitted: nothing was sent.
        if (state?.status === 'pending') ctx.restoreDraft?.(`/workstream start ${source.text}`);
        ctx.renderRequest();
        return;
      }
      try {
        const handled = await runWorkstreamCommand(action, args.slice(1), {
          print: (text) => ctx.print(text),
          sessionId: ctx.session.runtime.sessionId,
          contracts: ctx.session.contractOperator,
          drafts: ctx.session.workstreamDrafts,
        });
        if (!handled) ctx.print(`Usage: /workstream ${USAGE}`);
        ctx.renderRequest();
      } catch (error) {
        ctx.print(`Workstream action failed: ${summarizeError(error)}`);
      }
    },
  });
}
