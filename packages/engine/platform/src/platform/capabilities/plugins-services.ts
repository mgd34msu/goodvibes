/**
 * The daemon's plugin services (capabilities/builtin/plugins.ts): the plugins
 * of the caller's project, over the one plugin state file (`~/.goodvibes/tui/
 * plugins.json`, which every program reads) and the shared trust file.
 *
 * For the daemon's own folder its live plugin manager is used, so a plugin
 * switched on starts in the daemon at once. For another project a manager of
 * that project (its own `.goodvibes/plugins` and the user's) reads and writes
 * the same files and starts nothing: the program running turns there starts
 * or stops the plugin itself. A few projects are kept at most.
 */
import { join } from 'node:path';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { PluginManager } from '../plugins/manager.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';
import { DAEMON_STATE_SURFACE_ROOT } from '../daemon/lifecycle-marker.js';
import type { PluginManagingControls, PluginProject, PluginsCapabilityServices } from './builtin/plugins.js';
import type { MarketplaceCapabilityServices } from './builtin/marketplace.js';
import { requireCallerProject } from './caller-project.js';
import { logger, summarizeError } from '../utils/index.js';

export interface PluginServiceSources {
  readonly configManager: { getWorkingDirectory(): string | null | undefined };
  /** The daemon's own plugin manager: its folder's plugins, running. */
  readonly pluginManager?: PluginManagingControls | undefined;
  readonly homeDirectory?: string | undefined;
}

/** The terminal programs' local curated catalog folder (the marketplace installs from it). */
const CATALOG_SURFACE = 'tui';

/** The local curated catalog and the install folders of a project, as the marketplace and the plugins read them. */
function catalogOf(cwd: string, homeDir: string) {
  return {
    cwd, homeDir,
    projectCatalogRoot: join(cwd, '.goodvibes', CATALOG_SURFACE, 'ecosystem'),
    userCatalogRoot: join(homeDir, '.goodvibes', CATALOG_SURFACE, 'ecosystem'),
  };
}

/**
 * A project's plugin manager whose switching on and off reaches the daemon's own running plugins too: the state file
 * is the one every program reads, so a plugin the daemon can load (one in the user's plugin folder) is started or
 * stopped in the daemon at once, as the programs start or stop it, and what it brings (a media provider, a tool) is
 * there with no restart. A plugin only that project has is not the daemon's to start.
 */
function alsoInDaemon(manager: PluginManagingControls, daemon: PluginManagingControls | undefined): PluginManagingControls {
  if (!daemon) return manager;
  const inDaemon = (name: string) => {
    try { return daemon.list().find((plugin) => plugin.name === name); } catch { return undefined; }
  };
  return Object.assign(Object.create(manager) as PluginManagingControls, {
    list: () => manager.list(),
    enable: async (name: string) => {
      const result = await manager.enable(name);
      // Switched on in the one state file: the daemon starts its own copy now when it has one and it is not running.
      const known = inDaemon(name);
      if (result.ok && known && !known.active && !known.quarantined) {
        try {
          const started = await daemon.enable(name);
          if (!started.ok) logger.warn('[plugins] the daemon did not start a plugin switched on in a project', { plugin: name, error: started.error });
        } catch (error) {
          logger.warn('[plugins] the daemon did not start a plugin switched on in a project', { plugin: name, error: summarizeError(error) });
        }
      }
      return result;
    },
    // Switched off: through the daemon's own manager when it has the plugin (it stops it and writes the same file).
    disable: async (name: string) => (inDaemon(name)?.enabled === true ? daemon.disable(name) : manager.disable(name)),
  });
}

export function createPluginCapabilityServices(sources: PluginServiceSources): PluginsCapabilityServices & MarketplaceCapabilityServices {
  const homeDir = sources.homeDirectory ?? resolveGoodVibesHome();
  const tree = join(homeDir, '.goodvibes');
  // The caller's project only: the daemon's own folder is never taken in its place (caller-project.ts).
  const projectOf = (workingDirectory: string | undefined): string => requireCallerProject(workingDirectory, 'the plugin catalog');
  const stateFilePath = join(tree, DAEMON_STATE_SURFACE_ROOT, 'plugins.json');
  const trustFilePath = join(tree, 'plugin-trust.json');
  const projects = new Map<string, PluginManager>();
  return {
    plugins: {
      forProject(workingDirectory): PluginProject | undefined {
        const daemonDirectory = sources.configManager.getWorkingDirectory() ?? undefined;
        const cwd = requireCallerProject(workingDirectory, 'the plugins');
        const live = sources.pluginManager !== undefined && daemonDirectory !== undefined && projectIdentityOf(daemonDirectory) === cwd;
        let manager: PluginManagingControls | undefined = live ? sources.pluginManager : projects.get(cwd);
        if (!manager) {
          const made = new PluginManager({ pathOptions: { cwd, homeDir }, stateFilePath, trustFilePath });
          if (projects.size >= 16) projects.delete(projects.keys().next().value!);
          projects.set(cwd, made);
          manager = made;
        }
        return {
          manager: live ? manager : alsoInDaemon(manager, sources.pluginManager),
          live,
          paths: { cwd, homeDir },
          catalog: catalogOf(cwd, homeDir),
        };
      },
    },
    marketplace: {
      forProject(workingDirectory) {
        const cwd = projectOf(workingDirectory);
        return { cwd, catalog: catalogOf(cwd, homeDir) };
      },
    },
  };
}
