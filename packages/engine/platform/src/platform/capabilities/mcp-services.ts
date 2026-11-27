/**
 * The daemon's MCP services (capabilities/builtin/mcp.ts): the MCP config
 * files of the caller's project, as the daemon writes them.
 *
 * For the daemon's own folder its live registry writes and applies the change
 * at once (a reload of its connections). For any other project the files are
 * written with the same config functions under the same lock, and nothing here
 * connects: the program running turns in that project reads the changed file
 * before its next MCP call (the registry's config stamp), and the program that
 * asked reads it again at once.
 */
import { projectIdentityOf } from '../workspace/project-identity.js';
import {
  loadMcpEffectiveConfig, removeMcpServerConfig, setMcpServerPolicy, setMcpServerToolRule, upsertMcpServerConfig, withMcpConfigLock,
  type McpConfigRoots, type McpEffectiveConfig,
} from '../mcp/config.js';
import { forgetOwnerAddedServer, recordOwnerAddedServer } from '../mcp/owner-added.js';
import type { McpRegistry } from '../mcp/registry.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';
import type { McpCapabilityServices, McpProjectConfig } from './builtin/mcp.js';
import { requireCallerProject } from './caller-project.js';

export interface McpServiceSources {
  readonly configManager: { getWorkingDirectory(): string | null | undefined };
  /** The daemon's own registry: its folder's servers, connected. */
  readonly mcpRegistry?: Pick<McpRegistry, 'upsertServerConfig' | 'removeServerConfig' | 'storeServerToolRule' | 'storeServerPolicy' | 'listServerSecurity' | 'heldForWorkspaceTrust'> | undefined;
  /** The home folder the MCP config files of "All your projects" are under. */
  readonly homeDirectory?: string | undefined;
}

/** A server's entry where a kept rule or a kept policy may be written: refused for a file another program owns. */
function writableEntry(effective: McpEffectiveConfig, server: string, what: string): McpEffectiveConfig['servers'][number] {
  const entry = effective.servers.find((candidate) => candidate.server.name === server);
  if (!entry) throw new Error(`No MCP server named '${server}' is configured, so its ${what} was not kept.`);
  if (!entry.source.writable || entry.source.scope === 'external') {
    throw new Error(`${server} is configured in ${entry.source.path}, a file another program owns, so its ${what} cannot be kept there. Add ${server} to your own MCP config (All your projects) to keep it.`);
  }
  return entry;
}

/** A project's own MCP files (read or written only for a caller that names its project). */
const PROJECT_KINDS: ReadonlySet<string> = new Set(['project-mcp', 'project-goodvibes']);

/**
 * The MCP config of a caller that named no project: only the files that are for all the person's projects (and the
 * other programs' files in the owner's home). Every project-scope read or write is refused (NO_PROJECT); the daemon's folder is
 * never read in its place.
 */
function userOnlyConfig(homeDirectory: string): McpProjectConfig {
  // The home as the root: only its global locations are kept below; its project-shaped paths are never read or written.
  const roots: McpConfigRoots = { workingDirectory: homeDirectory, homeDirectory };
  const noProject = (): never => requireCallerProject(undefined, 'the project MCP config file') as never;
  const effective = (): McpEffectiveConfig => {
    const all = loadMcpEffectiveConfig(roots);
    return {
      ...all,
      locations: all.locations.filter((location) => !PROJECT_KINDS.has(location.kind)),
      servers: all.servers.filter((entry) => !PROJECT_KINDS.has(entry.source.kind)),
    };
  };
  const globalEntry = (server: string, what: string): void => {
    const entry = writableEntry(effective(), server, what);
    if (entry.source.scope !== 'global') noProject();
  };
  return {
    roots,
    effective,
    heldForTrust: async () => [],
    async upsert(scope, server) {
      if (scope !== 'global') noProject();
      const written = await withMcpConfigLock(roots, 'global', () => upsertMcpServerConfig(roots, 'global', server));
      return { path: written.path };
    },
    async remove(scope, name) {
      if (scope !== 'global') noProject();
      const written = await withMcpConfigLock(roots, 'global', () => removeMcpServerConfig(roots, 'global', name));
      return { path: written.path, removed: written.removed };
    },
    async storeToolRule(server, tool, rule) {
      globalEntry(server, `rule for its tool '${tool}'`);
      const written = await withMcpConfigLock(roots, 'global', () => setMcpServerToolRule(roots, 'global', server, tool, rule));
      return { scope: 'global', path: written.path, changed: written.changed };
    },
    async storePolicy(server, policy) {
      globalEntry(server, 'trustMode' in policy ? 'trust mode' : 'role');
      const written = await withMcpConfigLock(roots, 'global', () => setMcpServerPolicy(roots, 'global', server, policy));
      return { scope: 'global', path: written.path, changed: written.changed };
    },
  };
}

