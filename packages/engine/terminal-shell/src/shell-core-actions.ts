import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { CONVERSATION_CLEAR, type ClearServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { OpenSelection } from './selection-modal.js';
import { defineCommand } from './command-actions/define.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
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
      // Moved beside its handler (capabilities/builtin/conversation.ts); it runs here, on this program's conversation.
      actions: [sessionCapabilityAction<Context & CommandActionContext, ClearServices>(CONVERSATION_CLEAR, (ctx) => ({
        conversation: { isGenerating: () => ctx.isGenerating?.() === true, startFresh: () => services.startFreshConversation(ctx) },
      }), {
        terminalOnly: 'It is the terminal app\'s open conversation.',
        after(ctx, result) {
          const savedAs = result.data?.['savedAs'];
          if (typeof savedAs === 'string' && savedAs) policy.freshConversation(ctx, savedAs);
          ctx.renderRequest?.();
        },
      })],
    }),
  };
}
