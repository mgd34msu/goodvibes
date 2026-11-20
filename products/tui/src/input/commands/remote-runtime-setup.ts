import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDefaultAcpAgentCommand } from '@goodvibes/engine/platform/platform/acp';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { CommandContext } from '../command-registry.ts';
import type { PeerClient, RemoteSessionBundle } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

/**
 * What another machine needs to run this session's remote agents (the setup,
 * the environment, tunnel guidance, a start-up bundle), and session bundles of
 * runners: the pieces `/remote`'s actions (remote-runtime.ts) show and write.
 */

type SessionBundleRegistry = Pick<PeerClient['runners'], 'exportSessionBundle' | 'importSessionBundle' | 'describeSessionBundleImport'>;

/** The command `/remote dispatch` spawns, or why there is none. */
function acpAgentCommand(): { command: string[] } | { error: string } {
  try { return { command: getDefaultAcpAgentCommand() }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

/** `ACP_AGENT_CMD` as a POSIX shell assignment: a JSON array, so a path with a space survives. */
function acpAgentCommandExport(command: readonly string[]): string {
  return `export ACP_AGENT_CMD='${JSON.stringify(command).replace(/'/g, "'\\''")}'`;
}

/** Write a file in the project, making its folder. */
export function exportRemoteFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

/** What a session bundle holds, and what importing it here would replace. */
export function inspectRemoteSessionBundle(bundle: RemoteSessionBundle, replaces: readonly string[] = []): string {
  const exportedAt = typeof bundle.exportedAt === 'number' && Number.isFinite(bundle.exportedAt) ? new Date(bundle.exportedAt).toISOString() : 'unknown';
  return [
    'Remote Session Bundle Review',
    `  session: ${typeof bundle.sessionId === 'string' ? bundle.sessionId : 'unknown'}`,
    `  exportedAt: ${exportedAt}`,
    `  active connections: ${Array.isArray(bundle.activeConnectionIds) ? bundle.activeConnectionIds.length : 0}`,
    `  pools: ${bundle.pools.length}`,
    `  contracts: ${bundle.contracts.length}`,
    `  artifacts: ${bundle.artifacts.length}`,
    '  holds runner pools, runner contracts and artifacts; it does not hold the conversation',
    replaces.length > 0
      ? `  bringing it in replaces: ${replaces.join(', ')}`
      : '  bringing it in replaces nothing held here',
  ].join('\n');
}

/** Export, inspect or import a session bundle of runners. Inspect validates exactly as import does and changes nothing. */
export async function runRemoteSessionBundle(mode: 'export' | 'inspect' | 'import', targetPath: string, registry: SessionBundleRegistry): Promise<string> {
  if (mode === 'export') {
    const exported = await registry.exportSessionBundle(targetPath);
    return `Saved the remote session bundle for ${exported.bundle.sessionId} to ${exported.path}: ${exported.bundle.pools.length} runner pool(s), ${exported.bundle.contracts.length} runner contract(s) and ${exported.bundle.artifacts.length} artifact(s). It does not hold the conversation.`;
  }
  if (mode === 'inspect') {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(targetPath, 'utf-8'));
    } catch (error) {
      throw commandRefusal(`Cannot inspect ${targetPath}: ${error instanceof SyntaxError ? 'it is not valid JSON' : summarizeError(error)}. Nothing was changed.`);
    }
    const described = registry.describeSessionBundleImport(value);
    if (!described.ok) throw commandRefusal(`Cannot use ${targetPath} as a remote session bundle: ${described.problem}. Nothing was changed.`, 'Inspect a file written by /remote session-export.');
    return inspectRemoteSessionBundle(described.bundle, described.replaces);
  }
  try {
    const bundle = await registry.importSessionBundle(targetPath, { replace: true });
    return `Brought in the remote session bundle ${bundle.sessionId}: ${bundle.pools.length} runner pool(s), ${bundle.contracts.length} runner contract(s), ${bundle.artifacts.length} artifact(s).`;
  } catch (error) {
    throw commandRefusal(summarizeError(error));
  }
}

