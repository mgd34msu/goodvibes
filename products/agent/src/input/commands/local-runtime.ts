import { createSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes-jev/engine/terminal-shell/local-command-actions';
import 'path';
import 'node:fs';
import 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';

import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/config';
import { requireProviderApi, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { registerServicesCommand } from '@goodvibes-jev/engine/terminal-shell/services-command';
import {
  credentialWriteScopeWasRelocated,
  resolveCredentialDeleteScope,
  resolveCredentialWriteScope,
} from '../../config/credential-scope.ts';
import { createMediaCommand } from '@goodvibes-jev/engine/terminal-shell/media-command';

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
  registry: (ctx) => ctx.platform.mediaProviderRegistry,
  artifactStore: (ctx) => ctx.platform.artifactStore,
  paths: requireShellPaths,
});

// `/secrets` is one description shared with the other terminal app (terminal-shell/secrets-command.ts); a credential the daemon reads is filed in its tier.
const secretsCommand = createSecretsCommand<CommandContext>({
  writeScope: resolveCredentialWriteScope,
  deleteScope: resolveCredentialDeleteScope,
  relocationNote: (key, requested) =>
    credentialWriteScopeWasRelocated(key, requested)
      ? 'Filed in the daemon tier instead of ' + requested + ': the daemon is what reads this credential, and it reads only its own tier.'
      : '',
});

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  // `/services` is one description shared with the other terminal app (terminal-shell/services-command.ts).
  registerServicesCommand<CommandContext>(registry, { requireServiceRegistry, requireShellPaths });

  registry.register(secretsCommand);

  registry.register(localActions['image']);

  // `/media` is one description shared with the other terminal app (terminal-shell/media-command.ts).
  registry.register(mediaCommand);

  registry.register(localActions['pin']);

}
