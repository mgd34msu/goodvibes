import { wireSecretsLists } from '@goodvibes/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes/engine/terminal-shell/local-command-actions';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';

import { requireProviderApi } from './runtime-services.ts';
import { capabilityBinding } from './capability-binding.ts';

export const localActions = createLocalCommandActions<CommandContext>(requireProviderApi, {
  unpinByModelId: true,
  supportedFormats: '\nSupported .png, .jpg, .jpeg, .webp, .gif',
  maximumImageSize: 'Maximum 20MB',
  error: (detail) => 'Error\n  message ' + detail,
  imageFailure: (kind, detail) => kind + ' ' + detail,
  invalidBlockType: (type, valid) => 'Unknown type ' + type + '\nValid types ' + valid.join(', '),
  noteTouch: (conversation, key) => conversation.noteUserTouch(key),
});

export function registerLocalRuntimeCommands(_registry: CommandRegistry): void {
  // Secrets are the daemon's, kept and changed in Permissions and safety (no slash command carries them): the lists a
  // secret input chooses from read the daemon through the Agent's binding (terminal-shell/secrets-command.ts).
  wireSecretsLists<CommandContext>(capabilityBinding);
  // Images and video are the daemon's (media.make in Tools and extensions, media.collect in Work, media.providers in
  // Models and providers): controls in those places, no slash command; a made file opens here after the person's press
  // (terminal-shell/media-viewer.ts).
}
