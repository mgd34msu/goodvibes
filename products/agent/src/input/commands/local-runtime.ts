import { createSecretsCommand } from '@goodvibes/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes/engine/terminal-shell/local-command-actions';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';

import { requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { createMediaCommand } from '@goodvibes/engine/terminal-shell/media-command';
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

const mediaCommand = createMediaCommand<CommandContext>({
  product: 'goodvibes-agent',
  registry: (ctx) => ctx.platform.mediaProviderRegistry,
  artifactStore: (ctx) => ctx.platform.artifactStore,
  paths: requireShellPaths,
  binding: capabilityBinding,
});

// `/secrets` is one description shared with the other terminal app (terminal-shell/secrets-command.ts); the daemon keeps
// every secret, and files one it reads itself in its own store whatever scope was asked.
const secretsCommand = createSecretsCommand<CommandContext>(capabilityBinding);

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register(secretsCommand);

  // `/media` is one description shared with the other terminal app (terminal-shell/media-command.ts).
  registry.register(mediaCommand);
}
