import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { OpenSelection } from './selection-modal.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { doAction } from './described-command-kit.js';
import type { CommandActionContext } from './command-actions/types.js';
import type { KeyCombo } from './keybindings.js';
interface ShellCoreContext {
  readonly session: { readonly runtime: { model: string; provider: string; reasoningEffort: string; sessionId: string } };
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set'> };
  readonly openSelection?: OpenSelection | undefined;
  readonly openModelPicker?: (() => void) | undefined;
  readonly openShortcutsOverlay?: (() => void) | undefined;
  readonly isGenerating?: (() => boolean) | undefined;
  print(message: string): void;
  renderRequest(): void;
}
interface KeybindingsView {
  getConfigPath(): string;
  getAll(): { action: string; combos: KeyCombo[]; description: string }[];
  formatCombo(combo: KeyCombo): string;
}
export function createShellCoreActions<Context extends ShellCoreContext>(
  services: {
    readonly requireKeybindingsManager: (context: Context) => KeybindingsView;
    readonly startFreshConversation: (context: Context) => { readonly savedAs: string | null };
  },
  policy: {
    readonly hidden: boolean;
    readonly shortcutOverlay: boolean;
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
    keybindings: {
      name: 'keybindings',
      effect: 'read-only',
      firstScreen: !policy.hidden,
      aliases: ['kb'],
      description: 'List current keyboard bindings and their config file path',
      handler(_args: string[], ctx: Context) {
        const km = services.requireKeybindingsManager(ctx);
        if (policy.shortcutOverlay) {
          ctx.print(
            'Keybindings config: ' +
              km.getConfigPath() +
              '  (create it to override any binding: { "action": { "key": "x", "ctrl": true } })',
          );
          if (ctx.openShortcutsOverlay) {
            ctx.openShortcutsOverlay();
            return;
          }
        }
        const all = km.getAll();
        const lines: string[] = [
          ...(!policy.shortcutOverlay ? ['Keybindings config: ' + km.getConfigPath(), ''] : []),
          `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
          `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
        ];
        for (const { action, combos, description } of all) {
          const label = combos.map((combo) => km.formatCombo(combo)).join(', ');
          lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
        }
        if (!policy.shortcutOverlay) lines.push('', 'To customize: create the config file with { "action": { "key": "x", "ctrl": true } }');
        ctx.print(lines.join('\n'));
      },
    } satisfies TerminalSlashCommand<Context>,
  };
}
