/**
 * owner-added.ts, the MCP servers the owner put into a project's MCP file with
 * his own command or form (`/mcp add`, the MCP screen's add form, the web's).
 *
 * A project file waits on the owner's trust of the workspace because a cloned
 * repository, or anything else that writes there, can name a program to start.
 * A server the owner added himself is his request, not something the folder
 * brought: it starts without the trust question. Each one is kept here, outside
 * the repository, by the file it was written to, its name and a digest of how
 * it starts (command, arguments, environment, address, headers). An entry that
 * something else added, or changed so it starts another way, matches nothing
 * here and still waits on the question. Values are kept only as a digest.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { resolveSharedDirectory } from '../runtime/surface-root.js';
import type { McpServerConfig } from './config.js';

const FILE = 'mcp-servers-you-added.json';

interface OwnerAddedRecord {
  readonly version: 1;
  readonly servers: readonly { readonly file: string; readonly name: string; readonly launch: string }[];
}

function recordPath(homeDirectory: string): string {
  return resolveSharedDirectory(homeDirectory, 'shared', FILE);
}

/** How a server starts, as a digest: what decides which program runs and with what. */
function launchDigest(server: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify([
    server.command ?? null, server.args ?? [], server.env ?? {}, server.url ?? null, server.headers ?? {},
  ])).digest('hex');
}

function read(homeDirectory: string): OwnerAddedRecord {
  return readJsonFileOrQuarantine<OwnerAddedRecord>(recordPath(homeDirectory), {
    label: 'mcp/servers-you-added',
    recovery: 'The servers you added to a project\'s MCP file are asked about once more, with the workspace trust question.',
    validate: (parsed) => {
      const rows = (parsed as { servers?: unknown } | null)?.servers;
      if (!Array.isArray(rows)) throw new Error('the file has no list of servers');
      const servers = rows.flatMap((row: unknown) => {
        const entry = row as { file?: unknown; name?: unknown; launch?: unknown } | null;
        return typeof entry?.file === 'string' && typeof entry.name === 'string' && typeof entry.launch === 'string'
          ? [{ file: entry.file, name: entry.name, launch: entry.launch }] : [];
      });
      return { version: 1, servers };
    },
  }) ?? { version: 1, servers: [] };
}

/** Record that the owner put `server` into the project MCP file at `file` himself (replacing an earlier record of its name there). */
export function recordOwnerAddedServer(homeDirectory: string, file: string, server: McpServerConfig): void {
  const at = resolve(file);
  const others = read(homeDirectory).servers.filter((row) => !(row.file === at && row.name === server.name));
  writeJsonFileAtomic(recordPath(homeDirectory), { version: 1, servers: [...others, { file: at, name: server.name, launch: launchDigest(server) }] } satisfies OwnerAddedRecord, { mode: 0o600 });
}

/** Forget a server the owner removed from that file. */
export function forgetOwnerAddedServer(homeDirectory: string, file: string, name: string): void {
  const at = resolve(file);
  const current = read(homeDirectory).servers;
  const kept = current.filter((row) => !(row.file === at && row.name === name));
  if (kept.length === current.length) return;
  writeJsonFileAtomic(recordPath(homeDirectory), { version: 1, servers: kept } satisfies OwnerAddedRecord, { mode: 0o600 });
}

/** Reads the record once and answers, for each server of a project file, whether the owner added it as it now stands. */
export function ownerAddedServers(homeDirectory: string): (file: string, server: McpServerConfig) => boolean {
  const servers = read(homeDirectory).servers;
  if (servers.length === 0) return () => false;
  return (file, server) => {
    const at = resolve(file);
    const row = servers.find((entry) => entry.file === at && entry.name === server.name);
    return row !== undefined && row.launch === launchDigest(server);
  };
}
