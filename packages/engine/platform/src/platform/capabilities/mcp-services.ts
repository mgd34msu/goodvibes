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
import { resolve } from 'node:path';
import {
  loadMcpEffectiveConfig, removeMcpServerConfig, setMcpServerPolicy, setMcpServerToolRule, upsertMcpServerConfig, withMcpConfigLock,
  type McpConfigRoots, type McpEffectiveConfig,
} from '../mcp/config.js';
import { forgetOwnerAddedServer, recordOwnerAddedServer } from '../mcp/owner-added.js';
import type { McpRegistry } from '../mcp/registry.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';
import type { McpCapabilityServices, McpProjectConfig } from './builtin/mcp.js';

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

export function createMcpCapabilityServices(sources: McpServiceSources): McpCapabilityServices {
  const homeDirectory = sources.homeDirectory ?? resolveGoodVibesHome();
  return {
    mcp: {
      forProject(workingDirectory): McpProjectConfig {
        const daemonDirectory = sources.configManager.getWorkingDirectory() ?? undefined;
        const directory = resolve(workingDirectory ?? daemonDirectory ?? process.cwd());
        const roots: McpConfigRoots = { workingDirectory: directory, homeDirectory };
        const own = sources.mcpRegistry && daemonDirectory && resolve(daemonDirectory) === directory ? sources.mcpRegistry : undefined;
        return {
          roots,
          effective: () => loadMcpEffectiveConfig(roots),
          heldForTrust: async () => own ? own.heldForWorkspaceTrust(roots) : [],
          async upsert(scope, server) {
            if (own) {
              // The owner's request: a project file's entry he added starts without the folder's trust question.
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
