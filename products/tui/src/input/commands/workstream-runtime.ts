import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { registerWorkstreamCommand, renderContractStatus } from '@goodvibes/engine/terminal-shell';
import { captureNativeConversationInput } from '@goodvibes/engine/terminal-shell/native';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { directOwnerWorkstreamInput, isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';

export { renderContractStatus };

/**
 * `/workstream` is one description shared with the Agent
 * (terminal-shell/workstream-command.ts). Here a request starts work through
 * native intake: the owner's own words, from the typed line exactly as typed
 * or from the guided form, never from a model.
 */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registerWorkstreamCommand<CommandContext>(registry, async (request, ctx) => {
    const source = directOwnerWorkstreamInput(ctx)
      ?? (isDirectOwnerCommandContext(ctx, 'workstream') ? captureNativeConversationInput(request) : undefined);
    if (!source) throw commandRefusal('Work starts only from your own words typed in the terminal; nothing was started.', 'Type /workstream start <request>.');
    if (!source.text.trim()) throw commandRefusal('Say what to do: /workstream start <request>.');
    if (!ctx.dispatchNativeIntakeTurn) throw commandRefusal('Native conversation intake is unavailable. No ordinary turn was started.');
    const state = await routeNativeConversationInput({ intake: ctx.nativeConversationIntake, source,
      notify: line => ctx.print(line), dispatch: ctx.dispatchNativeIntakeTurn });
    // Refused because another input is still being admitted: nothing was sent.
    if (state?.status === 'pending') ctx.restoreDraft?.(`/workstream start ${source.text}`);
    ctx.renderRequest();
  });
}
