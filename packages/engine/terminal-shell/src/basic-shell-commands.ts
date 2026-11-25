import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { SYSTEM_QUIT, type SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
export interface BasicShellCommandContext extends CommandActionContext {
  readonly pasteFromClipboard?: (() => { readonly pasted: boolean }) | undefined;
  /** Text folded in the composer as `[TEXT: pN, M lines]`, by its id. */
  readonly getPendingPastes?: (() => ReadonlyMap<string, string>) | undefined;
}

/**
 * The pastes folded in the prompt now (`composer.pastes` in capabilities/builtin/conversation-controls.ts): reading
 * them and pasting the clipboard are controls on the conversation (paste.list, paste.clipboard).
 */
export const PENDING_PASTES = defineList<BasicShellCommandContext>({
  name: 'composer.pastes',
  async read(ctx) {
    return [...(ctx.getPendingPastes?.() ?? new Map<string, string>())].map(([id, content]): ListRow => ({
      value: id, label: content.split('\n')[0]!.slice(0, 80), state: `${content.split('\n').length} lines`,
    }));
  },
  operator: { terminalOnly: 'Pastes are held in the terminal app\'s composer.' },
});

/**
 * `/quit`, described once (command-actions/): one action, the same in both
 * terminal apps. A bare `:q` or `:wq` typed in the composer still closes the
 * program (feed-token-routes.ts); those are keys, not names of this command.
 * Help, every command and every key, is `/help` (and `?`, Ctrl+P).
 */
export function createShellNavigationCommands<
  Context extends CommandActionContext & {
    print(text: string): void;
    exit(): void;
  },
>(services: (context: Context) => SystemSessionServices): { quit: DescribedCommand<Context> } {
  return {
    quit: defineCommand<Context>({
      name: 'quit',
      title: 'Quit',
      summary: 'Close this program',
      group: 'Shell',
      // The capability system.quit (capabilities/builtin/system-session.ts), on this program.
      actions: [sessionCapabilityAction<Context, SystemSessionServices>(SYSTEM_QUIT, services, { terminalOnly: 'It closes the terminal program you are using.' })],
    }),
  };
}
