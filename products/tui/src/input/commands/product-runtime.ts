import { createTrustReviewTools } from '@goodvibes-jev/engine/terminal-shell/trust-review';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { listInstalledEcosystemEntries, loadEcosystemCatalog } from '@/runtime/index.ts';
import { BUILTIN_SUITES } from '@/runtime/index.ts';
import { requireEcosystemCatalogPaths, requireReadModels, requireSecretsManager, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';

interface ReleaseBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly runtime: {
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string;
  };
  readonly evalSuites: readonly string[];
  readonly incidentCount: number;
  readonly remote: {
    readonly pools: number;
    readonly contracts: number;
    readonly artifacts: number;
  };
  readonly ecosystem: {
    readonly pluginCatalog: number;
    readonly skillCatalog: number;
    readonly installedPlugins: number;
    readonly installedSkills: number;
  };
}

function buildReleaseBundle(ctx: Parameters<NonNullable<CommandRegistry['register']>>[0]['handler'] extends (args: string[], context: infer C) => unknown ? C : never): ReleaseBundle {
  const remoteRuntime = ctx.ops.remoteRuntime;
  const incidents = ctx.extensions.forensicsRegistry?.getAll() ?? [];
  const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
  return {
    version: 1,
    capturedAt: Date.now(),
    runtime: {
      provider: ctx.session.runtime.provider,
      model: ctx.session.runtime.model,
      sessionId: ctx.session.runtime.sessionId,
    },
    evalSuites: Object.keys(BUILTIN_SUITES),
    incidentCount: incidents.length,
    remote: {
      pools: remoteRuntime?.listPools().length ?? 0,
      contracts: remoteRuntime?.listContracts().length ?? 0,
      artifacts: remoteRuntime?.listArtifacts().length ?? 0,
    },
    ecosystem: {
      pluginCatalog: loadEcosystemCatalog('plugin', ecosystemPaths).length,
      skillCatalog: loadEcosystemCatalog('skill', ecosystemPaths).length,
      installedPlugins: listInstalledEcosystemEntries('plugin', ecosystemPaths).length,
      installedSkills: listInstalledEcosystemEntries('skill', ecosystemPaths).length,
    },
  };
}

function inspectReleaseBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReleaseBundle;
  return [
    'Release Bundle Review',
    `  provider/model: ${parsed.runtime.provider || '(unset)'}/${parsed.runtime.model || '(unset)'}`,
    `  eval suites: ${parsed.evalSuites.length}`,
    `  incidents: ${parsed.incidentCount}`,
    `  remote pools/contracts/artifacts: ${parsed.remote.pools}/${parsed.remote.contracts}/${parsed.remote.artifacts}`,
    `  ecosystem catalog plugins/skills: ${parsed.ecosystem.pluginCatalog}/${parsed.ecosystem.skillCatalog}`,
  ].join('\n');
}

const { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } = createTrustReviewTools<CommandContext>({
 listSecrets: ctx => requireSecretsManager(ctx).list(),
 serviceNames: ctx => Object.keys(requireServiceRegistry(ctx).getAll()),
 security: ctx => requireReadModels(ctx).security.getSnapshot(),
 permissionMode: ctx => ctx.platform.configManager.get('permissions.mode'),
 serviceLabel: 'services',
});

