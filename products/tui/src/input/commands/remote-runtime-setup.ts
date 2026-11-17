import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDefaultAcpAgentCommand } from '@goodvibes-jev/engine/platform/platform/acp';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext } from '../command-registry.ts';
import type { PeerClient, RemoteSessionBundle } from '@/runtime/index.ts';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

type RemoteRegistryLike = Pick<PeerClient['runners'], 'listContracts' | 'exportSessionBundle' | 'importSessionBundle' | 'describeSessionBundleImport'>;

/** The command `/remote dispatch` spawns, or why there is none. */
function acpAgentCommand(): { command: string[] } | { error: string } {
  try { return { command: getDefaultAcpAgentCommand() }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

/** `ACP_AGENT_CMD` as a POSIX shell assignment: a JSON array, so a path with a space survives. */
function acpAgentCommandExport(command: readonly string[]): string {
  return `export ACP_AGENT_CMD='${JSON.stringify(command).replace(/'/g, "'\\''")}'`;
}

type ActiveConnectionLike = {
  agentId: string;
  transportState: string;
  errorCount: number;
  label: string;
};

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
      ? `  importing it replaces: ${replaces.join(', ')} (import asks for --yes)`
      : '  importing it replaces nothing held here',
  ].join('\n');
}

/**
 * `/remote session` and its alias `/teleport`: export, inspect or import a
 * session bundle. Inspect validates exactly as import does and changes
 * nothing; an import that would replace a pool, contract or artifact held
 * here needs --yes.
 */
export async function handleRemoteSessionCommand(
  args: readonly string[],
  ctx: CommandContext,
  remoteRegistry: Pick<RemoteRegistryLike, 'exportSessionBundle' | 'importSessionBundle' | 'describeSessionBundleImport'>,
  command: string,
): Promise<void> {
  const usage = `Usage: ${command} <export|inspect|import> <path> (import: --yes to replace what is held here)`;
  const mode = args[0]?.toLowerCase();
  const pathArg = args.slice(1).find((arg) => arg !== '--yes');
  if (!mode || !pathArg) {
    ctx.print(usage);
    return;
  }
  const targetPath = requireShellPaths(ctx).resolveWorkspacePath(pathArg);
  if (mode === 'export') {
    const exported = await remoteRegistry.exportSessionBundle(targetPath);
    ctx.print(`Exported the remote session bundle for ${exported.bundle.sessionId} to ${exported.path}: ${exported.bundle.pools.length} runner pool(s), ${exported.bundle.contracts.length} runner contract(s) and ${exported.bundle.artifacts.length} artifact(s). It does not hold the conversation.`);
    return;
  }
  if (mode === 'inspect') {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(targetPath, 'utf-8'));
    } catch (error) {
      ctx.print(`Cannot inspect ${targetPath}: ${error instanceof SyntaxError ? 'it is not valid JSON' : summarizeError(error)}. Nothing was changed.`);
      return;
    }
    const described = remoteRegistry.describeSessionBundleImport(value);
    ctx.print(described.ok
      ? inspectRemoteSessionBundle(described.bundle, described.replaces)
      : `Cannot use ${targetPath} as a remote session bundle: ${described.problem}. Nothing was changed; inspect a file written by ${command} export.`);
    return;
  }
  if (mode === 'import') {
    try {
      const bundle = await remoteRegistry.importSessionBundle(targetPath, { replace: args.includes('--yes') });
      ctx.print(`Imported the remote session bundle ${bundle.sessionId}: ${bundle.pools.length} runner pool(s), ${bundle.contracts.length} runner contract(s), ${bundle.artifacts.length} artifact(s).`);
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return;
  }
  ctx.print(usage);
}

