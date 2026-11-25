import type { ConfigKey } from '../../config/schema.js';
import type {
  SandboxConfigSnapshot,
  SandboxBundle,
  SandboxHostStatus,
  SandboxProbe,
  SandboxMcpIsolationMode,
  SandboxPreset,
  SandboxProfile,
  SandboxReview,
  SandboxSession,
  SandboxSessionArtifact,
} from './types.js';
import { probeSandboxBackends } from './backend.js';
import { sandboxAbsolutePaths } from '../../tools/exec/sandbox-config-lists.js';

export interface ConfigManagerLike {
  get(key: string): unknown;
}

function readConfigValue<K extends ConfigKey>(
  manager: ConfigManagerLike,
  key: K,
): unknown {
  return manager.get(key);
}

export function isRunningInWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function getSandboxConfigSnapshot(
  manager: ConfigManagerLike,
): SandboxConfigSnapshot {
  // Unset is the default, disabled; a value saved before `contained` existed (a VM mode) still asks for a boundary.
  const saved = readConfigValue(manager, 'sandbox.mcpIsolation');
  const mcpIsolation: SandboxMcpIsolationMode = saved === undefined || saved === 'disabled' ? 'disabled' : 'contained';
  return Object.freeze({ mcpIsolation });
}

/** Writable paths outside the workspace the owner named (`sandbox.workspaceWritable`). */
export function getSandboxWritableExtras(manager: ConfigManagerLike): readonly string[] {
  return sandboxAbsolutePaths(readConfigValue(manager, 'sandbox.workspaceWritable'));
}

export function detectSandboxHostStatus(): SandboxHostStatus {
  const runningInWsl = isRunningInWsl();
  const windows = process.platform === 'win32';
  const probe = probeSandboxBackends();
  const secureSandboxReady = probe.resolvedBackend === 'bubblewrap';
  const warnings: string[] = [...probe.warnings];
  if (windows) {
    warnings.push('Native Windows has no process boundary; run GoodVibes inside WSL 2 with bubblewrap installed to contain commands and MCP servers.');
  }
  return Object.freeze({
    platform: process.platform,
    runningInWsl,
    windows,
    secureSandboxReady,
    recommendedBackend: probe.resolvedBackend,
    warnings,
  });
}

export function listSandboxProfiles(
  _manager?: ConfigManagerLike,
): SandboxProfile[] {
  const profiles: SandboxProfile[] = [
    {
      id: 'command',
      label: 'Contained commands',
      kind: 'command',
      network: 'disabled',
      notes: ['each command runs in its own boundary', 'network off'],
    },
    {
      id: 'mcp-server',
      label: 'Contained MCP server',
      kind: 'mcp',
      network: 'enabled',
      notes: ['one boundary per stdio server', 'host network shared, since most servers call out'],
    },
  ];
  return profiles.map((profile) => Object.freeze(profile));
}

