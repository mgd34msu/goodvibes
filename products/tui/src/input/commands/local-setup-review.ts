import { createSetupReviewCollector, type TerminalSetupReviewSnapshot } from '@goodvibes/engine/terminal-shell/setup-review';
import { readRemoteRunnersHealth } from '@goodvibes/engine/terminal-shell/health-command';
import { capabilityBinding } from './capability-binding.ts';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../views/skills-discovery.ts';
import { buildSandboxReview } from '@goodvibes/engine/platform/platform/runtime/sandbox';
import {
  requireHookWorkbench,
  requireProviderApi,
  requireReadModels,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

/**
 * This app's own start as the Health tab's "started" row (startup.review, doctor and services) reads it: the shared setup review plus the
 * terminal app's sandbox facts. (The support folder and the setup moved to another computer are the daemon's:
 * capabilities/builtin/system-bundles.ts.)
 */
export type SetupReviewSnapshot = TerminalSetupReviewSnapshot & {
  readonly sandboxMcpIsolation: string;
  readonly sandboxSecureModeReady: boolean;
};

const collectSetupReview = createSetupReviewCollector<
  CommandContext,
  { sandboxMcpIsolation: string; sandboxSecureModeReady: boolean }
>(
  { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, requireHookWorkbench, discoverSkills,
    // The remote runners are the daemon's (terminal-shell remote-health.ts).
    readRemoteRunners: (context) => readRemoteRunnersHealth(context, capabilityBinding) },
  {
    serviceArea: 'services',
    serviceNoun: 'service',
    emptyServices: 'no services configured',
    extraSnapshot: (context) => ({
      sandboxMcpIsolation: String(context.platform.configManager.get('sandbox.mcpIsolation')),
      sandboxSecureModeReady: buildSandboxReview(context.platform.configManager).host.secureSandboxReady,
    }),
    // Remote runners are optional: none configured is information, not an issue.
    extraChecks: (snapshot) => [
      snapshot.remoteRunnersUnreadable
        ? { severity: 'warn', area: 'remote', message: `the remote runners could not be read: ${snapshot.remoteRunnersUnreadable}` }
        : {
          severity: snapshot.remoteRunnerCount > 0 ? 'pass' : 'info',
          area: 'remote',
          message:
            snapshot.remoteRunnerCount > 0
              ? snapshot.remoteRunnerCount + ' remote runner contract(s) in the daemon'
              : 'no remote runners: none has been started',
        },
      {
        severity: snapshot.sandboxSecureModeReady ? 'pass' : 'info',
        area: 'sandbox',
        message: snapshot.sandboxSecureModeReady
          ? `bubblewrap boundary available; MCP servers: ${snapshot.sandboxMcpIsolation === 'contained' ? 'contained' : 'host processes'}`
          : 'no process boundary on this host (bubblewrap missing or unusable); commands and MCP servers run as host processes',
      },
    ],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  return collectSetupReview(context);
}
