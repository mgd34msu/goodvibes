import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createSetupReviewCollector } from '@goodvibes/engine/terminal-shell/setup-review';
import { readRemoteRunnersHealth } from '@goodvibes/engine/terminal-shell/health-command';
import { capabilityBinding } from './capability-binding.ts';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../views/skills-discovery.ts';
import {
  buildSandboxReview,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
} from '@goodvibes/engine/platform/platform/runtime/sandbox';
import { VERSION } from '../../version.ts';
import { DEEP_LINK_SURFACES, buildDeepLink } from './deep-link.ts';
import { maskLiteralSecrets, type SetupReviewSnapshot } from './local-setup-transfer.ts';
import {
  requireHookWorkbench,
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
    `  backend: ${review.backendProbe?.resolvedBackend ?? 'host'}`,
    `  commands: ${review.host.secureSandboxReady && ctx.platform.configManager.get('sandbox.enabled') !== false ? 'contained (bubblewrap)' : 'host processes'}`,
    `  mcp servers: ${review.config.mcpIsolation === 'contained' ? (review.host.secureSandboxReady ? 'each in its own boundary' : 'contained requested, not started on this host') : 'host processes'}`,
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
    '',
    '  more: /health check sandbox, /security sandbox-profiles, /security sandbox-sessions',
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
 * service registry and the hooks file the dispatcher loads, with every literal credential masked by
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
    [shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'services.json'), 'services.json'],
    [requireHookWorkbench(ctx).getHooksFilePath(), 'hooks.json'],
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

const textList = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * Reads back a support bundle `/startup support-bundle <dir>` wrote: the files it
 * holds and, from platform-review.json, the install, secure-storage,
 * integration-helper, sandbox and deep-link facts (key names only, as written).
 * Throws when the directory holds no platform review.
 */
export function inspectSetupSupportBundle(targetDir: string): string {
  const reviewPath = join(targetDir, 'platform-review.json');
  if (!existsSync(reviewPath)) throw new Error(`${targetDir} holds no support bundle (no platform-review.json)`);
  const review = asRecord(JSON.parse(readFileSync(reviewPath, 'utf-8')) as unknown);
  const install = asRecord(review['install']);
  const storage = asRecord(review['storage']);
  const helpers = review['integrationHelpers'];
  const sandbox = asRecord(review['sandbox']);
  const indent = (text: unknown): string[] => (typeof text === 'string' && text.trim() ? text.trimEnd().split('\n').map((line) => `    ${line}`) : ['    (not recorded)']);
  const storedKeys = textList(storage['storedKeys']);
  const overridden = textList(storage['overriddenByEnv']);
  let files: string[] = [];
  try { files = readdirSync(targetDir).filter((name) => name.endsWith('.json')).sort(); } catch { files = ['platform-review.json']; }
  return [
    `Support Bundle Review: ${targetDir}`,
    `  files: ${files.join(', ')}`,
    `  install: app ${String(install['appVersion'] ?? 'unknown')}, working directory ${String(install['workingDirectory'] ?? 'unknown')}, ${String(install['profileCount'] ?? 0)} profile(s)`,
    `  secure storage: ${storedKeys.length} stored key(s)${overridden.length > 0 ? `, ${overridden.length} overridden by the environment` : ''}`,
    ...storedKeys.map((key) => `    ${key}${overridden.includes(key) ? ' (environment override)' : ''}`),
    typeof helpers === 'string'
      ? `  integration helpers: ${helpers}`
      : `  integration helpers: ${textList(asRecord(helpers)['apiFamilies']).length} API family(ies), ${textList(asRecord(helpers)['routes']).length} route(s)`,
    '  sandbox review:',
    ...indent(sandbox['review']),
    '  sandbox recommendation:',
    ...indent(sandbox['recommendation']),
    `  deep links: ${textList(review['deepLinks']).length}`,
  ].join('\n');
}

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
