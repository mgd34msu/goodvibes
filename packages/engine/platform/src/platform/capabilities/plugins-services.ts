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
          manager,
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
