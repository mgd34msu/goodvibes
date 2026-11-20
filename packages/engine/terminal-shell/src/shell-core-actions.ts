import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { OpenSelection } from './selection-modal.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { doAction } from './described-command-kit.js';
import type { CommandActionContext } from './command-actions/types.js';
interface ShellCoreContext {
  readonly session: { readonly runtime: { model: string; provider: string; reasoningEffort: string; sessionId: string } };
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set'> };
  readonly openSelection?: OpenSelection | undefined;
  readonly openModelPicker?: (() => void) | undefined;
  readonly isGenerating?: (() => boolean) | undefined;
  print(message: string): void;
  renderRequest(): void;
}
export function createShellCoreActions<Context extends ShellCoreContext>(
  services: {
    readonly startFreshConversation: (context: Context) => { readonly savedAs: string | null };
  },
  policy: {
    readonly freshConversation: (context: Context, savedAs: string) => void;
  },
) {
  return {
    // `/clear`: a single-action command (command-actions/): the line is the command name alone.
    clear: defineCommand<Context & CommandActionContext>({
      name: 'clear', title: 'Start a fresh conversation', summary: 'Start a fresh conversation; the current one is saved as its own session', group: 'Conversation',
      actions: [doAction<Context & CommandActionContext>({
        id: 'clear', label: 'Start a fresh conversation', word: '', touches: 'this-machine',
        sentence: 'The current conversation is saved as its own session and a fresh one starts; /resume brings the saved one back.',
        operator: { terminalOnly: 'It is the terminal app\'s open conversation.' },
        async run(_values, ctx) {
          if (ctx.isGenerating?.()) throw commandRefusal('A turn is still running, so nothing was cleared.', 'Stop it with Esc or let it finish, then /clear.');
          let result: { readonly savedAs: string | null };
          try {
            result = services.startFreshConversation(ctx);
          } catch (e) {
            throw commandRefusal(`Could not save the current conversation, so nothing was cleared: ${summarizeError(e)}`);
          }
          if (result.savedAs) policy.freshConversation(ctx, result.savedAs);
          ctx.renderRequest?.();
        },
      })],
    }),
  };
}
