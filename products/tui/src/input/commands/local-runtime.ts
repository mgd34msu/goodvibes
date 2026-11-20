import { createSecretsCommand } from '@goodvibes/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes/engine/terminal-shell/local-command-actions';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { toolsCommand } from './tools-command.ts';

import { requireProviderApi } from './runtime-services.ts';

export const localActions = createLocalCommandActions<CommandContext>(requireProviderApi, {
  unpinByModelId: false,
  supportedFormats: '\nSupported: .png, .jpg, .jpeg, .webp, .gif',
  maximumImageSize: 'Maximum: 20MB',
  error: (detail) => 'Error: ' + detail,
  imageFailure: (kind, detail) => kind + ': ' + detail,
  invalidBlockType: (type, valid) => 'Unknown type: ' + type + '\nValid types: ' + valid.join(', '),
  noteTouch: (conversation, key) => conversation.searchExpansion.noteUserTouch(key),
});

// `/secrets` is one description shared with the other terminal app (terminal-shell/secrets-command.ts); a credential is kept where it is asked.
const secretsCommand = createSecretsCommand<CommandContext>({
  writeScope: (_key, requested) => requested,
  deleteScope: (_key, requested) => requested,
  relocationNote: () => '',
});

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register(toolsCommand);

  registry.register(secretsCommand);

  registry.register(localActions['image']);

  registry.register(localActions['pin']);

}
