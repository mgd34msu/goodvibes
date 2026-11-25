import { createSecretsCommand } from '@goodvibes/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes/engine/terminal-shell/local-command-actions';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';
// The tools the model can call here are in Tools and extensions (capabilities/builtin/tools.ts); no slash command carries them.
import '@goodvibes/engine/terminal-shell/tools-capabilities';

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

// `/secrets` is one description shared with the other terminal app (terminal-shell/secrets-command.ts); the daemon keeps every secret.
const secretsCommand = createSecretsCommand<CommandContext>(capabilityBinding);

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register(secretsCommand);
}
