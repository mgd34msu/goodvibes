import { createLocalProviderCommands } from '@goodvibes-jev/engine/terminal-shell/local-provider-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireProviderApi, requireShellPaths, requireSecretsManager } from './runtime-services.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
export const { registerLocalProviderRuntimeCommands } = createLocalProviderCommands<CommandContext>(
  { requireProviderApi, requireShellPaths, requireSecretsManager },
  {
    surfaceRoot: 'tui',
    hidden: false,
    confirmMutations: false,
    allowInlineKey: false,
    captureMissingKey: true,
    explicitModelSelection: false,
    codeEditing: true,
    beforeSelection: ensureProviderKeyThenSelect,
  },
);