export function remoteSetupPayload(ctx: CommandContext, contracts: number): Record<string, unknown> {
  const resolved = acpAgentCommand();
  return {
    exportedAt: Date.now(),
    acpAgentCommand: 'command' in resolved ? resolved.command : null,
    daemonEnabled: resolveDaemonEnabled(ctx.platform.configManager),
    httpListenerEnabled: Boolean(ctx.platform.configManager.getCategory('danger').httpListener),
    remoteRunnerContracts: contracts,
  };
}

export function remoteSetupLines(ctx: CommandContext, connections: number, contracts: number): string[] {
  const resolved = acpAgentCommand();
  const command = 'command' in resolved ? resolved.command : undefined;
  return [
    'Remote Setup Review',
    `  acp agent command: ${command ? JSON.stringify(command) : `none (${'error' in resolved ? resolved.error : ''})`}`,
    `  daemon enabled: ${resolveDaemonEnabled(ctx.platform.configManager) ? 'yes' : 'no'}`,
    `  http listener enabled: ${ctx.platform.configManager.getCategory('danger').httpListener ? 'yes' : 'no'}`,
    `  remote runner contracts: ${contracts}`,
    `  active acp connections: ${connections}`,
    '',
    '  guidance:',
    '    - set ACP_AGENT_CMD to a JSON array (program, then arguments) to override the spawned remote agent command',
    '    - /remote env shows a reusable shell snippet; /remote env-export saves it',
    '    - the daemon runs by default (daemon.enabled); enable danger.httpListener only when you actually need that remote surface',
  ];
}

export function remoteEnvSnippet(ctx: CommandContext): string {
  const resolved = acpAgentCommand();
  if ('error' in resolved) throw commandRefusal(`No remote agent command: ${resolved.error}`);
  return [acpAgentCommandExport(resolved.command), `export GOODVIBES_REMOTE_SESSION='${ctx.session.runtime.sessionId}'`].join('\n');
}

export function remoteTunnelLines(ctx: CommandContext, connections: number): string[] {
  return [
    'Remote Tunnel Review',
    '  transport: self-hosted ACP / daemon relay',
    `  session: ${ctx.session.runtime.sessionId}`,
    `  active remote connections: ${connections}`,
    '  guidance: forward ACP agent traffic through your chosen self-hosted tunnel or SSH transport',
  ];
}

export function exportRemoteBootstrap(ctx: CommandContext, targetPath: string): string {
  const resolved = acpAgentCommand();
  if ('error' in resolved) throw commandRefusal(`Start-up bundle not saved: ${resolved.error}`);
  const payload = {
    exportedAt: Date.now(),
    sessionId: ctx.session.runtime.sessionId,
    acpAgentCommand: resolved.command,
    env: {
      ACP_AGENT_CMD: JSON.stringify(resolved.command),
      GOODVIBES_REMOTE_SESSION: ctx.session.runtime.sessionId,
    },
    links: ['goodvibes://open/remote', 'goodvibes://open/cockpit?target=remote'],
  };
  exportRemoteFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
  return `Saved the start-up bundle to ${targetPath}`;
}

export function inspectRemoteBootstrap(targetPath: string): string {
  let parsed: { sessionId?: unknown; acpAgentCommand?: unknown; links?: unknown };
  try {
    parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as typeof parsed;
  } catch (error) {
    throw commandRefusal(`Cannot inspect ${targetPath}: ${error instanceof SyntaxError ? 'it is not valid JSON' : summarizeError(error)}.`);
  }
  return [
    'Remote Start-up Bundle',
    `  session: ${typeof parsed.sessionId === 'string' ? parsed.sessionId : 'unknown'}`,
    `  acp agent command: ${JSON.stringify(parsed.acpAgentCommand ?? null)}`,
    `  links: ${Array.isArray(parsed.links) ? parsed.links.length : 0}`,
  ].join('\n');
}
