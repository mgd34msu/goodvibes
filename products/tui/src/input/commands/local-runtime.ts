import { wireSecretsLists } from '@goodvibes/engine/terminal-shell/secrets-command';
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

// Secrets are the daemon's, kept and changed in Permissions and safety (no slash command carries them): the lists a
// secret input chooses from read the daemon through this app's binding (terminal-shell/secrets-command.ts).
export function registerLocalRuntimeCommands(_registry: CommandRegistry): void {
  wireSecretsLists<CommandContext>(capabilityBinding);
}