export function listSandboxPresets(): readonly SandboxPreset[] {
  return [
    Object.freeze({
      id: 'contained',
      label: 'Contained',
      summary: 'Commands and every stdio MCP server run inside a bubblewrap boundary.',
      config: { mcpIsolation: 'contained' },
      notes: ['needs bubblewrap; where it is missing an MCP server is not started and says why'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'host-mcp',
      label: 'Host MCP servers',
      summary: 'Commands run inside the boundary; MCP servers run as host processes.',
      config: { mcpIsolation: 'disabled' },
      notes: ['the default'],
    } satisfies SandboxPreset),
  ] as const;
}

export function getSandboxPreset(id: string): SandboxPreset | null {
  return listSandboxPresets().find((preset) => preset.id === id) ?? null;
}

export function buildSandboxReview(
  manager: ConfigManagerLike,
): SandboxReview {
  return Object.freeze({
    config: getSandboxConfigSnapshot(manager),
    host: detectSandboxHostStatus(),
    profiles: listSandboxProfiles(),
    backendProbe: probeSandboxBackends(),
  });
}

export function renderSandboxReview(
  manager: ConfigManagerLike,
): string {
  const review = buildSandboxReview(manager);
  return [
    'Sandbox Review',
    `  commands: ${manager.get('sandbox.enabled') === false ? 'run on the host (sandbox.enabled is off)' : 'run inside the boundary where this host has one'}`,
    `  mcp servers: ${review.config.mcpIsolation === 'contained' ? 'each inside its own boundary' : 'host processes'} (sandbox.mcpIsolation ${review.config.mcpIsolation})`,
    `  backend: ${review.backendProbe?.resolvedBackend ?? 'host'}`,
    `  platform: ${review.host.platform}${review.host.runningInWsl ? ' (WSL)' : ''}`,
    `  containment: ${review.host.secureSandboxReady ? 'available' : 'unavailable on this host'}`,
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n');
}

export function renderSandboxRecommendation(
  manager: ConfigManagerLike,
): string {
  const review = buildSandboxReview(manager);
  const lines = [
    'Sandbox Recommendation',
    `  current mcp isolation: ${review.config.mcpIsolation}`,
  ];
  if (!review.host.secureSandboxReady) {
    lines.push('  install bubblewrap (Linux, or WSL 2 on Windows) so commands and MCP servers can run contained.');
  } else if (review.config.mcpIsolation === 'disabled') {
    lines.push('  "Run MCP servers inside the sandbox" (Permissions and safety, Sandbox) runs every stdio MCP server inside its own boundary.');
  } else {
    lines.push('  commands and MCP servers are contained.');
  }
  return lines.join('\n');
}

export function renderSandboxProfiles(
  _manager?: ConfigManagerLike,
): string {
  const backend = probeSandboxBackends().resolvedBackend;
  return [
    `Sandbox Profiles (backend: ${backend})`,
    ...listSandboxProfiles().map((profile) => (
      `  ${profile.id}  [${profile.kind}]  network=${profile.network === 'enabled' ? 'shared' : 'off'}  ${profile.label}`
    )),
  ].join('\n');
}

export function renderSandboxPresets(): string {
  return [
    'Sandbox Presets',
    ...listSandboxPresets().map((preset) => (
      `  ${preset.id}  ${preset.label}  mcp=${preset.config.mcpIsolation}  ${preset.summary}`
    )),
  ].join('\n');
}

export function inspectSandboxProbe(probe: SandboxProbe): string {
  return [
    'Sandbox Probe',
    `  checkedAt: ${new Date(probe.checkedAt).toISOString()}`,
    `  host: ${probe.host}`,
    `  backend: ${probe.currentBackend}`,
    `  mcp isolation: ${probe.mcpIsolation}`,
    `  containment: ${probe.secureSandboxReady ? 'ready' : 'not available'}`,
    `  next: ${probe.recommendedCommand}`,
  ].join('\n');
}

export function inspectSandboxBundle(bundle: SandboxBundle): string {
  return [
    'Sandbox Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  reviewText: ${bundle.review.reviewText.length} chars`,
    `  recommendationText: ${bundle.review.recommendationText.length} chars`,
    `  profilesText: ${bundle.review.profilesText.length} chars`,
  ].join('\n');
}

export function renderSandboxSessions(sessions: readonly SandboxSession[]): string {
  return [
    'Sandbox Sessions',
    ...(sessions.length > 0
      ? sessions.flatMap((session) => {
        const lines = [
          `  ${session.id}  ${session.profileId}  ${session.state}  ${session.backend}  ${session.label}${session.startupStatus ? `  startup=${session.startupStatus}` : ''}`,
        ];
        if (session.lastCommandSummary) {
          lines.push(`    last: ${session.lastCommandSummary}`);
        }
        return lines;
      })
      : ['  No active sandbox sessions.']),
  ].join('\n');
}

export function inspectSandboxSessionArtifact(artifact: SandboxSessionArtifact): string {
  return [
    'Sandbox Session Artifact',
    `  exportedAt: ${new Date(artifact.exportedAt).toISOString()}`,
    `  session: ${artifact.session.id}`,
    `  profile: ${artifact.session.profileId}`,
    `  state: ${artifact.session.state}`,
    `  backend: ${artifact.session.backend}`,
    `  startup: ${artifact.session.startupStatus ?? 'n/a'}`,
    `  reviewText: ${artifact.reviewText.length} chars`,
  ].join('\n');
}