export function registerProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'trust',
    description: 'Review trust posture, set this workspace\'s trust level, or export trust bundles',
    usage: '[review|workspace [trusted|restricted]|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'review';
      if (sub === 'workspace') {
        const manager = ctx.workspace.workspaceTrustManager;
        if (!manager) {
          ctx.print('Workspace trust is unavailable in this context.');
          return;
        }
        const choice = (args[1] ?? '').toLowerCase();
        if (choice === 'trusted' || choice === 'trust' || choice === 'full' || choice === 'yes') {
          await manager.setLevel('trusted');
          ctx.print('This workspace is now TRUSTED; all tools may run, subject to your permission settings.');
          ctx.renderRequest();
          return;
        }
        if (choice === 'restricted' || choice === 'restrict' || choice === 'readonly' || choice === 'read-only' || choice === 'no') {
          await manager.setLevel('restricted');
          ctx.print('This workspace is now RESTRICTED; read-only exploration; write/execute/delegate tools are denied until you run `/trust workspace trusted`.');
          ctx.renderRequest();
          return;
        }
        if (choice && choice !== 'status' && choice !== 'show') {
          ctx.print(`Unknown workspace trust option "${args[1]}". Usage: /trust workspace [trusted|restricted]`);
          return;
        }
        const level = manager.getLevel();
        const lines = [
          `Workspace trust: ${level.toUpperCase()}` +
            (manager.wasGrandfathered() ? ' (grandfathered from prior GoodVibes state)' : ''),
          level === 'trusted'
            ? 'All tools may run, subject to your normal permission settings.'
            : 'Read-only exploration: write, execute, and delegate tools are denied until you trust this workspace.',
        ];
        if (!manager.isDecided()) lines.push('Not yet decided: run `/trust workspace trusted` to enable full capability.');
        const registrationManager = ctx.workspace.workspaceRegistrationManager;
        if (registrationManager) {
          lines.push(`Registration: ${await registrationManager.describe()}`);
        }
        lines.push('Change with:  /trust workspace trusted   |   /trust workspace restricted');
        ctx.print(lines.join('\n'));
        return;
      }
      const shellPaths = requireShellPaths(ctx);
      if (sub === 'review') {
        const bundle = await buildTrustReviewBundle(ctx);
        ctx.print(formatTrustReview(bundle));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /trust bundle ${mode} <path>`);
          return;
        }
        if (mode === 'export') {
          const bundle = await buildTrustReviewBundle(ctx);
          const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Trust bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          ctx.print(inspectTrustBundle(shellPaths.resolveWorkspacePath(pathArg!)));
          return;
        }
      }
      ctx.print('Usage: /trust [review|bundle export <path>|bundle inspect <path>]');
    },
  });
  registry.register({
    name: 'bridge',
    description: 'Review and operate self-hosted bridge and remote runner flows',
    usage: '[status|pools|assign <pool> <runner>|runner <id>|review <artifactId>|export <artifactId> [path]|import <path>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      if (!ctx.ops.remoteRuntime) {
        ctx.print('Remote runner registry is not available in this runtime.');
        return;
      }
      const remoteRegistry = ctx.ops.remoteRuntime;
      const sub = args[0] ?? 'status';
      if (sub === 'status') {
        const remote = requireReadModels(ctx).remote.getSnapshot();
        ctx.print([
          'Bridge Status',
          `  remote pools: ${remote.pools.length}`,
          `  runner contracts: ${remote.contracts.length}`,
          `  review artifacts: ${remote.artifacts.length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'pools') {
        const pools = remoteRegistry.listPools();
        ctx.print(pools.length > 0
          ? ['Bridge Pools', ...pools.map((pool) => `  ${pool.id}  runners=${pool.runnerIds.length}  trust=${pool.trustClass}`)].join('\n')
          : 'Bridge Pools\n  No runner pools registered yet.');
        return;
      }
      if (sub === 'assign') {
        const poolId = args[1];
        const runnerId = args[2];
        if (!poolId || !runnerId) {
          ctx.print('Usage: /bridge assign <pool> <runner>');
          return;
        }
        const pool = remoteRegistry.assignRunnerToPool(poolId, runnerId);
        if (!pool) {
          ctx.print(`Unable to assign runner ${runnerId} to pool ${poolId}.`);
          return;
        }
        ctx.print(`Assigned runner ${runnerId} to bridge pool ${poolId}.`);
        return;
      }
      if (sub === 'runner') {
        const runnerId = args[1];
        if (!runnerId) {
          ctx.print('Usage: /bridge runner <id>');
          return;
        }
        const contract = remoteRegistry.getContract(runnerId);
        if (!contract) {
          ctx.print(`Unknown runner contract: ${runnerId}`);
          return;
        }
        ctx.print([
          `Bridge Runner ${runnerId}`,
          `  template: ${contract.template}`,
          `  trustClass: ${contract.trustClass}`,
          `  transport: ${contract.sourceTransport}/${contract.transport.state}`,
          `  tools: ${contract.capabilityCeiling.allowedTools.join(', ') || '(none)'}`,
          `  pool: ${contract.poolId ?? '(unassigned)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'review') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /bridge review <artifactId>');
          return;
        }
        const summary = remoteRegistry.buildReviewSummary(artifactId);
        ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
        return;
      }
      if (sub === 'export') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /bridge export <artifactId> [path]');
          return;
        }
        const exported = await remoteRegistry.exportArtifact(
          artifactId,
          args[2] ? shellPaths.resolveWorkspacePath(args[2]) : undefined,
        );
        if (!exported) {
          ctx.print(`Unknown remote artifact: ${artifactId}`);
          return;
        }
        ctx.print(`Exported remote bridge artifact to ${exported.path}`);
        return;
      }
      if (sub === 'import') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /bridge import <path>');
          return;
        }
        const artifact = await remoteRegistry.importArtifact(shellPaths.resolveWorkspacePath(pathArg));
        ctx.print(`Imported remote bridge artifact ${artifact.id} for runner ${artifact.runnerId}.`);
        return;
      }
      ctx.print('Usage: /bridge [status|pools|assign <pool> <runner>|runner <id>|review <artifactId>|export <artifactId> [path]|import <path>]');
    },
  });

  registry.register({
    name: 'release',
    description: 'Package certification and release-readiness operations',
    usage: '[review|checklist|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      if (sub === 'review') {
        const bundle = buildReleaseBundle(ctx);
        ctx.print([
          'Release Review',
          `  provider/model: ${bundle.runtime.provider || '(unset)'}/${bundle.runtime.model || '(unset)'}`,
          `  eval suites: ${bundle.evalSuites.length}`,
          `  incidents: ${bundle.incidentCount}`,
          `  remote pools/contracts/artifacts: ${bundle.remote.pools}/${bundle.remote.contracts}/${bundle.remote.artifacts}`,
          `  ecosystem catalog plugins/skills: ${bundle.ecosystem.pluginCatalog}/${bundle.ecosystem.skillCatalog}`,
          `  installed plugins/skills: ${bundle.ecosystem.installedPlugins}/${bundle.ecosystem.installedSkills}`,
        ].join('\n'));
        return;
      }
      if (sub === 'checklist') {
        ctx.print([
          'Release Checklist',
          '  1. Run /setup review and /setup doctor',
          '  2. Run /security review and /trust review',
          '  3. Run /policy preflight and /policy simulate',
          '  4. Run /eval gate <suite> for required certification suites',
          '  5. Review /incident latest and /bridge status',
          '  6. Export /release bundle export <path> for release evidence',
        ].join('\n'));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /release bundle ${mode} <path>`);
          return;
        }
        if (mode === 'export') {
          const bundle = buildReleaseBundle(ctx);
          const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Release bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          ctx.print(inspectReleaseBundle(shellPaths.resolveWorkspacePath(pathArg!)));
          return;
        }
      }
      ctx.print('Usage: /release [review|checklist|bundle export <path>|bundle inspect <path>]');
    },
  });
}
