import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDefaultAcpAgentCommand } from '@goodvibes-jev/engine/platform/platform/acp';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext, RemoteCommandService } from '../command-registry.ts';
import type { RemoteSessionBundle } from '@/runtime/index.ts';
import { requireShellPaths } from './runtime-services.ts';

type RemoteRegistryLike = Pick<RemoteCommandService, 'listContracts' | 'exportSessionBundle' | 'importSessionBundle'>;

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
  messageCount: number;
  errorCount: number;
  label: string;
};

export function inspectRemoteSessionBundle(bundle: RemoteSessionBundle): string {
  return [
    'Remote Session Bundle Review',
    `  session: ${bundle.sessionId}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  active connections: ${bundle.activeConnectionIds.length}`,
    `  pools: ${bundle.pools.length}`,
    `  contracts: ${bundle.contracts.length}`,
    `  artifacts: ${bundle.artifacts.length}`,
  ].join('\n');
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
    const mode = args[1]?.toLowerCase();
    const pathArg = args[2];
    if (!mode || !pathArg) {
      ctx.print('Usage: /remote session <export|inspect|import> <path>');
      return true;
    }
    const shellPaths = requireShellPaths(ctx);
    const targetPath = shellPaths.resolveWorkspacePath(pathArg);
    if (mode === 'export') {
      const exported = await remoteRegistry.exportSessionBundle(targetPath);
      ctx.print(`Exported remote session bundle ${exported.bundle.sessionId} to ${exported.path}`);
      return true;
    }
    if (mode === 'inspect') {
      const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as RemoteSessionBundle;
      ctx.print(inspectRemoteSessionBundle(bundle));
      return true;
    }
    if (mode === 'import') {
      const bundle = await remoteRegistry.importSessionBundle(targetPath);
      ctx.print(`Imported remote session bundle ${bundle.sessionId} with ${bundle.contracts.length} contracts.`);
      return true;
    }
    ctx.print('Usage: /remote session <export|inspect|import> <path>');
    return true;
  }

  return false;
}
