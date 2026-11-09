import { createSetupReviewCollector } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../views/skills-discovery.ts';
import { buildSandboxReview } from '@goodvibes-jev/engine/platform/platform/runtime/sandbox';
import '@goodvibes-jev/engine/platform/platform/plugins';
import '@goodvibes-jev/engine/platform/platform/config';
import type { SetupReviewSnapshot } from './local-setup-transfer.ts';
import {
  requireProviderApi,
  requireReadModels,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

export function renderSetupSandboxReview(ctx: CommandContext, snapshot: SetupReviewSnapshot): string {
  const review = buildSandboxReview(ctx.platform.configManager);
  return [
    'Setup Sandbox Review',
    `  backend: ${review.backendProbe?.resolvedBackend ?? review.config.vmBackend}`,
    `  repl isolation: ${snapshot.sandboxReplIsolation}`,
    `  mcp isolation: ${snapshot.sandboxMcpIsolation}`,
    `  host secure mode readiness: ${snapshot.sandboxSecureModeReady ? 'yes' : 'no'}`,
    '  execution: host-local processes; no VM guest',
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
    '',
    '  next:',
    '    /sandbox doctor',
    '    /sandbox profiles',
    '    /sandbox session list',
  ].join('\n');
}

export function exportSetupSupportBundle(targetDirArg: string, snapshot: SetupReviewSnapshot, ctx: CommandContext): string {
  const shellPaths = requireShellPaths(ctx);
  const targetDir = shellPaths.resolveWorkspacePath(targetDirArg);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'startup-review.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  const servicesPath = shellPaths.resolveProjectPath('tui', 'services.json');
  if (existsSync(servicesPath)) {
    writeFileSync(join(targetDir, 'services.json'), readFileSync(servicesPath, 'utf-8'), 'utf-8');
  }
  const hooksPath = shellPaths.resolveProjectPath('hooks.managed.json');
  if (existsSync(hooksPath)) {
    writeFileSync(join(targetDir, 'hooks.managed.json'), readFileSync(hooksPath, 'utf-8'), 'utf-8');
  }
  return targetDir;
}

const collectSetupReview = createSetupReviewCollector<
  CommandContext,
  { sandboxReplIsolation: string; sandboxMcpIsolation: string; sandboxSecureModeReady: boolean }
>(
  { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, discoverSkills },
  {
    serviceArea: 'services',
    serviceNoun: 'service',
    emptyServices: 'no services configured',
    extraSnapshot: (context) => ({
      sandboxReplIsolation: String(context.platform.configManager.get('sandbox.replIsolation')),
      sandboxMcpIsolation: String(context.platform.configManager.get('sandbox.mcpIsolation')),
      sandboxSecureModeReady: buildSandboxReview(context.platform.configManager).host.secureSandboxReady,
    }),
    extraIssues: (snapshot) => [
      {
        severity: snapshot.managedHookCount > 0 || snapshot.managedHookChainCount > 0 ? 'pass' : 'warn',
        area: 'hooks',
        message: snapshot.managedHookCount + ' managed hook(s), ' + snapshot.managedHookChainCount + ' chain(s)',
      },
      {
        severity: snapshot.remoteRunnerCount > 0 ? 'pass' : 'warn',
        area: 'remote',
        message:
          snapshot.remoteRunnerCount > 0
            ? snapshot.remoteRunnerCount + ' remote runner contract(s)'
            : 'no remote runner contracts registered',
      },
      {
        severity: 'pass',
        area: 'sandbox',
        message: 'local backend: REPL=' + snapshot.sandboxReplIsolation + ', MCP=' + snapshot.sandboxMcpIsolation + '; no VM guest',
      },
    ],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  return collectSetupReview(context);
}
