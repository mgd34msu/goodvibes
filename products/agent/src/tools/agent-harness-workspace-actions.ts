import { captureCatalogSnapshot } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-data';
import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { captureCatalogReadRequest, selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import { captureModelReadingSnapshotGuard, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import type { CommandContext } from '../input/command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import type { AgentWorkspaceAction, AgentWorkspaceCategory } from '../input/agent-workspace-types.ts';
import { parseSlashCommand } from '../input/slash-command-parser.ts';
import { resolveWorkspaceAction, workspaceActionLine } from '../input/workspace-actions.ts';
import { describeActionForModel, describeCommandForModel, renderTypedLine } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn/read-helpers';
import { readOffset } from './agent-harness-tool-utils.ts';
import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

export { AGENT_WORKSPACE_CATEGORIES };

export interface AgentHarnessWorkspaceActionArgs {
  readonly query?: unknown;
  readonly command?: unknown;
  readonly actionId?: unknown;
  readonly fields?: unknown;
  readonly target?: unknown;
  readonly category?: unknown;
  readonly categoryId?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface WorkspaceActionLookup {
  readonly source: 'actionId' | 'command' | 'target' | 'query';
  readonly input: string;
  readonly resolvedBy: 'id' | 'case-insensitive-id' | 'label' | 'case-insensitive-label' | 'command' | 'search';
}

export type WorkspaceActionResolution =
  | {
    readonly status: 'found';
    readonly category: AgentWorkspaceCategory;
    readonly action: AgentWorkspaceAction;
    readonly lookup: WorkspaceActionLookup;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly { readonly actionId: string; readonly categoryId: string; readonly label: string; readonly command?: string }[];
  };

/** The values a model gave for a row's blanks (`fields`), as text. */
export function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

export function allWorkspaceActions(): ReadonlyArray<{
  readonly category: AgentWorkspaceCategory;
  readonly action: AgentWorkspaceAction;
}> {
  return AGENT_WORKSPACE_CATEGORIES.flatMap((category) => category.actions.map((action) => ({ category, action })));
}

function originalWorkspaceEntry(entries: ReturnType<typeof allWorkspaceActions>, action: AgentWorkspaceAction) {
  const entry = entries.find(entry => entry.action === action);
  if (!entry) throw new ToolInputProjectionError('held');
  return entry;
}

function captureWorkspaceCategories(): () => void {
  captureCatalogSnapshot(AGENT_WORKSPACE_CATEGORIES);
  // Frozen native declarations can reuse a complete descriptor proof. Mutable
  // declarations still receive the full comparison at every publication fence.
  const assertSource = captureModelReadingSnapshotGuard(AGENT_WORKSPACE_CATEGORIES, true);
  return () => { assertSource(AGENT_WORKSPACE_CATEGORIES); };
}

export function describeWorkspaceCategory(category: AgentWorkspaceCategory): Record<string, unknown> {
  return {
    id: category.id,
    group: category.group,
    label: category.label,
    summary: category.summary,
    detail: category.detail,
    actions: category.actions.length,
  };
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function commandRouteHint(command: string): string {
  const parsed = parseSlashCommand(command);
  const commandName = parsed.name || command.replace(/^\//, '').trim().split(/\s+/)[0] || command;
  return describeCommandPolicy(commandName).preferredModelTool ?? `workspace action:"run_command" commandName:"${commandName}"`;
}


function workspaceActionRouteHint(action: AgentWorkspaceAction): string {
  if (action.kind === 'settings-import') return 'settings action:"import"';
  if (action.id === 'account-local-server-health') return 'models action:"smoke"';
  if (action.id === 'assistant-browser-cockpit') return 'computer action:"open_browser"';
  if (action.id === 'research-briefing') return 'research action:"briefing"';
  if (action.id === 'research-workflow-plan') return 'research action:"plan"';
  if (action.id === 'research-runner-readiness') return 'research action:"runner"';
  if (action.id === 'research-run-queue') return 'research action:"runs"';
  if (action.id === 'research-public-search') return 'research action:"search"';
  if (action.id === 'research-source-queue') return 'research action:"sources"';
  if (action.id === 'research-report-artifacts') return 'research action:"reports"';
  if (action.id === 'work-background-processes') return 'execution action:"processes"';
  if (action.id === 'work-process-capabilities') return 'process action:"capabilities"';
  if (action.id === 'context-project-files') return 'context action:"files"';
  if (action.id === 'context-project-file') return 'context action:"file"';
  if (action.id === 'context-prompt-context') return 'context action:"prompt" includeParameters:true';
  if (action.id === 'voice-workflow-posture') return 'device action:"voice"';
  if (action.id === 'device-capability-map') return 'device action:"status"';
  if (action.id === 'browser-cockpit-readiness') return 'computer action:"browser"';
  if (action.id === 'personal-ops-briefing') return 'personal_ops action:"briefing"';
  if (action.id === 'personal-ops-queue') return 'personal_ops action:"queue"';
  if (action.id === 'personal-ops-intake') return 'personal_ops action:"intake"';
  if (
    action.id === 'personal-ops-autonomy-queue'
    || action.id === 'work-autonomy-queue'
    || action.id === 'schedule-autonomy-queue'
  ) return 'autonomy action:"queue"';
  if (action.id === 'memory-learning-curator') return 'memory action:"curator"';
  if (action.id === 'memory-prompt-plan') return 'memory action:"curator" includeParameters:true';
  if (action.kind === 'act' && action.act) return commandRouteHint(workspaceActionLine(action.act));
  if (action.command) return commandRouteHint(action.command);
  // Compatibility detail route remains: agent_harness mode:"open_ui_surface".
  if (action.targetCategoryId || action.kind === 'workspace') return 'workspace action:"open"';
  if (action.kind === 'guidance') return action.safety === 'blocked' ? 'main conversation policy' : 'main conversation';
  return 'workspace action:"action"';
}

/**
 * A row that runs a described command's action, as the model's command
 * catalogue gives that action: its line, blanks, sentence, what it touches and
 * whether only the owner may run it; the row's own preset values; and how to
 * run it (run_workspace_action with `fields` for the blanks, or run_command
 * with the whole line).
 */
function describedRow(action: AgentWorkspaceAction, withBlanks: boolean): Record<string, unknown> {
  if (action.kind !== 'act' || !action.act) return {};
  const resolved = resolveWorkspaceAction(action.act);
  const line = workspaceActionLine(action.act);
  if (!resolved) return { command: line, described: false };
  return {
    command: line,
    ...(action.act.values ? { presetValues: action.act.values } : {}),
    ...(withBlanks ? resolved.action ? { described: describeActionForModel(resolved.command, resolved.action) } : { described: describeCommandForModel(resolved.command) } : {}),
    modelExecution: {
      route: 'run_workspace_action',
      fields: 'the action\'s blanks by id, as in described.inputs',
      orRunCommand: `agent_harness mode:"run_command" command:"${line} ..."`,
      note: 'A blank left out is refused with its label and current choices; an owner-only action is refused for a model with what to do instead.',
    },
  };
}

/** The typed line a model's run of a row makes: the row's command and action, its preset values, then the model's `fields`. */
export function workspaceRowLine(action: AgentWorkspaceAction, fields: Readonly<Record<string, string>>): string | null {
  if (action.kind !== 'act' || !action.act) return null;
  const resolved = resolveWorkspaceAction(action.act);
  if (!resolved?.action) return workspaceActionLine(action.act);
  return renderTypedLine(resolved.command, resolved.action.id, { ...action.act.values, ...fields });
}

export function describeWorkspaceAction(
  category: AgentWorkspaceCategory,
  action: AgentWorkspaceAction,
  options: { readonly includeBlanks?: boolean; readonly lookup?: WorkspaceActionLookup } = {},
): Record<string, unknown> {
  return {
    id: action.id,
    categoryId: category.id,
    category: category.label,
    group: category.group,
    label: action.label,
    detail: action.detail,
    kind: action.kind,
    safety: action.safety,
    modelRoute: workspaceActionRouteHint(action),
    ...(action.command ? { command: action.command } : {}),
    ...describedRow(action, options.includeBlanks === true),
    ...(action.targetCategoryId ? { targetCategoryId: action.targetCategoryId } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(action.kind === 'settings-import' ? {
      modelExecution: {
        route: 'settings-import',
        dispatcher: 'run_workspace_action',
        admission: 'current recorded effect admission',
        preview: 'read-only',
        note: 'Imports only Agent-owned shared GoodVibes settings and provider subscription state through current recorded settings admission.',
      },
    } : {}),
    ...(action.id === 'assistant-browser-cockpit' ? {
      modelExecution: {
        route: 'open_ui_surface',
        surfaceId: 'connected-browser-cockpit',
        admission: 'current recorded effect admission',
        readinessRoute: 'agent_harness mode:"ui_surface" surfaceId:"connected-browser-cockpit" includeParameters:true',
        fallback: 'Inspect host action:"service" endpointId:"web" or host action:"services" when the web cockpit is not enabled.',
        note: 'Opens the connected-host browser/PWA cockpit through the configured web route; readiness inspection also reports certified workspace category coverage, mobile/PWA controls, and first-run receipt evidence without creating a separate Agent-hosted web app.',
      },
    } : {}),
  };
}

function describeWorkspaceActionSummary(
  category: AgentWorkspaceCategory,
  action: AgentWorkspaceAction,
): Record<string, unknown> {
  return {
    id: action.id,
    categoryId: category.id,
    category: category.label,
    group: category.group,
    label: action.label,
    summary: previewText(action.detail),
    kind: action.kind,
    safety: action.safety,
    modelRoute: workspaceActionRouteHint(action),
    ...(action.command ? { command: action.command } : {}),
    ...(action.act ? { command: workspaceActionLine(action.act) } : {}),
    ...(action.targetCategoryId ? { targetCategoryId: action.targetCategoryId } : {}),
  };
}

export async function listWorkspaceActions(
  context: CommandContext,
  args: AgentHarnessWorkspaceActionArgs,
  options: CatalogRankingOptions = {},
): Promise<readonly Record<string, unknown>[]> {
  return (await listWorkspaceActionsPage(context, args, options, 1000)).actions;
}

/**
 * One page of the workspace action catalog: `defaultLimit` rows unless the
 * caller names a `limit`, starting at `offset`, with how many matched in all.
 */
export async function listWorkspaceActionsPage(
  context: CommandContext,
  args: AgentHarnessWorkspaceActionArgs,
  options: CatalogRankingOptions = {},
  defaultLimit = 1000,
  maxLimit = 1000,
): Promise<{ readonly actions: readonly Record<string, unknown>[]; readonly offset: number; readonly matched: number }> {
  const request = captureStatefulCatalogRequest(context, args, options, [], () => [captureWorkspaceCategories()]);
  args = request.input;
  const query = readString(args.query);
  const categoryId = readString(args.categoryId || args.category);
  const limit = clampReadLimit(args.limit, defaultLimit, maxLimit);
  const offset = readOffset(args.offset);
  const includeBlanks = args.includeParameters === true;
  const entries = allWorkspaceActions().filter(entry => !categoryId || entry.category.id === categoryId);
  const categories = AGENT_WORKSPACE_CATEGORIES.filter(category => !categoryId || category.id === categoryId);
  const source = query ? await withModelReadingSource({ query, args, categories: AGENT_WORKSPACE_CATEGORIES },
    request.options, async (_captured, reading) => {
      const matches: { readonly entry: typeof entries[number]; readonly rankScore: number; readonly order: number }[] = [];
      const nativeOrder = new Map<AgentWorkspaceAction, number>(entries.map((entry, index) => [entry.action, index]));
      for (const category of categories) {
        reading.assertCurrent?.();
        const ranked = await rankHarnessCatalog(category.actions.map((action, index) => ({ index, action })), query,
          row => ({ id: String(row.index), description: row.action.label, evidence: { record: row.action } }),
          'agent.workspace.actions', { ...reading, requirePreservedSource: true }, 'engine.tools.registry-rank', { category, args });
        reading.assertCurrent?.();
        for (const match of ranked.matches) {
          if (ranked.provenance !== 'classic' && (match.judgment?.reading.outcome !== 'act' || match.judgment?.reading.verdict !== 'yes')) throw new ToolInputProjectionError('held');
          const action = category.actions[match.entry.index];
          const order = action && nativeOrder.get(action);
          if (!action || order === undefined) throw new ToolInputProjectionError('held');
          matches.push({ entry: originalWorkspaceEntry(entries, action), rankScore: match.judgment?.probability ?? match.score ?? 0, order });
        }
      }
      reading.assertCurrent?.();
      return matches.sort((left, right) => right.rankScore - left.rankScore || left.order - right.order).map(match => match.entry);
    }) : entries;
  request.assertCurrent();
  const actions = source
    .slice(offset, offset + limit)
    .map((entry) => includeBlanks
      ? describeWorkspaceAction(entry.category, entry.action, { includeBlanks })
      : describeWorkspaceActionSummary(entry.category, entry.action));
  return { actions, offset, matched: source.length };
}

function workspaceActionLookupFromArgs(args: AgentHarnessWorkspaceActionArgs): { readonly source: WorkspaceActionLookup['source']; readonly input: string } | null {
  const actionId = readString(args.actionId);
  if (actionId) return { source: 'actionId', input: actionId };
  const command = readString(args.command);
  if (command) return { source: 'command', input: command };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}


/** Native identity grammar only. Free prose must use the asynchronous complete selector. */
export function resolveWorkspaceActionIdentity(args: AgentHarnessWorkspaceActionArgs): WorkspaceActionResolution | null {
  const lookup = workspaceActionLookupFromArgs(args);
  const categoryId = readString(args.categoryId || args.category);
  if (!lookup) return null;
  const entries = allWorkspaceActions().filter((entry) => !categoryId || entry.category.id === categoryId);
  const normalized = lookup.input.toLowerCase();
  const commandInput = lookup.source === 'command' ? lookup.input.trim() : '';

  // Only an id names one action; a label or a command can be shared by several
  // categories ("Delete selected"), so a match on either that hits more than
  // one entry is ambiguous and names each candidate's id and category.
  type Entry = (typeof entries)[number];
  const settle = (matches: readonly Entry[], resolvedBy: WorkspaceActionLookup['resolvedBy']): WorkspaceActionResolution | null => {
    if (matches.length === 0) return null;
    if (matches.length === 1) return { status: 'found', ...matches[0]!, lookup: { ...lookup, resolvedBy } };
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: matches.map((entry) => ({
        actionId: entry.action.id,
        categoryId: entry.category.id,
        label: entry.action.label,
        ...(entry.action.command ? { command: entry.action.command } : entry.action.act ? { command: workspaceActionLine(entry.action.act) } : {}),
      })),
    };
  };
  return settle(entries.filter((entry) => entry.action.id === lookup.input), 'id')
    ?? settle(entries.filter((entry) => entry.action.label === lookup.input), 'label')
    ?? (commandInput ? settle(entries.filter((entry) => entry.action.command === commandInput || (entry.action.act !== undefined && workspaceActionLine(entry.action.act) === commandInput)), 'command') : null)
    ?? settle(entries.filter((entry) => entry.action.id.toLowerCase() === normalized), 'case-insensitive-id')
    ?? settle(entries.filter((entry) => entry.action.label.toLowerCase() === normalized), 'case-insensitive-label');
}

export async function resolveWorkspaceActionDetail(args: AgentHarnessWorkspaceActionArgs, options: CatalogRankingOptions = {}): Promise<WorkspaceActionResolution | null> {
  const request = captureCatalogReadRequest(args, options);
  args = request.input;
  const identity = resolveWorkspaceActionIdentity(args);
  if (identity) return identity;
  const lookup = workspaceActionLookupFromArgs(args);
  if (!lookup) return null;
  const categoryId = readString(args.categoryId || args.category);
  const entries = allWorkspaceActions().filter(entry => !categoryId || entry.category.id === categoryId);
  // One selector over every action, each described with its category, so a category and an action are found in one step.
  const selected = await selectHarnessCatalog(entries, lookup.input,
    entry => ({ id: entry.action.id, description: `${entry.category.label}: ${entry.action.label}` }), request.options, 'agent.workspace.action');
  request.assertCurrent();
  if (!selected) return null;
  return { status: 'found', ...selected, lookup: { ...lookup, resolvedBy: 'search' } };
}
