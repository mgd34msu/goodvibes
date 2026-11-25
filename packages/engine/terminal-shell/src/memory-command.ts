/**
 * `/memory`, the one typed command of Memory and knowledge that stays: it
 * opens the place (places/memory-place.ts), unlisted. Everything you do with
 * memory, knowledge, what is known about you and your templates is a control
 * there, and a capability (capabilities/builtin/memory.ts, knowledge.ts,
 * profile.ts, templates.ts) that the model, an outside agent and a script
 * reach by find and run.
 *
 * This file keeps what the program itself supplies for them: the live lists a
 * form chooses from (the records, the copies of memory, the changes your
 * memory files would make), read from the daemon, and the program's services
 * for the memory capabilities that run where the conversation is
 * (builtin/memory-session.ts): the memory its turns were given, what it holds
 * that can be remembered, and memory kept as files in its project.
 */
import { existsSync } from 'node:fs';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { MemorySpineClient } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
  type MemoryRecord,
  type MemoryScope,
} from '@goodvibes/engine/platform/platform/state';
import {
  CapabilityRefusal, describeMemoryFileChange, memoryFileProposals,
  type MemorySessionCapabilityServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext, CommandDescription } from './command-actions/types.js';
import { doAction } from './described-command-kit.js';
import { resolveConfinedBundlePath } from './recall-shared.js';

type CaptureExtensions = {
  readonly forensicsRegistry?: {
    latest(): { readonly id: string } | null | undefined;
    getById(id: string): { readonly id: string } | null | undefined;
    buildBundle(id: string): Parameters<typeof buildIncidentMemoryAddOptions>[0] | null | undefined;
  } | null | undefined;
  readonly policyRuntimeState?: { getSnapshot(): { readonly lastPreflightReview?: Parameters<typeof buildPolicyPreflightMemoryAddOptions>[0] | null | undefined } } | null | undefined;
  readonly mcpRegistry: { listServerSecurity(): readonly Parameters<typeof buildMcpSecurityMemoryAddOptions>[0][] };
  readonly pluginManager?: {
    list(): readonly Parameters<typeof buildPluginSecurityMemoryAddOptions>[0][];
    getQuarantineRecord(name: string): { readonly reason: string } | null | undefined;
  } | null | undefined;
};

export interface MemoryCommandContext extends CommandActionContext {
  readonly clients?: {
    readonly memorySpine?: MemorySpineClient | null | undefined;
  } | null | undefined;
  readonly session: { readonly runtime: { readonly sessionId: string } };
  readonly extensions: CaptureExtensions;
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get'> };
  /** Open a place of this program by id (places/index.ts). */
  readonly openPlace?: ((placeId: string) => void) | undefined;
}

/** What differs between the two apps. */
export interface MemoryCommandPolicy<Ctx> {
  /** The memory a turn (or an agent's turns) was given; undefined when this app does not record it. */
  readonly injections: ((ctx: Ctx, agentId: string) => string) | undefined;
  /** How this app reaches the daemon, where memory is kept. */
  readonly daemon: DaemonCapabilityBinding<Ctx>;
}

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** A daemon capability's facts, for a list a form chooses from. */
async function daemonData(id: string, input: Readonly<Record<string, string>>, ctx: CommandActionContext): Promise<Readonly<Record<string, unknown>>> {
  if (!binding) throw commandRefusal('Memory is not available in this session; nothing was read.');
  const answer = await runDaemonCapability(id, input, ctx, binding);
  return answer.data ?? {};
}
const rowsOf = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object') : [];
const str = (value: unknown): string => typeof value === 'string' ? value : '';

