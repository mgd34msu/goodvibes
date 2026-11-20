import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

/**
 * `/editor`, described once (command-actions/): open the current composer
 * draft in the user's $EDITOR / $VISUAL, then load the edited text back into
 * the composer. The terminal suspend/resume and buffer round-trip are wired in
 * main.ts as the `openComposerEditor` command action.
 */
export function registerEditorRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'editor',
    title: 'Write in your editor',
    summary: 'Write the message in your own editor, then come back with it',
    group: 'Editor',
    actions: [
      doAction<CommandContext>({
        id: 'editor', label: 'Write the message in your editor', word: '',
        sentence: 'Opens the message you are writing in $VISUAL or $EDITOR; when you close it, the text comes back here.',
        operator: { terminalOnly: 'It opens an editor in the terminal.' },
        async run(_values, ctx) {
          if (!ctx.openComposerEditor) throw commandRefusal('No editor can be opened here.');
          ctx.openComposerEditor();
        },
      }),
    ],
  }));
}
