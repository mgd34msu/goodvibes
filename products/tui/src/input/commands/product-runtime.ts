import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import { listInstalledEcosystemEntries, loadEcosystemCatalog } from '@goodvibes/engine/platform/platform/runtime/ecosystem/catalog';
import { discoverTasks } from '@/runtime/index.ts';
import { DEFAULT_TASK_SUITE_DIR } from './eval.ts';
import { requireEcosystemCatalogPaths, requireShellPaths } from './runtime-services.ts';
import { CapabilityRefusal } from '@goodvibes/engine/platform/platform/capabilities';
import { readRemoteRunnersHealth } from '@goodvibes/engine/terminal-shell/health-command';
import { capabilityBinding } from './capability-binding.ts';

interface ReleaseBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly runtime: {
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string;
  };
  /** The tasks in the project's eval task suite (Work and agents, Evaluations). */
  readonly evalSuites: readonly string[];
  readonly incidentCount: number;
  /** The daemon's remote runners; `unreadable` says why they could not be read (never counted as none). */
  readonly remote: {
    readonly pools: number;
    readonly contracts: number;
    readonly artifacts: number;
    readonly unreadable?: string | undefined;
  };
  readonly ecosystem: {
    readonly pluginCatalog: number;
    readonly skillCatalog: number;
    readonly installedPlugins: number;
    readonly installedSkills: number;
  };
}

/** The ids of the tasks in the project's eval task suite; none when there is no suite or it cannot be read. */
function projectEvalTasks(projectRoot: string): string[] {
  const dir = join(projectRoot, DEFAULT_TASK_SUITE_DIR);
  if (!existsSync(dir)) return [];
  try {
    return discoverTasks(dir).map((task) => task.definition.id);
  } catch {
    return [];
  }
}

async function buildReleaseBundle(ctx: CommandContext): Promise<ReleaseBundle> {
  // The remote runners are the daemon's (runtime/remote/daemon-runners.ts), read through this app's binding.
  const remote = await readRemoteRunnersHealth(ctx, capabilityBinding);
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
    evalSuites: projectEvalTasks(requireShellPaths(ctx).workingDirectory),
    incidentCount: incidents.length,
    remote: { pools: remote.pools, contracts: remote.runners.length, artifacts: remote.artifacts, ...(remote.unreadable ? { unreadable: remote.unreadable } : {}) },
    ecosystem: {
      pluginCatalog: loadEcosystemCatalog('plugin', ecosystemPaths).length,
      skillCatalog: loadEcosystemCatalog('skill', ecosystemPaths).length,
      installedPlugins: listInstalledEcosystemEntries('plugin', ecosystemPaths).length,
      installedSkills: listInstalledEcosystemEntries('skill', ecosystemPaths).length,
    },
  };
}

function remoteLine(remote: ReleaseBundle['remote']): string {
  return remote.unreadable
    ? `  remote runners: could not be read (${remote.unreadable})`
    : `  remote runners: ${remote.contracts}, in ${remote.pools} pool${remote.pools === 1 ? '' : 's'}, ${remote.artifacts} handed back`;
}

function inspectReleaseBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReleaseBundle;
  return [
    'Release Bundle Review',
    `  provider/model: ${parsed.runtime.provider || '(unset)'}/${parsed.runtime.model || '(unset)'}`,
    `  eval tasks: ${parsed.evalSuites.length}`,
    `  incidents: ${parsed.incidentCount}`,
    remoteLine(parsed.remote),
    `  ecosystem catalog plugins/skills: ${parsed.ecosystem.pluginCatalog}/${parsed.ecosystem.skillCatalog}`,
  ].join('\n');
}

function formatReleaseBundle(title: string, bundle: ReleaseBundle): string {
  return [
    title,
    `  provider/model: ${bundle.runtime.provider || '(unset)'}/${bundle.runtime.model || '(unset)'}`,
    `  eval tasks: ${bundle.evalSuites.length}`,
    `  failure reports: ${bundle.incidentCount}`,
    remoteLine(bundle.remote),
    `  ecosystem catalog plugins/skills: ${bundle.ecosystem.pluginCatalog}/${bundle.ecosystem.skillCatalog}`,
    `  installed plugins/skills: ${bundle.ecosystem.installedPlugins}/${bundle.ecosystem.installedSkills}`,
  ].join('\n');
}

/**
 * Release readiness of this project from this session, as the System capabilities `release.*` take it
 * (capabilities/builtin/system-program.ts; session-capabilities.ts `systemSessionOf`). No slash command carries them:
 * the System place's Release tab, a model and find reach them.
 */
export function releaseOf(ctx: CommandContext): { review(): Promise<string>; save(path: string, replace: boolean): Promise<string>; read(path: string): string } {
  return {
    review: async () => formatReleaseBundle('Release readiness', await buildReleaseBundle(ctx)),
    async save(path, replace) {
      const targetPath = requireShellPaths(ctx).resolveWorkspacePath(path);
      if (existsSync(targetPath) && !replace) throw new CapabilityRefusal(`${targetPath} already exists; nothing was written. Choose "Write over it" to replace it.`);
      const bundle = await buildReleaseBundle(ctx);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
      return `Saved the release evidence to ${targetPath}.`;
    },
    read(path) {
      try {
        return inspectReleaseBundle(requireShellPaths(ctx).resolveWorkspacePath(path));
      } catch (error) {
        throw new CapabilityRefusal(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
