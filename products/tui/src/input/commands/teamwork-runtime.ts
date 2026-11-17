import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { join } from 'node:path';
import { AGENT_TEMPLATES } from '@goodvibes-jev/engine/platform/platform/tools';
import { archetypeFamilyOf, readArchetypeListing, type AgentArchetype, type ArchetypeFamily, type ArchetypeFamilyReading } from '@goodvibes-jev/engine/platform/platform/agents';
import { requireAgentManager, requireReadModels, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

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

interface TeamworkRecipe {
  readonly id: string;
  readonly summary: string;
  readonly steps: readonly string[];
}

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

const TEAMWORK_RECIPES: readonly TeamworkRecipe[] = [
  {
    id: 'research-implement-review',
    summary: 'Research first, implement second, certify through the canonical contract runner.',
    steps: ['research', 'local-engineer', 'review', 'verifier'],
  },
  {
    id: 'remote-certification',
    summary: 'Remote engineer execution with local review and integration.',
    steps: ['remote-engineer', 'review', 'integration'],
  },
  {
    id: 'triage-delegate-integrate',
    summary: 'Triage locally, delegate focused teammate work, then integrate.',
    steps: ['teammate', 'review', 'integration'],
  },
  {
    id: 'dream-then-certify',
    summary: 'Run a speculative research pass, then ground it through engineer, review, and verifier steps.',
    steps: ['dream', 'local-engineer', 'review', 'verifier'],
  },
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
  const cohort = `teamwork:${recipe.id}:${Date.now()}`;
  let previous: { readonly step: string; readonly output: string } | undefined;
  for (const [index, stepId] of recipe.steps.entries()) {
    const mode = TEAMWORK_MODES.find((entry) => entry.id === stepId)!;
    const context = previous
      ? `Step ${index + 1} of ${recipe.steps.length} of the ${recipe.id} recipe (${recipe.summary}). The ${previous.step} step reported:\n${previous.output.slice(0, STEP_HANDOFF_CHARS)}`
      : `Step 1 of ${recipe.steps.length} of the ${recipe.id} recipe (${recipe.summary}).`;
    let started: ReturnType<typeof startModeAgent>;
    try {
      started = startModeAgent(mode, title, manager, { sessionId: ctx.session.runtime.sessionId, context, cohort });
    } catch (error) {
      ctx.print(`[Teamwork ${recipe.id}] step ${index + 1} (${mode.id}) could not start: ${summarizeError(error)}. Not started: ${recipe.steps.slice(index).join(', ')}.`);
      return;
    }
    if (!started) {
      ctx.print(`[Teamwork ${recipe.id}] step ${index + 1} (${mode.id}) did not start: ${REMOTE_STEP_REFUSAL} Not started: ${recipe.steps.slice(index).join(', ')}.`);
      return;
    }
    ctx.print(`[Teamwork ${recipe.id}] step ${index + 1}/${recipe.steps.length} ${mode.id}: agent ${started.id} (${started.template}) started.`);
    await manager.join(started.id);
    const record = manager.getStatus(started.id);
    if (record?.status !== 'completed') {
      const later = recipe.steps.slice(index + 1);
      ctx.print(`[Teamwork ${recipe.id}] stopped at step ${index + 1} (${mode.id}): agent ${started.id} is ${record?.status ?? 'gone'}${record?.error ? ` (${record.error})` : ''}.${later.length > 0 ? ` Not started: ${later.join(', ')}.` : ''}`);
      return;
    }
    previous = { step: mode.id, output: record.fullOutput ?? record.progress ?? '(no output)' };
  }
  ctx.print(`[Teamwork ${recipe.id}] finished all ${recipe.steps.length} steps for "${title}"; /agents lists them under cohort ${cohort}.`);
}

const MODE_IDS = 'local-engineer|local-shell|remote-engineer|teammate|research|dream|review|verifier|integration';
const TEAMWORK_USAGE = 'Usage: /teamwork [review|modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id> [title...]|templates|archetypes|validate|archetype <name>|create-archetype <name> <title...>]';

export function registerTeamworkRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'teamwork',
    // A title is free text, kept as typed.
    rawRest: (args) => (['create-mode', 'recipe', 'create-archetype'].includes((args[0] ?? '').toLowerCase()) ? 2 : undefined),
    aliases: ['teammates'],
    description: 'Packaged task modes, teammate templates, and orchestration recipes; create-mode, create-archetype and recipe start the agents they describe',
    usage: `[review|modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id> [title...]|templates|archetypes|validate|archetype <name>|create-archetype <name> <title...>]`,
    async handler(args, ctx) {
      // One read of the agents directory through the loader spawns use; each family is a fact of its archetype.
      const listArchetypeModes = (): ResolvedArchetypeMode[] => readArchetypeListing(join(requireShellPaths(ctx).workingDirectory, '.goodvibes', 'agents'))
        .map((archetype) => buildArchetypeMode(archetype, archetypeFamilyOf(archetype)))
        .sort((a, b) => a.id.localeCompare(b.id));
      try {
        const sub = args[0]?.toLowerCase() ?? 'review';

        if (sub === 'review') {
          const snapshot = buildTeamworkReviewSnapshot(ctx, listArchetypeModes());
          ctx.print([
            'Teamwork Review',
            `  modes: ${TEAMWORK_MODES.length}`,
            `  recipes: ${TEAMWORK_RECIPES.length}`,
            `  builtin archetypes: ${snapshot.builtinArchetypes}`,
            `  custom archetypes: ${snapshot.customArchetypes}`,
            `  archetypes with issues: ${snapshot.archetypesWithIssues}`,
            `  archetypes without a declared family: ${snapshot.undeclaredArchetypes}`,
            `  implement/review/research: ${snapshot.implementArchetypes}/${snapshot.reviewArchetypes}/${snapshot.researchArchetypes}`,
            `  active tasks: ${snapshot.activeTaskCount}`,
            `  blocked tasks: ${snapshot.blockedTaskCount}`,
            `  review tasks: ${snapshot.reviewTaskCount}`,
            '  next: /teamwork archetypes',
            '  next: /teamwork validate',
            '  next: /tasks',
          ].join('\n'));
          return;
        }

        if (sub === 'modes') {
          ctx.print([
            'Teamwork Modes',
            ...TEAMWORK_MODES.map(formatMode),
          ].join('\n'));
          return;
        }

        if (sub === 'mode') {
          const modeId = args[1] as TeamworkModeId | undefined;
          const mode = TEAMWORK_MODES.find((entry) => entry.id === modeId);
          if (!mode) {
            ctx.print(`Usage: /teamwork mode <${MODE_IDS}>`);
            return;
          }
          ctx.print([
            `Teamwork Mode ${mode.id}`,
            `  label: ${mode.label}`,
            `  taskKind: ${mode.taskKind}`,
            `  owner: ${mode.owner}`,
            `  template: ${mode.template ?? '(none)'}`,
            `  executionProtocol: ${mode.executionProtocol}`,
          ].join('\n'));
          return;
        }

        if (sub === 'create-mode') {
          const modeId = args[1] as TeamworkModeId | undefined;
          const title = args.slice(2).join(' ').trim();
          const mode = TEAMWORK_MODES.find((entry) => entry.id === modeId);
          if (!mode || !title) {
            ctx.print(`Usage: /teamwork create-mode <${MODE_IDS}> <title...>`);
            return;
          }
          const started = startModeAgent(mode, title, requireAgentManager(ctx), { sessionId: ctx.session.runtime.sessionId });
          ctx.print(started
            ? `Started agent ${started.id} (${started.template}, ${mode.executionProtocol}) for "${title}" in mode ${mode.id}; /agents shows its progress.`
            : `Nothing was started: ${REMOTE_STEP_REFUSAL}`);
          return;
        }

        if (sub === 'recipes') {
          ctx.print([
            'Teamwork Recipes',
            ...TEAMWORK_RECIPES.map((recipe) => `  ${recipe.id.padEnd(26)} ${recipe.summary}`),
            '  run one with /teamwork recipe <id> <title...>',
          ].join('\n'));
          return;
        }

        if (sub === 'recipe') {
          const recipeId = args[1];
          const title = args.slice(2).join(' ').trim();
          const recipe = TEAMWORK_RECIPES.find((entry) => entry.id === recipeId);
          if (!recipe) {
            ctx.print('Usage: /teamwork recipe <id> [title...]  (with a title it runs the steps)');
            return;
          }
          if (!title) {
            ctx.print([
              `Teamwork Recipe ${recipe.id}`,
              `  summary: ${recipe.summary}`,
              `  steps: ${recipe.steps.join(' -> ')}`,
              `  run: /teamwork recipe ${recipe.id} <title...>`,
            ].join('\n'));
            return;
          }
          // The steps run one after another in the background; each prints when it starts and how it ended.
          void runRecipe(recipe, title, ctx, requireAgentManager(ctx)).catch((error) => {
            ctx.print(`[Teamwork ${recipe.id}] stopped: ${summarizeError(error)}`);
          });
          return;
        }

        if (sub === 'templates') {
          const archetypes = listArchetypeModes();
          ctx.print([
            'Teamwork Templates',
            ...Object.entries(AGENT_TEMPLATES).map(([name, template]) => (
              `  ${name.padEnd(12)} ${template.description}`
            )),
            '',
            'Discovered Archetypes',
            ...archetypes.map((entry) => `  ${entry.id.padEnd(12)} ${familyLabel(entry).padEnd(10)} ${entry.source.padEnd(7)} ${entry.label}`),
          ].join('\n'));
          return;
        }

        if (sub === 'archetypes') {
          const archetypes = listArchetypeModes();
          ctx.print([
            'Teamwork Archetypes',
            ...archetypes.map((entry) => `  ${entry.id.padEnd(18)} ${familyLabel(entry).padEnd(10)} ${entry.source.padEnd(7)} ${protocolLabel(entry)}${entry.validationIssues.length > 0 ? '  issues' : ''}`),
          ].join('\n'));
          return;
        }

        if (sub === 'validate') {
          const archetypes = listArchetypeModes();
          const invalid = archetypes.filter((entry) => entry.validationIssues.length > 0 || entry.reading === 'undeclared');
          ctx.print(invalid.length > 0
            ? [
                'Teamwork Archetype Validation',
                ...invalid.flatMap((entry) => [
                  `  ${entry.id} (${entry.source})`,
                  ...entry.validationIssues.map((issue) => `    issue: ${issue}`),
                  ...(entry.reading === 'undeclared' ? [`    family: ${entry.reason}`] : []),
                ]),
              ].join('\n')
            : 'Teamwork Archetype Validation\n  All discovered archetypes are currently valid.');
          return;
        }

        if (sub === 'archetype') {
          const archetypeName = args[1];
          if (!archetypeName) {
            ctx.print('Usage: /teamwork archetype <name>');
            return;
          }
          const mode = listArchetypeModes().find((entry) => entry.id === archetypeName);
          if (!mode) {
            ctx.print(`Unknown archetype: ${archetypeName}`);
            return;
          }
          ctx.print([
            `Teamwork Archetype ${mode.id}`,
            `  label: ${mode.label}`,
            `  family: ${familyLabel(mode)}${mode.reading === 'undeclared' ? ` (${mode.reason})` : ''}`,
            `  source: ${mode.source}`,
            `  owner: ${mode.owner}`,
            `  executionProtocol: ${protocolLabel(mode)}`,
            `  tools: ${mode.tools.join(', ') || '(none)'}`,
            `  sourcePath: ${mode.sourcePath ?? '(builtin)'}`,
            ...(mode.validationIssues.length > 0
              ? mode.validationIssues.map((issue) => `  issue: ${issue}`)
              : ['  validation: clean']),
          ].join('\n'));
          return;
        }

        if (sub === 'create-archetype') {
          const archetypeName = args[1];
          const title = args.slice(2).join(' ').trim();
          if (!archetypeName || !title) {
            ctx.print('Usage: /teamwork create-archetype <name> <title...>');
            return;
          }
          const mode = listArchetypeModes().find((entry) => entry.id === archetypeName);
          if (!mode) {
            ctx.print(`Unknown archetype: ${archetypeName}`);
            return;
          }
          if (mode.validationIssues.length > 0) {
            ctx.print(`Archetype ${mode.id} cannot be started: ${mode.validationIssues.join('; ')}. /teamwork validate lists what to fix.`);
            return;
          }
          const record = requireAgentManager(ctx).spawn({
            mode: 'spawn',
            task: title,
            template: mode.id,
            sessionId: ctx.session.runtime.sessionId,
            ...(mode.reading === 'settled' ? { executionProtocol: mode.executionProtocol } : {}),
          });
          ctx.print(`Started agent ${record.id} from archetype ${mode.id} (${familyLabel(mode)}, ${protocolLabel(mode)}) for "${title}"; /agents shows its progress.${mode.reading === 'undeclared' ? ` Its family is not declared, so it runs with its template's own protocol: ${mode.reason}.` : ''}`);
          return;
        }

        ctx.print(TEAMWORK_USAGE);
      } catch (error) {
        ctx.print(`/teamwork failed: ${summarizeError(error)}`);
      }
    },
  });
}
