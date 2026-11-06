import { createSubscriptionRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/subscription-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireSubscriptionManager, requireServiceRegistry, requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { formatAgentRecordSource } from '../../agent/record-labels.ts';
export const { registerSubscriptionRuntimeCommands } = createSubscriptionRuntimeCommands<CommandContext>(
  { requireSubscriptionManager, requireServiceRegistry, requireSecretsManager, requireShellPaths },
  {
    hidden: true,
    confirmMutations: true,
    eagerPaths: false,
    openModalOnEmpty: false,
    manualOnly: true,
    bundleWarning: true,
    catchErrors: true,
    surfaceRoot: 'agent',
    formatSource: formatAgentRecordSource,
    error: (error) => (error instanceof Error ? error.message : String(error)),
    present: (message) =>
      message
        .split('\n')
        .map((line) => {
          if (
            (line.includes('Usage: /subscription login') ||
              line.includes('next: /subscription login') ||
              line.includes('Usage: /subscription logout')) &&
            !line.includes('--yes')
          )
            return line + ' --yes';
          return line
            .replace(
              ' start [--no-browser] [--manual]|finish <code-or-url>',
              ' start [--no-browser] --yes|login <provider> finish <code-or-url> --yes',
            )
            .replace('logout <provider>|bundle export <path>', 'logout <provider> --yes|bundle export <path> --yes');
        })
        .join('\n'),
  },
);
