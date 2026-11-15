import { createSetupReviewCollector } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../views/skills-discovery.ts';
import {
  buildSandboxReview,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
} from '@goodvibes-jev/engine/platform/platform/runtime/sandbox';
import '@goodvibes-jev/engine/platform/platform/plugins';
import '@goodvibes-jev/engine/platform/platform/config';
import { VERSION } from '../../version.ts';
import { DEEP_LINK_SURFACES, buildDeepLink } from './deep-link.ts';
import { maskLiteralSecrets, type SetupReviewSnapshot } from './local-setup-transfer.ts';
import {
  requireProfileManager,
  requireProviderApi,
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

export function renderSetupSandboxReview(ctx: CommandContext): string {
  const review = buildSandboxReview(ctx.platform.configManager);
  return [
    'Setup Sandbox Review',
    `  backend: ${review.backendProbe?.resolvedBackend ?? review.config.vmBackend}`,
    // The isolation settings (repl, mcp) refuse nothing yet, so they are not listed as protection here.
    '  isolation: MCP servers and evaluation runtimes run as separate host processes; no VM guest',
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
    '',
    '  next:',
    '    /sandbox doctor',
    '    /sandbox profiles',
    '    /sandbox session list',
  ].join('\n');
}

/**
 * The install, secure-storage, integration-helper, sandbox and deep-link facts a
 * support thread asks for, in one record. Key names only: no stored value is read.
 */
async function buildPlatformReview(ctx: CommandContext): Promise<Record<string, unknown>> {
  const shellPaths = requireShellPaths(ctx);
  const records = await requireSecretsManager(ctx).listDetailed();
  const stored = records.filter((record) => record.source !== 'env');
  const helpers = ctx.extensions.integrationHelpers?.buildReview();
  const config = ctx.platform.configManager;
  return {
    install: {
      appVersion: VERSION,
      workingDirectory: shellPaths.workingDirectory,
      homeDirectory: shellPaths.homeDirectory,
      profileCount: requireProfileManager(ctx).list().length,
    },
    storage: {
      storedKeys: [...new Set(stored.map((record) => record.key))],
      overriddenByEnv: [...new Set(stored.filter((record) => record.overriddenByEnv).map((record) => record.key))],
    },
    integrationHelpers: helpers ? { apiFamilies: helpers.apiFamilies, routes: helpers.routes } : 'unavailable in this runtime',
    sandbox: {
      review: renderSandboxReview(config),
      recommendation: renderSandboxRecommendation(config),
      profiles: renderSandboxProfiles(config),
    },
    deepLinks: DEEP_LINK_SURFACES.map((surface) => buildDeepLink(surface)),
  };
}

/**
 * Writes a bundle for a support thread: the startup review, the platform review
 * (install, storage key names, integration helpers, sandbox, deep links), and the
 * service registry and managed hooks, with every literal credential masked by
 * the shared redaction rule. Returns the directory and how many values were masked.
 */
export async function exportSetupSupportBundle(targetDirArg: string, snapshot: SetupReviewSnapshot, ctx: CommandContext): Promise<{ readonly targetDir: string; readonly masked: number }> {
  const shellPaths = requireShellPaths(ctx);
  const targetDir = shellPaths.resolveWorkspacePath(targetDirArg);
  const platformReview = await buildPlatformReview(ctx);
  mkdirSync(targetDir, { recursive: true });
  const masked: string[] = [];
  writeFileSync(join(targetDir, 'startup-review.json'), JSON.stringify(maskLiteralSecrets(snapshot, masked), null, 2) + '\n', 'utf-8');
  writeFileSync(join(targetDir, 'platform-review.json'), JSON.stringify(maskLiteralSecrets(platformReview, masked, 'platform-review.json'), null, 2) + '\n', 'utf-8');
  const copies: ReadonlyArray<readonly [string, string]> = [
    [shellPaths.resolveProjectPath('tui', 'services.json'), 'services.json'],
    [shellPaths.resolveProjectPath('hooks.managed.json'), 'hooks.managed.json'],
  ];
  for (const [source, name] of copies) {
    if (!existsSync(source)) continue;
    const text = readFileSync(source, 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { unreadable: `${name} is not valid JSON; its text is not included.` }; }
    writeFileSync(join(targetDir, name), JSON.stringify(maskLiteralSecrets(parsed, masked, name), null, 2) + '\n', 'utf-8');
  }
  return { targetDir, masked: masked.length };
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
        message: 'local backend: separate host processes; no VM guest',
      },
    ],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  return collectSetupReview(context);
}
