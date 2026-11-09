import { createSubscriptionRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/subscription-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireSubscriptionManager, requireServiceRegistry, requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
export const { registerSubscriptionRuntimeCommands } = createSubscriptionRuntimeCommands<CommandContext>(
  { requireSubscriptionManager, requireServiceRegistry, requireSecretsManager, requireShellPaths },
  {
    hidden: false,
    confirmMutations: false,
    eagerPaths: true,
    openModalOnEmpty: true,
    manualOnly: false,
    bundleWarning: false,
    catchErrors: false,
    surfaceRoot: 'tui',
    formatSource: (source) => source,
    error: summarizeError,
    present: (message) => message,
  },
);