export async function handleRemoteSetupCommand(
  args: string[],
  ctx: CommandContext,
  activeConnections: ActiveConnectionLike[],
  remoteRegistry: RemoteRegistryLike,
): Promise<boolean> {
  const subcommand = args[0]?.toLowerCase() ?? 'show';
  if (subcommand === 'setup') {
    const resolved = acpAgentCommand();
    const command = 'command' in resolved ? resolved.command : undefined;
    const danger = ctx.platform.configManager.getCategory('danger');
    const daemonEnabled = resolveDaemonEnabled(ctx.platform.configManager);
    const lines = [
      'Remote Setup Review',
      `  acp agent command: ${command ? JSON.stringify(command) : `none (${'error' in resolved ? resolved.error : ''})`}`,
      `  daemon enabled: ${daemonEnabled ? 'yes' : 'no'}`,
      `  http listener enabled: ${danger.httpListener ? 'yes' : 'no'}`,
      `  remote runner contracts: ${remoteRegistry.listContracts().length}`,
      `  active acp connections: ${activeConnections.length}`,
      '',
      '  guidance:',
      '    - set ACP_AGENT_CMD to a JSON array (program, then arguments) to override the spawned remote agent command',
      '    - use /remote env to export a reusable shell snippet',
      '    - the daemon runs by default (daemon.enabled); enable danger.httpListener only when you actually need that remote surface',
    ];
    if (args[1]?.toLowerCase() === 'export') {
      const pathArg = args[2];
      if (!pathArg) {
        ctx.print('Usage: /remote setup export <path>');
        return true;
      }
      const shellPaths = requireShellPaths(ctx);
      const targetPath = shellPaths.resolveWorkspacePath(pathArg);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify({
        exportedAt: Date.now(),
        acpAgentCommand: command ?? null,
        daemonEnabled,
        httpListenerEnabled: Boolean(danger.httpListener),
        remoteRunnerContracts: remoteRegistry.listContracts().length,
      }, null, 2)}\n`, 'utf-8');
      ctx.print(`Exported remote setup bundle to ${targetPath}`);
      return true;
    }
    ctx.print(lines.join('\n'));
    return true;
  }

  if (subcommand === 'env') {
    const resolved = acpAgentCommand();
    if ('error' in resolved) {
      ctx.print(`Remote Environment\n  ${resolved.error}`);
      return true;
    }
    const shellSnippet = [
      acpAgentCommandExport(resolved.command),
      `export GOODVIBES_REMOTE_SESSION='${ctx.session.runtime.sessionId}'`,
    ].join('\n');
    if (args[1]?.toLowerCase() === 'export') {
      const pathArg = args[2];
      if (!pathArg) {
        ctx.print('Usage: /remote env export <path>');
        return true;
      }
      const shellPaths = requireShellPaths(ctx);
      const targetPath = shellPaths.resolveWorkspacePath(pathArg);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${shellSnippet}\n`, 'utf-8');
      ctx.print(`Exported remote environment snippet to ${targetPath}`);
      return true;
    }
    ctx.print(['Remote Environment', shellSnippet].join('\n'));
    return true;
  }

  if (subcommand === 'tunnel') {
    const mode = args[1]?.toLowerCase() ?? 'review';
    const lines = [
      'Remote Tunnel Review',
      '  transport: self-hosted ACP / daemon relay',
      `  session: ${ctx.session.runtime.sessionId}`,
      `  active remote connections: ${activeConnections.length}`,
      '  guidance: forward ACP agent traffic through your chosen self-hosted tunnel or SSH transport',
    ];
    if (mode === 'export') {
      const pathArg = args[2];
      if (!pathArg) {
        ctx.print('Usage: /remote tunnel export <path>');
        return true;
      }
      const shellPaths = requireShellPaths(ctx);
      const targetPath = shellPaths.resolveWorkspacePath(pathArg);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${lines.join('\n')}\n`, 'utf-8');
      ctx.print(`Exported remote tunnel review to ${targetPath}`);
      return true;
    }
    ctx.print(lines.join('\n'));
    return true;
  }

  if (subcommand === 'bootstrap') {
    const mode = args[1]?.toLowerCase() ?? 'export';
    if (mode === 'inspect') {
      const pathArg = args[2];
      if (!pathArg) {
        ctx.print('Usage: /remote bootstrap inspect <path>');
        return true;
      }
      const shellPaths = requireShellPaths(ctx);
      const targetPath = shellPaths.resolveWorkspacePath(pathArg);
      const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as { sessionId: string; acpAgentCommand: string[]; links: string[] };
      ctx.print([
        'Remote Bootstrap Bundle Review',
        `  session: ${parsed.sessionId}`,
        `  acp agent command: ${JSON.stringify(parsed.acpAgentCommand)}`,
        `  links: ${parsed.links.length}`,
      ].join('\n'));
      return true;
    }
    const pathArg = args[2];
    if (!pathArg || mode !== 'export') {
      ctx.print('Usage: /remote bootstrap export <path> | /remote bootstrap inspect <path>');
      return true;
    }
    const resolved = acpAgentCommand();
    if ('error' in resolved) {
      ctx.print(`Remote bootstrap bundle not exported: ${resolved.error}`);
      return true;
    }
    const payload = {
      exportedAt: Date.now(),
      sessionId: ctx.session.runtime.sessionId,
      acpAgentCommand: resolved.command,
      env: {
        ACP_AGENT_CMD: JSON.stringify(resolved.command),
        GOODVIBES_REMOTE_SESSION: ctx.session.runtime.sessionId,
      },
      links: [
        'goodvibes://open/remote',
        'goodvibes://open/cockpit?target=remote',
      ],
    };
    const shellPaths = requireShellPaths(ctx);
    const targetPath = shellPaths.resolveWorkspacePath(pathArg);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    ctx.print(`Exported remote bootstrap bundle to ${targetPath}`);
    return true;
  }

  if (subcommand === 'session') {
    await handleRemoteSessionCommand(args.slice(1), ctx, remoteRegistry, '/remote session');
    return true;
  }

  return false;
}
