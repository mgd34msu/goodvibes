/**
 * The terminal app's team modes, recipes and archetypes for `/agents`
 * (terminal-shell/agents-command.ts): how each mode and recipe runs, and the
 * archetypes read from this project's agents folder.
 */
import type { CommandContext } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { TEAM_MODES, TEAM_RECIPES, type AgentsHost } from '@goodvibes/engine/terminal-shell/agents-command';
import { join } from 'node:path';
import { AGENT_TEMPLATES } from '@goodvibes/engine/platform/platform/tools';
import { archetypeFamilyOf, readArchetypeListing, type AgentArchetype, type ArchetypeFamily, type ArchetypeFamilyReading } from '@goodvibes/engine/platform/platform/agents';
import { requireAgentManager, requireReadModels, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

type TeamworkModeId =
  | 'local-engineer'
  | 'local-shell'
  | 'remote-engineer'
  | 'teammate'
  | 'research'
  | 'dream'
  | 'review'
  | 'verifier'
  | 'integration';

interface TeamworkMode {
  readonly id: TeamworkModeId;
  readonly label: string;
  readonly taskKind: 'agent' | 'exec' | 'acp' | 'integration';
  readonly owner: string;
  readonly template?: keyof typeof AGENT_TEMPLATES;
  readonly executionProtocol: 'direct' | 'gather-plan-apply';
}

type TeamworkRecipe = (typeof TEAM_RECIPES)[number];

interface ArchetypeModeDetails {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly taskKind: 'agent' | 'exec' | 'acp' | 'integration';
  readonly template?: string;
  readonly source: 'builtin' | 'custom';
  readonly sourcePath?: string;
  readonly validationIssues: readonly string[];
  readonly tools: readonly string[];
}

type ResolvedArchetypeMode = ArchetypeModeDetails & (
  | { readonly reading: 'settled'; readonly family: ArchetypeFamily; readonly executionProtocol: 'direct' | 'gather-plan-apply' }
  | { readonly reading: 'undeclared'; readonly reason: string }
);
const familyLabel = (mode: ResolvedArchetypeMode) => mode.reading === 'settled' ? mode.family : 'undeclared';
const protocolLabel = (mode: ResolvedArchetypeMode) => mode.reading === 'settled' ? mode.executionProtocol : 'template default';

interface TeamworkReviewSnapshot {
  readonly builtinArchetypes: number;
  readonly customArchetypes: number;
  readonly archetypesWithIssues: number;
  readonly undeclaredArchetypes: number;
  readonly implementArchetypes: number;
  readonly reviewArchetypes: number;
  readonly researchArchetypes: number;
  readonly activeTaskCount: number;
  readonly blockedTaskCount: number;
  readonly reviewTaskCount: number;
}

const TEAMWORK_MODES: readonly TeamworkMode[] = [
  { id: 'local-engineer', label: 'Local engineer task', taskKind: 'agent', owner: 'local-engineer', template: 'engineer', executionProtocol: 'gather-plan-apply' },
  { id: 'local-shell', label: 'Local shell task', taskKind: 'exec', owner: 'local-shell', executionProtocol: 'direct' },
  { id: 'remote-engineer', label: 'Remote engineer task', taskKind: 'acp', owner: 'remote-engineer', template: 'engineer', executionProtocol: 'gather-plan-apply' },
  { id: 'teammate', label: 'In-process teammate task', taskKind: 'agent', owner: 'teammate', template: 'general', executionProtocol: 'gather-plan-apply' },
  { id: 'research', label: 'Research task', taskKind: 'agent', owner: 'research', template: 'researcher', executionProtocol: 'gather-plan-apply' },
  { id: 'dream', label: 'Speculative dream task', taskKind: 'agent', owner: 'dream', template: 'researcher', executionProtocol: 'gather-plan-apply' },
  { id: 'review', label: 'Review-only task', taskKind: 'agent', owner: 'review', template: 'reviewer', executionProtocol: 'gather-plan-apply' },
  { id: 'verifier', label: 'Verifier task', taskKind: 'agent', owner: 'verifier', template: 'reviewer', executionProtocol: 'gather-plan-apply' },
  { id: 'integration', label: 'Integration task', taskKind: 'integration', owner: 'integration', template: 'engineer', executionProtocol: 'gather-plan-apply' },
];


function formatMode(mode: TeamworkMode): string {
  return `  ${mode.id.padEnd(18)} ${mode.taskKind.padEnd(11)} ${mode.owner.padEnd(16)} ${mode.executionProtocol}${mode.template ? `  template=${mode.template}` : ''}`;
}

function buildArchetypeMode(archetype: AgentArchetype, reading: ArchetypeFamilyReading): ResolvedArchetypeMode {
  const source = archetype.isCustom ? 'custom' : 'builtin';
  const details: ArchetypeModeDetails = {
    id: archetype.name,
    label: archetype.description || `${archetype.name} archetype`,
    owner: source === 'custom' ? `custom:${archetype.name}` : archetype.name,
    taskKind: 'agent', template: archetype.name, source,
    ...(archetype.sourcePath === undefined ? {} : { sourcePath: archetype.sourcePath }),
    validationIssues: archetype.validationIssues ?? [], tools: archetype.tools,
  };
  if (reading.kind === 'undeclared') return { ...details, reading: 'undeclared', reason: reading.reason };
  return { ...details, reading: 'settled', family: reading.family,
    executionProtocol: reading.family === 'implement' || reading.family === 'research' ? 'gather-plan-apply' : 'direct' };
}

function buildTeamworkReviewSnapshot(ctx: CommandContext, archetypes: readonly ResolvedArchetypeMode[]): TeamworkReviewSnapshot {
  const tasks = [...requireReadModels(ctx).tasks.getSnapshot().tasks];
  return {
    builtinArchetypes: archetypes.filter((entry) => entry.source === 'builtin').length,
    customArchetypes: archetypes.filter((entry) => entry.source === 'custom').length,
    undeclaredArchetypes: archetypes.filter((entry) => entry.reading === 'undeclared').length,
    archetypesWithIssues: archetypes.filter((entry) => entry.validationIssues.length > 0).length,
    implementArchetypes: archetypes.filter((entry) => entry.reading === 'settled' && entry.family === 'implement').length,
    reviewArchetypes: archetypes.filter((entry) => entry.reading === 'settled' && entry.family === 'review').length,
    researchArchetypes: archetypes.filter((entry) => entry.reading === 'settled' && entry.family === 'research').length,
    activeTaskCount: tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
    blockedTaskCount: tasks.filter((task) => task.status === 'blocked').length,
    reviewTaskCount: tasks.filter((task) => task.owner === 'review' || task.owner === 'verifier').length,
  };
}

type AgentManagerLike = ReturnType<typeof requireAgentManager>;

/** What `/remote dispatch` is for: a remote engineer runs on a remote runner, which only a typed command starts. */
const REMOTE_STEP_REFUSAL = 'A remote engineer runs on a remote runner, started with /remote dispatch engineer <description> typed in the terminal.';

/** Start the agent a mode describes; null for a mode that runs remotely. */
function startModeAgent(mode: TeamworkMode, title: string, manager: AgentManagerLike, extra: { readonly sessionId: string; readonly context?: string; readonly cohort?: string }): { readonly id: string; readonly template: string } | null {
  if (mode.taskKind === 'acp') return null;
  const template = mode.template ?? 'general';
  const record = manager.spawn({
    mode: 'spawn',
    task: title,
    template,
    executionProtocol: mode.executionProtocol,
    // The session's own agent: its model lists and reads it with the agent tool.
    sessionId: extra.sessionId,
    ...(extra.context ? { context: extra.context } : {}),
    ...(extra.cohort ? { cohort: extra.cohort } : {}),
  });
  return { id: record.id, template };
}

/** The most of a step's output handed to the next step. */
const STEP_HANDOFF_CHARS = 8_000;

/**
 * Run a recipe's steps in order, each as an agent that starts when the one
 * before it completed, with that step's result as context. A step that does
 * not complete stops the recipe and says which steps did not start.
 */
async function runRecipe(recipe: TeamworkRecipe, title: string, ctx: CommandContext, manager: AgentManagerLike): Promise<void> {
  const cohort = `teamwork:${recipe.value}:${Date.now()}`;
  let previous: { readonly step: string; readonly output: string } | undefined;
  for (const [index, stepId] of recipe.steps.entries()) {
    const mode = TEAMWORK_MODES.find((entry) => entry.id === stepId)!;
    const context = previous
      ? `Step ${index + 1} of ${recipe.steps.length} of the ${recipe.value} recipe (${recipe.help}). The ${previous.step} step reported:\n${previous.output.slice(0, STEP_HANDOFF_CHARS)}`
      : `Step 1 of ${recipe.steps.length} of the ${recipe.value} recipe (${recipe.help}).`;
    let started: ReturnType<typeof startModeAgent>;
    try {
      started = startModeAgent(mode, title, manager, { sessionId: ctx.session.runtime.sessionId, context, cohort });
    } catch (error) {
      ctx.print(`[Recipe ${recipe.value}] step ${index + 1} (${mode.id}) could not start: ${summarizeError(error)}. Not started: ${recipe.steps.slice(index).join(', ')}.`);
      return;
    }
    if (!started) {
      ctx.print(`[Recipe ${recipe.value}] step ${index + 1} (${mode.id}) did not start: ${REMOTE_STEP_REFUSAL} Not started: ${recipe.steps.slice(index).join(', ')}.`);
      return;
    }
    ctx.print(`[Recipe ${recipe.value}] step ${index + 1}/${recipe.steps.length} ${mode.id}: agent ${started.id} (${started.template}) started.`);
    await manager.join(started.id);
    const record = manager.getStatus(started.id);
    if (record?.status !== 'completed') {
      const later = recipe.steps.slice(index + 1);
      ctx.print(`[Recipe ${recipe.value}] stopped at step ${index + 1} (${mode.id}): agent ${started.id} is ${record?.status ?? 'gone'}${record?.error ? ` (${record.error})` : ''}.${later.length > 0 ? ` Not started: ${later.join(', ')}.` : ''}`);
      return;
    }
    previous = { step: mode.id, output: record.fullOutput ?? record.progress ?? '(no output)' };
  }
  ctx.print(`[Recipe ${recipe.value}] finished all ${recipe.steps.length} steps for "${title}"; /agents open lists them under cohort ${cohort}.`);
}

/** The team part of `/agents` in this app. */
export function teamHost(): Exclude<AgentsHost<CommandContext>['team'], { readonly unavailable: string }> {
  // One read of the agents directory through the loader spawns use; each family is a fact of its archetype.
  const listArchetypeModes = (ctx: CommandContext): ResolvedArchetypeMode[] => readArchetypeListing(join(requireShellPaths(ctx).workingDirectory, '.goodvibes', 'agents'))
    .map((archetype) => buildArchetypeMode(archetype, archetypeFamilyOf(archetype)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const findArchetype = (ctx: CommandContext, name: string): ResolvedArchetypeMode => {
    const mode = listArchetypeModes(ctx).find((entry) => entry.id === name);
    if (!mode) throw commandRefusal(`No archetype is named ${name}.`, '/agents archetypes lists them.');
    return mode;
  };
  return {
    review(ctx) {
      const snapshot = buildTeamworkReviewSnapshot(ctx, listArchetypeModes(ctx));
      return [
        'Team modes (/agents start <mode> <what to do>)',
        ...TEAMWORK_MODES.map((mode) => `${formatMode(mode)}  ${TEAM_MODES.find((entry) => entry.value === mode.id)?.label ?? ''}`),
        '',
        'Recipes (/agents recipe <recipe> <what to do>)',
        ...TEAM_RECIPES.map((recipe) => `  ${recipe.value.padEnd(26)} ${recipe.steps.join(' -> ')}\n    ${recipe.help ?? ''}`),
        '',
        'Agent templates',
        ...Object.entries(AGENT_TEMPLATES).map(([name, template]) => `  ${name.padEnd(12)} ${template.description}`),
        '',
        `Archetypes: ${snapshot.builtinArchetypes} built in, ${snapshot.customArchetypes} in this project, ${snapshot.archetypesWithIssues} with problems, ${snapshot.undeclaredArchetypes} without a declared family (/agents archetypes)`,
        `  implement/review/research: ${snapshot.implementArchetypes}/${snapshot.reviewArchetypes}/${snapshot.researchArchetypes}`,
        `Tasks: ${snapshot.activeTaskCount} active, ${snapshot.blockedTaskCount} blocked, ${snapshot.reviewTaskCount} reviewing (/tasks)`,
      ].join('\n');
    },
    archetypes(ctx) {
      return listArchetypeModes(ctx).map((entry) => ({
        id: entry.id, label: entry.label, family: familyLabel(entry),
        issues: entry.validationIssues.length + (entry.reading === 'undeclared' ? 1 : 0),
      }));
    },
    archetypeReport(ctx, name) {
      const mode = findArchetype(ctx, name);
      return [
        `Archetype ${mode.id}`,
        `  label: ${mode.label}`,
        `  family: ${familyLabel(mode)}${mode.reading === 'undeclared' ? ` (${mode.reason})` : ''}`,
        `  source: ${mode.source}`,
        `  owner: ${mode.owner}`,
        `  works: ${protocolLabel(mode)}`,
        `  tools: ${mode.tools.join(', ') || '(none)'}`,
        `  defined in: ${mode.sourcePath ?? '(built in)'}`,
        ...(mode.validationIssues.length > 0 ? mode.validationIssues.map((issue) => `  problem: ${issue}`) : ['  problems: none']),
      ].join('\n');
    },
    startMode(ctx, modeId, title) {
      const mode = TEAMWORK_MODES.find((entry) => entry.id === modeId);
      if (!mode) throw commandRefusal(`No team mode is named ${modeId}.`, '/agents team lists them.');
      const started = startModeAgent(mode, title, requireAgentManager(ctx), { sessionId: ctx.session.runtime.sessionId });
      if (!started) throw commandRefusal(`Nothing was started: ${REMOTE_STEP_REFUSAL}`);
      return `Started agent ${started.id} (${started.template}, ${mode.executionProtocol}) for "${title}" in mode ${mode.id}; /agents open shows its progress.`;
    },
    runRecipe(ctx, recipeId, title) {
      const recipe = TEAM_RECIPES.find((entry) => entry.value === recipeId);
      if (!recipe) throw commandRefusal(`No recipe is named ${recipeId}.`, '/agents team lists them.');
      const manager = requireAgentManager(ctx);
      // The steps run one after another in the background; each prints when it starts and how it ended.
      void runRecipe(recipe, title, ctx, manager).catch((error) => {
        ctx.print(`[Recipe ${recipe.value}] stopped: ${summarizeError(error)}`);
      });
      return `Recipe ${recipe.value} started: ${recipe.steps.join(' -> ')}. Each step prints when it starts and how it ended.`;
    },
    startArchetype(ctx, name, title) {
      const mode = findArchetype(ctx, name);
      if (mode.validationIssues.length > 0) throw commandRefusal(`Archetype ${mode.id} cannot be started: ${mode.validationIssues.join('; ')}.`, `/agents archetype ${mode.id} shows what to fix.`);
      const record = requireAgentManager(ctx).spawn({
        mode: 'spawn',
        task: title,
        template: mode.id,
        sessionId: ctx.session.runtime.sessionId,
        ...(mode.reading === 'settled' ? { executionProtocol: mode.executionProtocol } : {}),
      });
      return `Started agent ${record.id} from archetype ${mode.id} (${familyLabel(mode)}, ${protocolLabel(mode)}) for "${title}"; /agents open shows its progress.${mode.reading === 'undeclared' ? ` Its family is not declared, so it runs with its template's own protocol: ${mode.reason}.` : ''}`;
    },
  };
}
