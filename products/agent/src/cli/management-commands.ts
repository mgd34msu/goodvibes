import { createCliSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/cli-secrets-command';
import { createCliWorkspaceCommands } from '@goodvibes-jev/engine/terminal-shell/cli-workspace-commands';
import { createCliSubscriptionView } from '@goodvibes-jev/engine/terminal-shell/cli-subscription-view';
import type { RuntimeServices } from '../runtime/services.ts';
import '@goodvibes-jev/engine/platform/platform/sessions';
import 'node:fs';
import 'node:path';
import { SecretsManager } from '../config/secrets.ts';
import { credentialWriteScopeWasRelocated, resolveCredentialDeleteScope, resolveCredentialWriteScope } from '../config/credential-scope.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';

import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import { buildCompanionConnectionInfo, encodeConnectionPayload, formatConnectionBlock } from '@goodvibes-jev/engine/platform/platform/pairing';
import { generateQrMatrix, renderQrToString } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { CliCommandRuntime } from './management.ts';
import { urlHostForBindHost, withRuntimeServices } from './management.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import { connectedHostTokenRequiredMessage, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { formatAgentRecordSource } from '../agent/record-labels.ts';
import { appendTemporalLabel } from './temporal-label.ts';

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  const tokenRecord = readConnectedHostOperatorToken(runtime.homeDirectory);
  if (!tokenRecord.token) return connectedHostTokenRequiredMessage(tokenRecord.path);
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const connectedHostUrl = `http://${urlHostForBindHost(binding.host)}:${binding.port}`;
  const info = buildCompanionConnectionInfo({
    daemonUrl: connectedHostUrl,
    token: tokenRecord.token,
    username: 'admin',
    surface: GOODVIBES_AGENT_PAIRING_SURFACE,
  });
  const payload = encodeConnectionPayload(info);
  const qr = renderQrToString(generateQrMatrix(payload));
  return [formatConnectionBlock(info, payload), '', qr].join('\n');
}

export const { renderSubscriptions } = createCliSubscriptionView<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  inline: false,
  manualOnly: true,
  binary: (runtime) => runtime.cli.binary,
  source: formatAgentRecordSource,
  time: (timestamp) => appendTemporalLabel(new Date(timestamp).toISOString(), timestamp),
});

export const { handleSecrets } = createCliSecretsCommand<CliCommandRuntime>({
  createSecrets: (runtime) =>
    new SecretsManager({ projectRoot: runtime.workingDirectory, globalHome: runtime.homeDirectory, configManager: runtime.configManager }),
  binary: (runtime) => runtime.cli.binary,
  inline: false,
  writeScope: resolveCredentialWriteScope,
  deleteScope: resolveCredentialDeleteScope,
  relocation: (key, requested) =>
    credentialWriteScopeWasRelocated(key, requested)
      ? [
          '  note filed in the daemon tier instead of ' +
            requested +
            ', the daemon is what reads this credential, and it reads only its own tier',
        ]
      : [],
});
export const { handleSessions, handleTasks } = createCliWorkspaceCommands<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  binary: (runtime) => runtime.cli.binary,
  inline: false,
  time: (timestamp) => appendTemporalLabel(new Date(timestamp).toISOString(), timestamp),
  allowSubmit: false,
  emptyTasks: 'GoodVibes tasks\n  No connected-host tasks are currently recorded.',
  async submit(_runtime, _rest) {
    return [
      'GoodVibes Agent blocks CLI task submission from the host-owned task workflow.',
      '  policy do normal assistant work in the main Agent conversation or use `goodvibes-agent run <prompt>` for an explicit one-shot run.',
      '  build/fix/review use `goodvibes-agent delegate <task>` for explicit GoodVibes TUI handoff.',
      '  result no local task was started.',
    ].join('\n');
  },
});
