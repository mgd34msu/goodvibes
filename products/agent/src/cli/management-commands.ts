import { createCliSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/cli-secrets-command';
import { createCliWorkspaceCommands } from '@goodvibes-jev/engine/terminal-shell/cli-workspace-commands';
import { createCliSubscriptionView } from '@goodvibes-jev/engine/terminal-shell/cli-subscription-view';
import { withProviderServices, withSessionServices, type OneShotProviderServices, type OneShotSessionServices } from './one-shot-services.ts';
import '@goodvibes-jev/engine/platform/platform/sessions';
import 'node:fs';
import 'node:path';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { credentialWriteScopeWasRelocated, resolveCredentialDeleteScope, resolveCredentialWriteScope } from '../config/credential-scope.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';

import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import { mintAgentDevicePairing } from '../agent/device-pairing.ts';
import type { CliCommandRuntime } from './management.ts';
import { formatAgentRecordSource } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import { appendTemporalLabel } from './temporal-label.ts';
import { createAgentDaemonVerbCaller } from '../runtime/client/daemon-verbs.ts';

/**
 * `goodvibes-agent pair`: mint a named device token on the connected host and
 * print its `#pair=` link and QR. The Agent's own host credential is never printed.
 */
export async function renderPairing(runtime: CliCommandRuntime): Promise<{ readonly output: string; readonly exitCode: number }> {
  const args = runtime.cli.commandArgs;
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  const json = runtime.cli.flags.outputFormat === 'json';
  const outcome = await mintAgentDevicePairing(
    createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory, invokeTimeoutMs: 15_000 }),
    { ...(name === undefined ? {} : { name }), qr: !json },
  );
  if (!outcome.ok) {
    return {
      output: json ? JSON.stringify({ ok: false, kind: 'pairing_failed', error: outcome.error, next: outcome.next }, null, 2) : `${outcome.error}\n  next ${outcome.next}`,
      exitCode: 1,
    };
  }
  return {
    output: json ? JSON.stringify({ ok: true, link: outcome.link, tokenName: outcome.tokenName, tokenId: outcome.tokenId }, null, 2) : outcome.text,
    exitCode: 0,
  };
}

/** The refusal `tasks submit` prints: the Agent's task workflow belongs to the connected host. */
export function taskSubmitRefusal(): { readonly ok: false; readonly kind: 'task_submit_refused'; readonly error: string; readonly next: readonly string[]; readonly text: string } {
  const error = 'GoodVibes Agent blocks CLI task submission from the host-owned task workflow.';
  const next = [
    'do normal assistant work in the main Agent conversation or use `goodvibes-agent run <prompt>` for an explicit one-shot run.',
    'for build/fix/review use `goodvibes-agent delegate <task>` for explicit GoodVibes TUI handoff.',
  ];
  return {
    ok: false, kind: 'task_submit_refused', error, next,
    text: [error, `  policy ${next[0]}`, `  build/fix/review ${next[1]!.replace(/^for build\/fix\/review /, '')}`, '  result no local task was started.'].join('\n'),
  };
}

export const { renderSubscriptions } = createCliSubscriptionView<CliCommandRuntime, OneShotProviderServices>(
  (runtime, fn) => withProviderServices(runtime, fn, { modelData: 'skip' }), {
  inline: false,
  manualOnly: true,
  binary: (runtime) => runtime.cli.binary,
  source: formatAgentRecordSource,
  time: (timestamp) => appendTemporalLabel(new Date(timestamp).toISOString(), timestamp),
});

export const { runSecrets } = createCliSecretsCommand<CliCommandRuntime>({
  createSecrets: (runtime) => createRuntimeSecretsManager({
    projectRoot: runtime.workingDirectory, globalHome: runtime.homeDirectory, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configManager: runtime.configManager, daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
  }),
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
export const { handleSessions, handleTasks } = createCliWorkspaceCommands<CliCommandRuntime, OneShotSessionServices>(withSessionServices, {
  binary: (runtime) => runtime.cli.binary,
  inline: false,
  time: (timestamp) => appendTemporalLabel(new Date(timestamp).toISOString(), timestamp),
  allowSubmit: false,
  verbs: (runtime) => createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory, invokeTimeoutMs: 15_000 }),
  async submit(runtime, _rest) {
    const refusal = taskSubmitRefusal();
    return { output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(refusal, null, 2) : refusal.text, exitCode: 2 };
  },
});
