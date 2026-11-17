import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import type { CommandContext } from '../input/command-registry.ts';
type ProjectCatalogContext = { readonly workspace: Pick<CommandContext['workspace'], 'shellPaths'> };
import { discoverProjectContextFiles, type AgentProjectContextSnapshot, type AgentProjectContextFile, type BlockedAgentProjectContextFile } from '@goodvibes-jev/engine/terminal-shell/agent-turn/project-context-files';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';

interface AgentHarnessProjectContextArgs {
  readonly contextFileId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

type ProjectContextRecord = AgentProjectContextFile | BlockedAgentProjectContextFile;

export type ProjectContextFileResolution =
  | { readonly status: 'found'; readonly file: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * One discovery per call, returned as read. The files are the owner's own
 * project instructions, the same ones the prompt is built from, so they are
 * not screened or re-read to prove they did not change.
 */
function snapshotForArgs(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs): AgentProjectContextSnapshot | null {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) return null;
  const targetPath = readString(args.target);
  return discoverProjectContextFiles(shellPaths, targetPath ? { targetPath } : {});
}

function describeRecord(record: ProjectContextRecord, includeParameters: boolean): Record<string, unknown> {
  const blocked = !('body' in record);
  return {
    id: record.id,
    path: record.path,
    kind: record.kind,
    scope: record.scope,
    source: record.source,
    status: blocked ? 'blocked' : record.truncated ? 'truncated' : 'loaded',
    summary: blocked
      ? previewHarnessText(record.reason, includeParameters ? 180 : 96)
      : previewHarnessText(record.body, includeParameters ? 240 : 96),
    modelRoute: 'context action:"file"',
    userRoute: 'Agent Workspace -> Local Context -> Inspect project context',
    ...(includeParameters && 'body' in record ? { body: record.body, truncated: record.truncated } : {}),
    ...(includeParameters && !('body' in record) ? { reason: record.reason } : {}),
  };
}

export function projectContextCatalogStatus(context: ProjectCatalogContext): Record<string, unknown> {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) {
    return {
      modes: ['project_context', 'project_context_file'],
      status: 'unavailable',
      reason: 'Project context discovery requires workspace shell paths.',
      targetAware: true,
    };
  }
  const snapshot = discoverProjectContextFiles(shellPaths);
  return {
    modes: ['project_context', 'project_context_file'],
    status: snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup',
    loaded: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: snapshot.files.filter((file) => file.truncated).length,
    targetAware: true,
  };
}

export async function projectContextSummary(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs,
  options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const snapshot = snapshotForArgs(context, args);
  const includeParameters = args.includeParameters === true;
  if (!snapshot) {
    return {
      status: 'unavailable',
      files: [],
      returned: 0,
      total: 0,
      loaded: 0,
      blocked: 0,
      truncated: 0,
      policy: 'Project context discovery requires workspace shell paths.',
      nextActions: ['Open a normal Agent workspace before relying on project context files.'],
    };
  }
  const records: readonly ProjectContextRecord[] = [...snapshot.files, ...snapshot.blocked];
  const query = readString(args.query);
  const selected = query ? await rankHarnessCatalog(records, query,
    record => ({ id: record.id, description: `Project context ${record.source} ${record.path}` }), 'agent.project-context.search', options)
    : { matches: records.map(entry => ({ entry })), judgments: [] };
  const filtered = selected.matches.map(({ entry }) => entry);
  return {
    status: snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup',
    files: filtered.map((record) => describeRecord(record, includeParameters)),
    returned: filtered.length,
    ...(query ? { judgments: selected.judgments } : {}),
    total: records.length,
    loaded: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: snapshot.files.filter((file) => file.truncated).length,
    workingDirectory: snapshot.workingDirectory,
    targetDirectory: snapshot.targetDirectory,
    gitRoot: snapshot.gitRoot,
    searchedPaths: includeParameters ? snapshot.searchedPaths : snapshot.searchedPaths.slice(0, 12),
    policy: 'Project context files are read-only prompt instructions. Secret-looking files are blocked, loaded bodies are bounded, and explicit user instructions/tool safety override context files.',
    nextActions: snapshot.files.length > 0
      ? ['Inspect one context file before relying on subdirectory-specific instructions.', 'Edit context files in the workspace if the visible guidance is stale.']
      : ['Add AGENTS.md or VIBE.md when the project needs persistent instructions.'],
  };
}

export async function describeProjectContextFile(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs,
  options: CatalogRankingOptions = {}): Promise<ProjectContextFileResolution> {
  options.signal?.throwIfAborted();
  // target also steers discovery to a directory, so it names the file only when nothing else does.
  const input = readString(args.contextFileId || args.query || args.target);
  if (!input) return { status: 'missing_lookup', usage: 'context action:"file" requires contextFileId, query, or target. Use context action:"files" to inspect available context files.' };
  const snapshot = snapshotForArgs(context, args);
  if (!snapshot) return { status: 'missing_lookup', usage: 'Project context discovery requires workspace shell paths.' };
  // A single file is a detail view, so its body is included unless the caller opts out; the list stays compact unless asked.
  const includeParameters = args.includeParameters !== false;
  const records: readonly ProjectContextRecord[] = [...snapshot.files, ...snapshot.blocked];
  const exact = records.find(record => record.id === input || record.path === input);
  const selected = exact ?? await selectHarnessCatalog(records, input,
    record => ({ id: record.id, description: `Project context ${record.source} ${record.path}` }), options, 'agent.project-context.select');
  if (selected) return { status: 'found', file: describeRecord(selected, includeParameters) };
  return { status: 'missing_lookup', usage: `No project context file was selected for ${input}. Use context action:"files" to inspect loaded and blocked files.` };
}