function spineOf(ctx: MemoryCommandContext): MemorySpineClient {
  const spine = ctx.clients?.memorySpine;
  if (!spine) throw new CapabilityRefusal('Memory is not available in this session; nothing was read or changed.', 'Restart the program; memory loads with it.');
  return spine;
}
function pathsOf(ctx: MemoryCommandContext): ShellPathService {
  const paths = ctx.workspace.shellPaths;
  if (!paths) throw new CapabilityRefusal('This session has no working directory, so no file path can be used.');
  return paths;
}
/** A folder inside the workspace (memory files are the project's). */
function confinedPath(ctx: MemoryCommandContext, path: string, byModel: boolean): string {
  const resolved = resolveConfinedBundlePath(path, pathsOf(ctx), byModel);
  if (resolved === undefined) throw new CapabilityRefusal(`${path} is outside the project. Memory files are kept in a folder of the project; nothing was read or written.`, 'Name a folder inside the project.');
  return resolved;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a form or a completion asks
// ---------------------------------------------------------------------------

defineList<CommandActionContext>({
  name: 'memory.records',
  async read(ctx) {
    return rowsOf((await daemonData('memory.list', {}, ctx)).records).map((record): ListRow => ({
      value: str(record.id), label: str(record.summary), detail: str(record.id), state: `${str(record.scope)} ${str(record.cls)}`,
    }));
  },
  operator: { method: 'memory.records.list', input: {}, rows: { from: 'records', value: 'id', label: 'summary', detail: 'id', state: 'cls' } },
});

defineList<CommandActionContext>({
  name: 'memory.copies',
  async read(ctx) {
    return rowsOf((await daemonData('memory.snapshots', {}, ctx)).snapshots).map((copy): ListRow => ({
      value: str(copy.name), label: str(copy.name),
      detail: `${str(copy.reason)}, ${typeof copy.createdAt === 'number' ? new Date(copy.createdAt).toISOString().slice(0, 16).replace('T', ' ') : ''} UTC`,
      state: typeof copy.recordCount === 'number' ? `${copy.recordCount} record${copy.recordCount === 1 ? '' : 's'}` : 'records unreadable',
    }));
  },
  operator: { method: 'memory.snapshots.list', input: {}, rows: { from: 'snapshots', value: 'name', label: 'name', detail: 'reason' } },
});

defineList<MemoryCommandContext>({
  name: 'memory.file-proposals',
  async read(ctx, earlier) {
    const services = memorySessionServices(ctx);
    const dir = services.filesFolder(earlier.dir ?? '');
    if (!existsSync(dir)) return [];
    const { proposals } = await memoryFileProposals(services, dir);
    return [
      ...(proposals.length > 1 ? [{ value: 'all', label: 'Every proposal', state: `${proposals.length}` }] : []),
      ...proposals.map((proposal): ListRow => ({
        value: proposal.id, label: proposal.id, detail: proposal.reason,
        state: proposal.kind === 'delete' ? 'deletes the record' : describeMemoryFileChange(proposal),
      })),
    ];
  },
  operator: { terminalOnly: 'Memory files live in the terminal program\'s project.' },
});

// ---------------------------------------------------------------------------
// The program's services for the memory capabilities that run here
// ---------------------------------------------------------------------------

let injectionsOf: ((ctx: CommandActionContext, agentId: string) => string) | undefined;

async function capture(ctx: MemoryCommandContext, what: string, which: string): Promise<string> {
  const spine = spineOf(ctx);
  if (what === 'incident') {
    const registry = ctx.extensions.forensicsRegistry;
    if (!registry) throw new CapabilityRefusal('Incident reports are not available in this program.');
    const report = !which || which === 'latest' ? registry.latest() : registry.getById(which);
    if (!report) throw new CapabilityRefusal(`No incident report ${which || 'yet'}.`, 'The latest failure is shown in the System place.');
    const bundle = registry.buildBundle(report.id);
    if (!bundle) throw new CapabilityRefusal(`Incident ${report.id} could not be read.`);
    return `Remembered incident ${report.id} as ${(await spine.add(buildIncidentMemoryAddOptions(bundle))).id}.`;
  }
  if (what === 'policy') {
    const review = ctx.extensions.policyRuntimeState?.getSnapshot().lastPreflightReview;
    if (!review) throw new CapabilityRefusal('No policy check has run yet, so there is nothing to remember.');
    return `Remembered the last policy check as ${(await spine.add(buildPolicyPreflightMemoryAddOptions(review))).id}.`;
  }
  if (what === 'mcp') {
    const server = ctx.extensions.mcpRegistry.listServerSecurity().find((entry) => entry.name === which);
    if (!server) throw new CapabilityRefusal(`No MCP server is named ${which || '(none given)'}.`, 'Your tool servers are listed in the Tools and extensions place.');
    return `Remembered MCP server ${server.name} as ${(await spine.add(buildMcpSecurityMemoryAddOptions(server))).id}.`;
  }
  const plugins = ctx.extensions.pluginManager;
  if (!plugins) throw new CapabilityRefusal('Plugins are not available in this program.');
  const plugin = plugins.list().find((entry) => entry.name === which);
  if (!plugin) throw new CapabilityRefusal(`No plugin is named ${which || '(none given)'}.`);
  return `Remembered plugin ${plugin.name} as ${(await spine.add(buildPluginSecurityMemoryAddOptions(plugin, plugins.getQuarantineRecord(plugin.name)?.reason))).id}.`;
}

/**
 * This program's services for the memory capabilities that run where the conversation is: its turns' record, what
 * it holds, and the memory files of its project (the records read and written through the daemon). The same services
 * serve the person's press and the model's call, so the memory files folder is always one inside the workspace.
 */
export function memorySessionServices(ctx: MemoryCommandContext): NonNullable<MemorySessionCapabilityServices['memorySession']> {
  const byModel = true;
  return {
    ...(injectionsOf ? { injections: (agent: string) => injectionsOf!(ctx, agent) } : {}),
    capture: (what, which) => capture(ctx, what, which),
    records: async (limit) => spineOf(ctx).list({ limit }) as Promise<readonly MemoryRecord[]>,
    update: async (id, patch) => spineOf(ctx).update(id, patch as { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }),
    delete: async (id) => spineOf(ctx).delete(id),
    filesFolder: (given) => confinedPath(ctx, given || String(ctx.platform.configManager.get('memory.projection.dir')), byModel),
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function describeMemory<Ctx extends MemoryCommandContext>(): CommandDescription<Ctx> {
  return {
    name: 'memory',
    title: 'Memory and knowledge',
    summary: 'Opens Memory and knowledge: what the project remembers, your knowledge, what is known about you, and your templates',
    group: 'Knowledge',
    // Unlisted: typed, it opens the place; the menu reaches the place too.
    firstScreen: false,
    bareOpens: 'open',
    report: 'open',
    actions: [
      doAction<Ctx>({
        id: 'open', label: 'Open Memory and knowledge', word: 'open', touches: 'reads',
        sentence: 'Opens Memory and knowledge: memory, knowledge, what is known about you and your templates.',
        operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) {
          if (!ctx.openPlace) throw commandRefusal('This program has no screens to open.');
          ctx.openPlace('memory');
        },
      }),
    ],
  };
}

/** `/memory` for one app: opens the place; the app's turn record and its way to the daemon serve the place's capabilities. */
export function createMemoryCommand<Ctx extends MemoryCommandContext>(policy: MemoryCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  binding = policy.daemon as unknown as DaemonCapabilityBinding<CommandActionContext>;
  injectionsOf = policy.injections as ((ctx: CommandActionContext, agentId: string) => string) | undefined;
  return defineCommand(describeMemory<Ctx>());
}
