/**
 * agent-store-runner.ts, the daemon's runner over the Agent's own stores
 * (capabilities/builtin/agent-stores.ts): notes, personas and VIBE.md files,
 * routines, saved artifacts and document drafts. The daemon composes it once
 * (products/daemon service graph) and every capability over those stores runs
 * here, whoever asked: the terminal app, the Agent, the web UI, a model, an
 * outside agent or a script.
 *
 * The stores are the ones every Agent turn reads and writes: the notes,
 * personas and routines in the owner's home (`~/.goodvibes/agent/`), the
 * drafts in the asking program's project (the daemon's own project when none
 * is named), the artifacts in the daemon's store. Each change is announced as
 * LIST_CHANGED, so every screen showing that list reads it again.
 */
import { CapabilityRefusal, type AgentStoreRunner } from '@goodvibes/engine/platform/platform/capabilities';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { MemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import { noteListChanged, type ChangedList } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { ToolRegistry, createWebSearchTool } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { WebSearchService } from '@goodvibes/engine/platform/platform/web-search';
import type { ProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security';
import { createClassicProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security/source-screening/classic-owner';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { registerAgentResearchRunsTool } from './research-runs-tool.js';
import { registerAgentResearchSourcesTool } from './research-sources-tool.js';
import { registerAgentResearchReportTool } from './research-report-tool.js';
import { createAgentCredentialReader, createAgentResearchSourceOwner, createAgentSettingsReader } from './research-source-screening.js';
import { runAdmittedResearchRunner } from './research-runner.js';
import { RESEARCH_ACTS, researchRunnerArgs } from './agent-store-research.js';
import { carryAgentHandOffsOnce, handOffActs, type HandOffSessions } from './agent-store-handoff.js';
import { registerAgentArtifactsTool } from './artifacts-tool.js';
import { registerAgentDocumentsTool } from './documents-tool.js';
import { registerAgentReviewPacketPresetsTool } from './review-packet-presets-tool.js';
import { registerAgentReviewPacketShareTool, type AgentReviewPacketShareChannelRouter } from './review-packet-share-tool.js';
import { NOTE_ACTS } from './agent-store-notes.js';
import { PERSONA_ACTS, ROUTINE_ACTS, startRoutine } from './agent-store-library.js';
import { DRAFT_ACTS } from './agent-store-drafts.js';
import { SCHEDULE_ACTS } from './agent-store-schedules.js';
import { resolveAgentConnectedHostConnection, type AgentConnectedHostConfigReader } from './routine-schedules.js';
import type { StoreAct, StoreActContext } from './agent-store-common.js';

export interface AgentStoreRunnerDeps {
  /** The owner's home: the Agent's home stores are under it. */
  readonly homeDirectory: string;
  /** The daemon's own project, for a caller that names none. */
  readonly workingDirectory: () => string;
  /** The daemon's artifact store. */
  readonly artifactStore: ArtifactStore;
  /** The daemon's one channel delivery router, which sends a review packet. */
  readonly channelDeliveryRouter: AgentReviewPacketShareChannelRouter;
  /** The daemon's permission gate: the tool calls run under it as the owner's confirmed act (a deny rule still refuses). */
  readonly permissionManager: NonNullable<ConstructorParameters<typeof ToolRegistry>[0]>;
  /** The one memory store. */
  readonly memory?: Pick<MemoryAccess, 'add'> | undefined;
  /** Adding a web page to the daemon's one knowledge store. */
  readonly ingestUrl?: StoreActContext['ingestUrl'];
  /** The daemon's settings: the daemon reaches its own schedules as a routine's host through them (routine-schedules.ts). */
  readonly config?: AgentConnectedHostConfigReader | undefined;
  /** Work and agents: the daemon's web search, which the research runner collects a run's sources with (absent: runs are kept, not started). */
  readonly webSearchService?: WebSearchService | undefined;
  /** Work and agents: the daemon's session broker, which a hand-off of coding work makes its shared session on. */
  readonly sessions?: HandOffSessions | undefined;
}

const ACTS: Readonly<Record<string, StoreAct>> = { ...NOTE_ACTS, ...PERSONA_ACTS, ...ROUTINE_ACTS, ...SCHEDULE_ACTS, ...DRAFT_ACTS, ...RESEARCH_ACTS };

/** The list a capability changes, by its command; reads change none. */
const LIST_OF: Readonly<Record<string, ChangedList>> = { notes: 'notes', personas: 'personas', routines: 'routines', documents: 'documents', artifacts: 'artifacts', research: 'research' };
const READS = new Set(['list', 'show', 'search', 'active', 'discover', 'vibe', 'vibe-show', 'receipts', 'receipt', 'runs', 'handed-off']);

/** What a change does to its list, for the notice. */
function changeOf(word: string): 'created' | 'changed' | 'deleted' {
  if (word === 'delete') return 'deleted';
  if (word === 'create' || word === 'import' || word === 'vibe-import' || word.startsWith('to-') || word === 'save-preset' || word === 'refresh-preset' || word === 'export') return 'created';
  return 'changed';
}

/** The lists a change shows in: its own, and the one a note made something in. */
function changedLists(id: string): readonly ChangedList[] {
  const [command = '', word = ''] = id.split('.');
  const own = LIST_OF[command];
  const lists: ChangedList[] = own ? [own] : [];
  if (word === 'to-persona') lists.push('personas');
  if (word === 'to-routine') lists.push('routines');
  if (word === 'to-memory') lists.push('memory');
  // A draft saved as an artifact, a preset saved, or a packet put together is a new saved artifact.
  if (command === 'documents' && (word === 'export' || word === 'save-preset' || word === 'refresh-preset')) lists.push('artifacts');
  // A sourced report is a new saved artifact.
  if (id === 'research.save-report') lists.push('artifacts');
  return lists;
}

/** The research screening owners, as an Agent turn the daemon hosts has them (hosted-turn.ts): made on first use. */
function researchOwners(homeDirectory: string): () => { readonly report: ProtectedSourceOwner; readonly shared: ProtectedSourceOwner } {
  const lifetime = new AbortController();
  let owners: { readonly report: ProtectedSourceOwner; readonly shared: ProtectedSourceOwner } | null = null;
  return () => {
    if (owners) return owners;
    const settings = createAgentSettingsReader(homeDirectory);
    owners = {
      report: createAgentResearchSourceOwner(settings, createAgentCredentialReader(homeDirectory, settings), lifetime.signal),
      shared: createClassicProtectedSourceOwner(Object.freeze({
        ownerId: `daemon-research-reads-${randomUUID()}`, revision: randomUUID(), signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted(),
      })),
    };
    return owners;
  };
}

export function createAgentStoreRunner(deps: AgentStoreRunnerDeps): AgentStoreRunner {
  const registries = new Map<string, ToolRegistry>();
  // Work and agents: hand-offs are kept in the daemon's home; the Agent's own records are carried in once, here at start.
  const daemonHome = resolveGoodVibesDaemonHome(deps.homeDirectory);
  carryAgentHandOffsOnce({ homeDirectory: deps.homeDirectory, daemonHome });
  const acts: Readonly<Record<string, StoreAct>> = { ...ACTS, ...handOffActs({ sessions: deps.sessions, daemonHome }) };
  const owners = researchOwners(deps.homeDirectory);
  const webSearch: Tool | undefined = deps.webSearchService ? createWebSearchTool(deps.webSearchService) : undefined;
  /** The research runs the daemon is collecting sources for now, by project and run: a second start of one is not run twice. */
  const collecting = new Set<string>();
  const toolsFor = (shellPaths: ShellPathService): ToolRegistry => {
    let registry = registries.get(shellPaths.workingDirectory);
    if (!registry) {
      registry = new ToolRegistry(deps.permissionManager);
      registerAgentArtifactsTool(registry, deps.artifactStore, { projectRoot: shellPaths.workingDirectory });
      registerAgentDocumentsTool(registry, shellPaths, deps.artifactStore);
      registerAgentReviewPacketPresetsTool(registry, deps.artifactStore);
      registerAgentReviewPacketShareTool(registry, deps.artifactStore, deps.channelDeliveryRouter);
      // Work and agents: research runs, the research queue, sourced reports, and the web search the runner collects with.
      registerAgentResearchRunsTool(registry, shellPaths);
      registerAgentResearchSourcesTool(registry, shellPaths);
      registerAgentResearchReportTool(registry, deps.artifactStore, owners().report, 'report-only', owners().shared);
      if (webSearch && !registry.has(webSearch.definition.name)) registry.register(webSearch);
      // A few projects at most are worked on from one daemon; the oldest is let go past that.
      if (registries.size >= 32) registries.delete(registries.keys().next().value!);
      registries.set(shellPaths.workingDirectory, registry);
    }
    return registry;
  };
  return {
    async run(id, values, caller) {
      const act = acts[id];
      if (!act) throw new CapabilityRefusal(`${id} is not an act on the Agent's stores; nothing was done.`);
      const workingDirectory = caller.workingDirectory ? resolve(caller.workingDirectory) : deps.workingDirectory();
      const shellPaths = createShellPathService({ workingDirectory, homeDirectory: deps.homeDirectory });
      const context: StoreActContext = {
        shellPaths,
        artifacts: deps.artifactStore,
        ...(deps.memory ? { memory: deps.memory } : {}),
        ...(deps.ingestUrl ? { ingestUrl: deps.ingestUrl } : {}),
        ...(deps.config ? { scheduleHost: () => resolveAgentConnectedHostConnection(deps.config!, deps.homeDirectory) } : {}),
        async tool(name, args, what) {
          const result = await toolsFor(shellPaths).executeOwnerConfirmed(`capability-${name}`, name, { ...args }, {
            goal: `The owner asked for this: ${what}.`,
            criteria: [`Run ${name} with exactly the values the owner gave.`],
          });
          if (!result.success) throw new CapabilityRefusal(`Not done: ${result.error ?? `${name} did not succeed and gave no reason.`}`);
          return result.output?.trim() || `${what}: done.`;
        },
        // Work and agents: a kept research run's sources are collected here, in the daemon, while the answer goes back;
        // the run's row shows where it stands (each step announces the research list).
        ...(webSearch ? {
          startResearch(runId: string, name: string) {
            const key = `${shellPaths.workingDirectory}\u0000${runId}`;
            if (collecting.has(key)) return;
            collecting.add(key);
            const registry = toolsFor(shellPaths);
            let step = 0;
            const dispatch = (child: Tool, args: Record<string, unknown>) => registry.executeOwnerConfirmed(`research-runner-${runId}-${++step}`, child.definition.name, args, {
              goal: `The owner started the research run "${name}": collect public web sources for it.`,
              criteria: ['Search the public web for the run\'s question, once.'],
            });
            noteListChanged({ list: 'research', change: 'changed', id: runId });
            void runAdmittedResearchRunner(webSearch, researchRunnerArgs(runId, name), shellPaths, dispatch, () => {}, () => {})
              .catch(() => undefined)
              .finally(() => { collecting.delete(key); noteListChanged({ list: 'research', change: 'changed', id: runId }); });
          },
        } : {}),
      };
      const result = await act(values, context);
      const word = id.slice(id.indexOf('.') + 1);
      if (!READS.has(word)) {
        const change = changeOf(word);
        for (const list of changedLists(id)) noteListChanged({ list, change: list === id.split('.')[0] ? change : 'created' });
      }
      return result;
    },
  };
}

/** Starting a routine in a conversation: the routine marked started in the owner's routine store, with its steps. */
export function startRoutineFor(shellPaths: ShellPathService, idOrName: string) {
  const started = startRoutine(shellPaths, idOrName);
  noteListChanged({ list: 'routines', change: 'changed', id: started.id });
  return started;
}
