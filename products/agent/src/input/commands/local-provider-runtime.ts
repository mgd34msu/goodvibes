import { createLocalProviderCommands } from '@goodvibes-jev/engine/terminal-shell/local-provider-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireProviderApi, requireShellPaths, requireSecretsManager } from './runtime-services.ts';

export const { registerLocalProviderRuntimeCommands } = createLocalProviderCommands<CommandContext>(
  { requireProviderApi, requireShellPaths, requireSecretsManager },
  {
    surfaceRoot: 'agent',
    hidden: true,
    confirmMutations: true,
    allowInlineKey: true,
    captureMissingKey: false,
    explicitModelSelection: true,
    codeEditing: false,
    beforeSelection: (_context, _provider, complete) => complete(),
  },
);