export function createMcpCapabilityServices(sources: McpServiceSources): McpCapabilityServices {
  const homeDirectory = sources.homeDirectory ?? resolveGoodVibesHome();
  return {
    mcp: {
      forProject(workingDirectory): McpProjectConfig {
        const daemonDirectory = sources.configManager.getWorkingDirectory() ?? undefined;
        // A change for all the person's projects needs no project; a project's own files need the caller's project,
        // and the daemon's own folder is never taken in its place (caller-project.ts).
        if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) return userOnlyConfig(homeDirectory);
        const directory = requireCallerProject(workingDirectory, 'the MCP config files');
        const roots: McpConfigRoots = { workingDirectory: directory, homeDirectory };
        const own = sources.mcpRegistry && daemonDirectory && projectIdentityOf(daemonDirectory) === directory ? sources.mcpRegistry : undefined;
        return {
          roots,
          effective: () => loadMcpEffectiveConfig(roots),
          heldForTrust: async () => own ? own.heldForWorkspaceTrust(roots) : [],
          async upsert(scope, server) {
            if (own) {
              // The owner's request: a project file's entry the owner added starts without the folder's trust question.
              const result = await own.upsertServerConfig(roots, scope, server, { byOwner: true });
              return { path: result.path, connected: own.listServerSecurity().find((entry) => entry.name === server.name)?.connected ?? false };
            }
            const written = await withMcpConfigLock(roots, scope, () => {
              const result = upsertMcpServerConfig(roots, scope, server);
              const entry = result.config.servers.find((candidate) => candidate.name === server.name);
              if (scope === 'project' && entry) recordOwnerAddedServer(roots.homeDirectory, result.path, entry);
              return result;
            });
            return { path: written.path };
          },
          async remove(scope, name) {
            if (own) {
              const result = await own.removeServerConfig(roots, scope, name);
              return { path: result.path, removed: result.removed };
            }
            const written = await withMcpConfigLock(roots, scope, () => {
              const result = removeMcpServerConfig(roots, scope, name);
              if (scope === 'project' && result.removed) forgetOwnerAddedServer(roots.homeDirectory, result.path, name);
              return result;
            });
            return { path: written.path, removed: written.removed };
          },
          async storeToolRule(server, tool, rule) {
            if (own) {
              const result = await own.storeServerToolRule(server, tool, rule, roots);
              return { scope: result.scope, path: result.path, changed: result.changed };
            }
            const entry = writableEntry(loadMcpEffectiveConfig(roots), server, `rule for its tool '${tool}'`);
            const scope = entry.source.scope === 'global' ? 'global' : 'project';
            const written = await withMcpConfigLock(roots, scope, () => setMcpServerToolRule(roots, scope, server, tool, rule));
            return { scope, path: written.path, changed: written.changed };
          },
          async storePolicy(server, policy) {
            if (own) {
              const result = await own.storeServerPolicy(server, policy, roots);
              return { scope: result.scope, path: result.path, changed: result.changed };
            }
            const entry = writableEntry(loadMcpEffectiveConfig(roots), server, 'trustMode' in policy ? 'trust mode' : 'role');
            const scope = entry.source.scope === 'global' ? 'global' : 'project';
            const written = await withMcpConfigLock(roots, scope, () => setMcpServerPolicy(roots, scope, server, policy));
            return { scope, path: written.path, changed: written.changed };
          },
        };
      },
    },
  };
}
