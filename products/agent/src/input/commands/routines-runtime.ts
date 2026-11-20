import { discoverRoutines, type DiscoveredRoutineRecord } from '../../agent/routine-discovery.ts';
import { AgentRoutineRegistry, evaluateAgentRoutineReadiness, type AgentRoutineRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import { assertActorMayEnable, assertActorMayMarkReviewed, type RegistryActor } from '@goodvibes-jev/engine/terminal-shell/agent-turn/review-authority';
import { buildAgentSkillRequirements, formatAgentSkillRequirement } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import {
  buildRoutineSchedulePreview,
  promoteRoutineToConnectedSchedule,
  resolveAgentConnectedHostConnection,
  routinePromotionBlockers,
  routineScheduleName,
  type RoutineSchedulePromotionPreview,
} from '../../agent/routine-schedule-promotion.ts';
import { parseChannelDeliveryTarget, parseLinkDeliveryTarget, parseRouteDeliveryTarget, parseWebhookDeliveryTarget, validateDeliveryTargets, type RoutineScheduleDeliveryTargetSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn/schedule-delivery-targets';
import type { ParsedRoutineSchedulePromotionArgs } from '../../agent/routine-schedule-promotion.ts';
import {
  formatRoutineScheduleCorrelation,
  formatRoutineScheduleFailure,
  formatRoutineSchedulePreview,
  formatRoutineScheduleReceipt,
  formatRoutineScheduleReceipts,
  formatRoutineScheduleSuccess,
} from '../../agent/routine-schedule-format.ts';
import {
  fetchLiveSchedules,
  reconcileRoutineScheduleReceipts,
  RoutineScheduleReceiptStore,
} from '../../agent/routine-schedule-receipts.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand, defineList, type ActionDescription, type ActionValues, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** Who the command acts for: the owner typing it, or the model running it. */
function actorOf(ctx: CommandContext): RegistryActor {
  return ctx.invokedByModel === true ? 'model' : 'owner';
}

function registryFromContext(ctx: CommandContext): AgentRoutineRegistry {
  return AgentRoutineRegistry.fromShellPaths(requireShellPaths(ctx));
}

function receiptStoreFromContext(ctx: CommandContext): RoutineScheduleReceiptStore {
  return RoutineScheduleReceiptStore.fromShellPaths(requireShellPaths(ctx));
}

function formatRoutineReceipt(title: string, routine: Pick<AgentRoutineRecord, 'id' | 'name'>, extra: readonly string[] = []): string {
  const enabled = extra.some((line) => line.trim() === 'enabled yes');
  return [
    `${title} ${routine.id}: ${routine.name}${enabled ? ' (enabled)' : ''}`,
    `  id ${routine.id}`,
    `  name ${routine.name}`,
    ...extra,
  ].join('\n');
}

function summarizeRoutine(routine: AgentRoutineRecord): string {
  const enabled = routine.enabled ? 'enabled' : 'disabled';
  const tags = routine.tags.length > 0 ? ` tags ${routine.tags.join(', ')}` : '';
  const readiness = evaluateAgentRoutineReadiness(routine);
  const review = formatAgentRecordReviewState(routine.reviewState);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(',')}`;
  return `  ${routine.id}  ${enabled}  ${review}  ${ready}  starts ${routine.startCount}  ${routine.name} - ${routine.description}${tags}`;
}

function renderList(title: string, registry: AgentRoutineRegistry, routines: readonly AgentRoutineRecord[], emptyMessage?: string): string {
  const snapshot = registry.snapshot();
  if (routines.length === 0) {
    return emptyMessage
      ? `${title}\n  ${emptyMessage}`
      : `${title}\n  No routines yet. Make one: /routines create --name <name> --description <summary> <steps>.`;
  }
  return [
    `${title} (${routines.length})`,
    `  store ${snapshot.path}`,
    `  enabled ${snapshot.enabledRoutines.length}`,
    ...routines.map(summarizeRoutine),
  ].join('\n');
}

function renderRoutine(routine: AgentRoutineRecord): string {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return [
    `Routine ${routine.name}`,
    `  id ${routine.id}`,
    `  enabled ${routine.enabled ? 'yes' : 'no'}`,
    `  readiness: ${readiness.ready ? 'ready' : 'needs setup'}`,
    `  requirements ${routine.requirements.map(formatAgentSkillRequirement).join(', ') || '(none)'}`,
    readiness.missing.length > 0 ? `  missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}` : '',
    `  review ${formatAgentRecordReviewState(routine.reviewState)}`,
    `  origin ${formatAgentRecordOrigin(routine.source, routine.provenance)}`,
    `  tags: ${routine.tags.join(', ') || '(none)'}`,
    `  triggers: ${routine.triggers.join(', ') || '(manual)'}`,
    `  started ${routine.startCount}${routine.lastStartedAt ? `; last ${routine.lastStartedAt}` : ''}`,
    `  created ${routine.createdAt}`,
    `  updated ${routine.updatedAt}`,
    routine.staleReason ? `  stale reason ${routine.staleReason}` : '',
    '',
    routine.description,
    '',
    routine.steps,
  ].filter(Boolean).join('\n');
}

function summarizeDiscoveredRoutine(routine: DiscoveredRoutineRecord): string {
  const description = routine.description ? ` - ${routine.description}` : '';
  return `  ${routine.name}  ${routine.origin}${description}\n    path ${routine.path}`;
}

function renderDiscoveredRoutines(routines: readonly DiscoveredRoutineRecord[]): string {
  if (routines.length === 0) {
    return [
      'Discovered Agent routine files',
      '  No routine markdown files found in project/global Agent routine folders.',
      '  Search roots: .goodvibes/routines, .goodvibes/agent/routines, ~/.goodvibes/routines, ~/.goodvibes/agent/routines',
    ].join('\n');
  }
  return [
    `Discovered Agent routine files (${routines.length})`,
    ...routines.map(summarizeDiscoveredRoutine),
    '',
    'Import one: /routines import <name>',
  ].join('\n');
}

function discoveredRoutineLookupValues(routine: DiscoveredRoutineRecord): readonly string[] {
  const slug = routine.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = routine.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [routine.name, slug, routine.path, basename].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredRoutine(routines: readonly DiscoveredRoutineRecord[], idOrName: string): DiscoveredRoutineRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return routines.find((routine) => discoveredRoutineLookupValues(routine).includes(lookup)) ?? null;
}

function frontmatterList(routine: DiscoveredRoutineRecord, key: string): readonly string[] {
  const value = routine.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

function frontmatterAnyList(routine: DiscoveredRoutineRecord, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = frontmatterList(routine, key);
    if (values.length > 0) return values;
  }
  return [];
}

/** Run one step against the routine store; a failure that is not a refusal is reported as one. */
function step<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

function latestAttemptFor(
  receipts: RoutineScheduleReceiptStore,
  baseUrl: string,
  preview: RoutineSchedulePromotionPreview,
) {
  // The receipt records the name the schedule was created under, which falls back to the routine's name.
  const scheduleName = routineScheduleName(preview);
  let latest: ReturnType<RoutineScheduleReceiptStore['get']> = null;
  for (const receipt of receipts.snapshot().receipts) {
    if (receipt.routineId !== preview.routineId || receipt.scheduleName !== scheduleName || receipt.connectedHostBaseUrl !== baseUrl) continue;
    if (!latest || receipt.createdAt > latest.createdAt) latest = receipt;
  }
  return latest;
}

/** Print the schedule preview, or, with --yes, create the connected schedule and record the receipt. */
async function runRoutineSchedulePromotion(
  ctx: CommandContext,
  routine: AgentRoutineRecord,
  parsed: ParsedRoutineSchedulePromotionArgs,
): Promise<void> {
  const preview = buildRoutineSchedulePreview(routine, parsed);
  const blockers = routinePromotionBlockers(routine);
  const readinessLines = blockers.length === 0
    ? []
    : ['', `Not ready to promote ${routine.id}:`, ...blockers.map((blocker) => `  ${blocker}`)];
  if (!parsed.yes) {
    ctx.print([formatRoutineSchedulePreview(preview), ...readinessLines].join('\n'));
    return;
  }
  if (blockers.length > 0) {
    ctx.print([`Refusing to promote ${routine.id}: no schedule was created.`, ...blockers.map((blocker) => `  ${blocker}`)].join('\n'));
    return;
  }
  const shellPaths = requireShellPaths(ctx);
  const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
  // A failure that does not say whether the host acted (dropped connection, timeout, host error) may
  // have left the schedule created, and a blind retry would create a second recurring one. Ask the
  // host first and let the earlier attempt's outcome decide.
  const receipts = receiptStoreFromContext(ctx);
  const scheduleName = routineScheduleName(preview);
  const earlier = latestAttemptFor(receipts, connection.baseUrl, preview);
  const earlierAmbiguous = earlier?.status === 'failed' && (earlier.failureKind === 'connected_host_unavailable' || earlier.failureKind === 'connected_host_error');
  // A repeat of a promotion that succeeded would create a second schedule with the same name.
  if (earlier && (earlier.status === 'created' || earlierAmbiguous)) {
    const live = await fetchLiveSchedules(connection);
    const existing = live.ok ? live.schedules.find((schedule) => schedule.name === scheduleName) : undefined;
    if (!live.ok || existing) {
      const origin = earlier.status === 'created' ? 'from the earlier promotion' : 'most likely from the earlier attempt';
      ctx.print(existing
        ? `A schedule named "${scheduleName}" (id ${existing.id}) already exists on the connected host, ${origin} (receipt ${earlier.id}). Nothing was created. Run /routines reconcile to review it, or promote with a different --name to create another.`
        : `An earlier promotion of this routine (receipt ${earlier.id}) ${earlier.status === 'created' ? 'created a schedule' : 'failed without a known outcome'}, and the connected host's schedules could not be read to check (${live.error ?? 'no detail'}). Nothing was created. Retry once the host is reachable.`);
      return;
    }
  }
  const result = await promoteRoutineToConnectedSchedule(connection, preview);
  // The host's answer is what the owner needs first; a receipt that cannot be written must not hide it
  // (a retry would create a second schedule).
  let receiptLine: string;
  try {
    receiptLine = `receipt: ${receipts.append(connection, preview, result).id}`;
  } catch (error) {
    receiptLine = `receipt not recorded: ${error instanceof Error ? error.message : String(error)}`;
  }
  ctx.print(`${result.ok ? formatRoutineScheduleSuccess(result) : formatRoutineScheduleFailure(result)}\n  ${receiptLine}`);
}

const ROUTINES = defineList<CommandContext>({
  name: 'routines',
  async read(ctx) {
    return registryFromContext(ctx).list().map((routine): ListRow => {
      const readiness = evaluateAgentRoutineReadiness(routine);
      return { value: routine.id, label: routine.name, detail: routine.description, state: !readiness.ready ? 'needs setup' : routine.enabled ? 'on' : 'off' };
    });
  },
  operator: { terminalOnly: 'Routines are kept in this Agent\'s home.' },
});
const DISCOVERED = defineList<CommandContext>({
  name: 'routines.discovered',
  async read(ctx) {
    return (await discoverRoutines(requireShellPaths(ctx))).map((routine): ListRow => ({ value: routine.name, label: routine.name, detail: routine.path, state: routine.origin }));
  },
  operator: { terminalOnly: 'Routine files are read from this machine.' },
});
const RECEIPTS = defineList<CommandContext>({
  name: 'routines.receipts',
  async read(ctx) {
    return receiptStoreFromContext(ctx).snapshot().receipts.map((receipt): ListRow => ({ value: receipt.id, label: receipt.scheduleName, detail: receipt.createdAt, state: receipt.status }));
  },
  operator: { terminalOnly: 'Schedule receipts are kept in this Agent\'s home.' },
});

const LOCAL_ONLY = { terminalOnly: 'Routines are kept in this Agent\'s home.' } as const;
const ROUTINE: InputDescription = listInput({ id: 'routine', label: 'Routine', help: 'Your routines', list: ROUTINES, other: 'a routine id or name' });
const OPTIONAL = (means: string) => ({ default: '', means });
const ENABLED: InputDescription = choiceInput({
  id: 'enabled', label: 'Switched on', help: 'Whether it may be started at once',
  choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Switched on' }],
  typed: { flag: '--enabled', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
});
const REVIEW_OWNER_ONLY = {
  reason: 'marking a routine reviewed is your decision that it may run',
  instead: 'Ask the owner to review it with /routines review.',
};

type RoutineAction = ActionDescription<CommandContext>;
function change(fields: Pick<RoutineAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<RoutineAction, 'risk' | 'undoneBy' | 'ownerOnly' | 'lasts' | 'touches' | 'operator' | 'stepTitles'>>): RoutineAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ...fields };
}

/** The schedule a promotion asks for, read from the values the way the old option parser read the line. */
function promotionOf(values: ActionValues): ParsedRoutineSchedulePromotionArgs {
  const errors: string[] = [];
  const deliveryTargets: RoutineScheduleDeliveryTargetSpec[] = [];
  const add = (raw: string | undefined, parse: (value: string) => RoutineScheduleDeliveryTargetSpec | string): void => {
    for (const value of (raw ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const target = parse(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
    }
  };
  add(values.channel, parseChannelDeliveryTarget);
  add(values.route, parseRouteDeliveryTarget);
  add(values.webhook, parseWebhookDeliveryTarget);
  add(values.link, parseLinkDeliveryTarget);
  const kind = values.how as 'cron' | 'every' | 'at';
  if (values.tz && kind !== 'cron') errors.push(`A time zone only applies to a calendar pattern; an "${kind}" schedule would ignore it.`);
  const deliveryError = validateDeliveryTargets(deliveryTargets, 'routine promotion command');
  if (deliveryError) errors.push(deliveryError);
  return {
    routineId: values.routine!, schedule: { kind, value: values.when! }, deliveryTargets,
    ...(values.name ? { name: values.name } : {}), ...(values.tz ? { timezone: values.tz } : {}),
    ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}),
    enabled: values.paused !== 'yes', yes: true, errors,
  };
}

export function registerRoutinesRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'routines',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Routines',
    summary: 'Repeatable steps the Agent runs when you ask, or on a schedule on the connected host',
    group: 'Agent',
    report: 'list',
    firstScreenRows: [
      'list', 'start', 'create', 'promote',
      { label: 'See, find or change a routine…', actions: ['show', 'search', 'update', 'enable', 'disable', 'review', 'stale', 'delete'] },
      { label: 'Import a routine file…', actions: ['discover', 'import'] },
      { label: 'Routines on a schedule…', actions: ['receipts', 'receipt', 'reconcile'] },
    ],
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your routines', readsOnlyThisMachine: true, word: 'list',
        inputs: [choiceInput({ id: 'only', label: 'Only', help: 'Some of them', choices: [{ value: 'enabled', label: 'Switched on' }, { value: 'attention', label: 'Needing setup' }], typed: { flag: '--only' }, optional: { default: '', means: 'all of them' } })],
        sentence: 'Lists your routines: whether each is on, reviewed and ready, and how often it was started.', example: { only: 'enabled' }, operator: LOCAL_ONLY,
        async rowValue(ctx) {
          const snapshot = registryFromContext(ctx).snapshot();
          const all = registryFromContext(ctx).list().length;
          return all === 0 ? 'none yet' : `${all} routine${all === 1 ? '' : 's'}, ${snapshot.enabledRoutines.length} on`;
        },
        async run(values, ctx) {
          const store = registryFromContext(ctx);
          if (values.only === 'enabled') return renderList('Routines switched on', store, store.snapshot().enabledRoutines);
          if (values.only === 'attention') return renderList('Routines needing setup', store, store.list().filter((routine) => !evaluateAgentRoutineReadiness(routine).ready), 'No routine needs setup.');
          return renderList('Routines', store, store.list());
        },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'See one routine', word: 'show', inputs: [ROUTINE],
        sentence: 'Shows routine {routine} in full: its steps, what it needs, and its review state.', example: { routine: 'morning-brief' }, operator: LOCAL_ONLY,
        async run(values, ctx) {
          const routine = registryFromContext(ctx).get(values.routine!);
          if (!routine) throw commandRefusal(`No routine ${values.routine}.`, '/routines list shows them.');
          return renderRoutine(routine);
        },
      }),
      readAction<CommandContext>({
        id: 'search', label: 'Find a routine', word: 'search',
        inputs: [textInput({ id: 'words', label: 'Words', help: 'What to look for in their names, steps and tags', why: 'your own words', typed: { tail: true } })],
        sentence: 'Lists the routines that mention {words}.', example: { words: 'invoices' }, operator: LOCAL_ONLY,
        async run(values, ctx) { const store = registryFromContext(ctx); return renderList(`Routines matching "${values.words}"`, store, store.search(values.words!)); },
      }),
      change({
        id: 'create', label: 'Make a routine', word: 'create',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'What it is called', why: 'a name you choose', typed: { flag: '--name' } }),
          textInput({ id: 'description', label: 'Summary', help: 'One line on what it does', why: 'your own words', typed: { flag: '--description' } }),
          textInput({ id: 'steps', label: 'Steps', help: 'What the Agent does, step by step', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          textInput({ id: 'env', label: 'Needs settings', help: 'Environment variables it needs, separated by commas', why: 'variable names', typed: { flag: '--requires-env' }, optional: OPTIONAL('none') }),
          textInput({ id: 'commands', label: 'Needs programs', help: 'Programs it needs on this machine, separated by commas', why: 'program names', typed: { flag: '--requires-command' }, optional: OPTIONAL('none') }),
          textInput({ id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: OPTIONAL('none') }),
          textInput({ id: 'triggers', label: 'When to suggest it', help: 'Words that bring it up, separated by commas', why: 'your own words', typed: { flag: '--triggers' }, optional: OPTIONAL('only when you ask') }),
          ENABLED,
        ],
        sentence: 'A routine {name} ("{description}") is kept with the steps "{steps}", until you change it.', example: { name: 'morning-brief', description: 'Summarise my morning', steps: 'Read my inbox and calendar, then summarise.' },
        undoneBy: 'delete',
        async run(values, ctx) {
          if (values.enabled === 'yes') assertActorMayEnable(actorOf(ctx), 'routine', values.name!, 'fresh');
          const routine = step(() => registryFromContext(ctx).create({
            name: values.name!, description: values.description!, steps: values.steps!, triggers: splitList(values.triggers), tags: splitList(values.tags),
            requirements: buildAgentSkillRequirements({ env: splitList(values.env), commands: splitList(values.commands) }),
            enabled: values.enabled === 'yes', source: 'user', provenance: 'Command',
          }));
          return formatRoutineReceipt('Made routine', routine);
        },
      }),
      change({
        id: 'update', label: 'Change a routine', word: 'update',
        inputs: [
          ROUTINE,
          textInput({ id: 'name', label: 'Name', help: 'A new name', why: 'a name you choose', typed: { flag: '--name' }, optional: OPTIONAL('keep it') }),
          textInput({ id: 'description', label: 'Summary', help: 'A new one-line summary', why: 'your own words', typed: { flag: '--description' }, optional: OPTIONAL('keep it') }),
          textInput({ id: 'steps', label: 'Steps', help: 'New steps', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: OPTIONAL('keep them') }),
          textInput({ id: 'env', label: 'Needs settings', help: 'New environment variables it needs', why: 'variable names', typed: { flag: '--requires-env' }, optional: OPTIONAL('keep them') }),
          textInput({ id: 'commands', label: 'Needs programs', help: 'New programs it needs', why: 'program names', typed: { flag: '--requires-command' }, optional: OPTIONAL('keep them') }),
          textInput({ id: 'tags', label: 'Tags', help: 'New tags', why: 'your own words', typed: { flag: '--tags' }, optional: OPTIONAL('keep them') }),
          textInput({ id: 'triggers', label: 'When to suggest it', help: 'New words that bring it up', why: 'your own words', typed: { flag: '--triggers' }, optional: OPTIONAL('keep them') }),
        ],
        sentence: 'Routine {routine} takes the changes given, until you change it.', example: { routine: 'morning-brief', steps: 'Read my inbox only.' },
        async run(values, ctx) {
          const store = registryFromContext(ctx);
          const existing = store.get(values.routine!);
          // A kind of requirement not given keeps what the routine already requires of that kind.
          const kept = (kind: 'env' | 'command'): readonly string[] => (existing?.requirements ?? []).filter((requirement) => requirement.kind === kind).map((requirement) => requirement.name);
          const updated = step(() => store.update(values.routine!, {
            name: values.name || undefined, description: values.description || undefined, steps: values.steps || undefined,
            triggers: values.triggers ? splitList(values.triggers) : undefined, tags: values.tags ? splitList(values.tags) : undefined,
            requirements: values.env || values.commands
              ? buildAgentSkillRequirements({ env: values.env ? splitList(values.env) : kept('env'), commands: values.commands ? splitList(values.commands) : kept('command') })
              : undefined,
            provenance: 'Command',
          }));
          return formatRoutineReceipt('Changed routine', updated);
        },
      }),
      change({
        id: 'enable', label: 'Switch a routine on', word: 'enable', inputs: [ROUTINE],
        sentence: 'Routine {routine} may be started, until you change it.', example: { routine: 'morning-brief' }, undoneBy: 'disable',
        async run(values, ctx) {
          const store = registryFromContext(ctx);
          assertActorMayEnable(actorOf(ctx), 'routine', values.routine!, store.get(values.routine!)?.reviewState);
          return formatRoutineReceipt('Switched on routine', step(() => store.setEnabled(values.routine!, true)));
        },
      }),
      change({
        id: 'disable', label: 'Switch a routine off', word: 'disable', inputs: [ROUTINE],
        sentence: 'Routine {routine} is not started, until you change it.', example: { routine: 'morning-brief' }, undoneBy: 'enable',
        async run(values, ctx) { return formatRoutineReceipt('Switched off routine', step(() => registryFromContext(ctx).setEnabled(values.routine!, false))); },
      }),
      change({
        id: 'start', label: 'Start a routine', word: 'start', inputs: [ROUTINE],
        sentence: 'The steps of routine {routine} are sent as your next message in this conversation.', example: { routine: 'morning-brief' }, lasts: 'not-a-change',
        async run(values, ctx) {
          const store = registryFromContext(ctx);
          const found = store.get(values.routine!);
          if (!found) throw commandRefusal(`No routine ${values.routine}.`, '/routines list shows them.');
          const readiness = evaluateAgentRoutineReadiness(found);
          const readinessLine = `  readiness: ${readiness.ready ? 'ready' : `needs setup (${readiness.missing.map(formatAgentSkillRequirement).join(', ')})`}`;
          // A model running the command reads the printed steps as its tool result,
          // so the print is the start. The owner's start sends the steps as a message,
          // since printed text is display-only and never reaches the model.
          if (ctx.invokedByModel !== true) {
            if (!ctx.submitTurn) throw commandRefusal([`Not started: routine ${found.id} runs as a message in the conversation, and this surface cannot send one.`, readinessLine, '', found.steps].join('\n'));
            const routine = step(() => store.markStarted(found.id));
            ctx.submitTurn(`Run Agent routine ${routine.name} (${routine.id}).\n\n${routine.steps}`);
            return [`Started routine ${routine.id}: its steps were sent as your next message (after the current turn, if one is running).`, readinessLine].join('\n');
          }
          const routine = step(() => store.markStarted(found.id));
          return [
            `Started routine ${routine.id} (${routine.name})`,
            readinessLine,
            '  the same conversation; no hidden job, setting change or outside action was started',
            '',
            routine.steps,
          ].join('\n');
        },
      }),
      change({
        id: 'review', label: 'Mark a routine reviewed', word: 'review', inputs: [ROUTINE],
        sentence: 'Routine {routine} is marked reviewed, so it may be switched on and run, until you change it.', example: { routine: 'morning-brief' },
        risk: 'loosens-a-protection', ownerOnly: REVIEW_OWNER_ONLY, undoneBy: 'stale',
        async run(values, ctx) {
          assertActorMayMarkReviewed(actorOf(ctx), 'routine', values.routine!);
          return formatRoutineReceipt('Reviewed routine', step(() => registryFromContext(ctx).markReviewed(values.routine!)));
        },
      }),
      change({
        id: 'stale', label: 'Mark a routine out of date', word: 'stale',
        inputs: [ROUTINE, textInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Routine {routine} is marked out of date because "{reason}", until you change it.', example: { routine: 'morning-brief', reason: 'the inbox moved' },
        async run(values, ctx) { return formatRoutineReceipt('Marked out of date', step(() => registryFromContext(ctx).markStale(values.routine!, values.reason!))); },
      }),
      change({
        id: 'delete', label: 'Delete a routine', word: 'delete', inputs: [ROUTINE],
        sentence: 'Routine {routine} is removed from this Agent.', example: { routine: 'morning-brief' }, risk: 'cannot-be-undone',
        async run(values, ctx) { return formatRoutineReceipt('Deleted routine', step(() => registryFromContext(ctx).deleteRoutine(values.routine!))); },
      }),
      readAction<CommandContext>({
        id: 'discover', label: 'See routine files you could import', word: 'discover',
        sentence: 'Lists the routine Markdown files in this project\'s and your own routine folders.', operator: { terminalOnly: 'Routine files are read from this machine.' },
        async run(_values, ctx) { return renderDiscoveredRoutines(await discoverRoutines(requireShellPaths(ctx))); },
      }),
      change({
        id: 'import', label: 'Import a routine file', word: 'import',
        inputs: [listInput({ id: 'file', label: 'Routine file', help: 'Routine files found in your routine folders', list: DISCOVERED, other: 'a routine file name or path' }), ENABLED],
        sentence: 'The routine in {file} is added to this Agent, not yet reviewed, until you change it.', example: { file: 'morning-brief' }, undoneBy: 'delete',
        async run(values, ctx) {
          const discovered = findDiscoveredRoutine(await discoverRoutines(requireShellPaths(ctx)), values.file!);
          if (!discovered) throw commandRefusal(`No routine file ${values.file}.`, '/routines discover lists them.');
          if (values.enabled === 'yes') assertActorMayEnable(actorOf(ctx), 'routine', discovered.name, 'fresh');
          const routine = step(() => registryFromContext(ctx).create({
            name: discovered.name, description: discovered.description || `Imported routine from ${discovered.origin} markdown file.`, steps: discovered.steps,
            tags: frontmatterList(discovered, 'tags'), triggers: frontmatterList(discovered, 'triggers'),
            requirements: buildAgentSkillRequirements({
              env: frontmatterAnyList(discovered, ['requiresEnv', 'requires-env', 'requires_env']),
              commands: frontmatterAnyList(discovered, ['requiresCommands', 'requires-commands', 'requires_commands', 'commands']),
            }),
            enabled: values.enabled === 'yes', source: 'imported', provenance: `discovered:${discovered.origin}:${discovered.path}`,
          }));
          return formatRoutineReceipt('Imported routine', routine, [`  enabled ${routine.enabled ? 'yes' : 'no'}`]);
        },
      }),
      change({
        id: 'promote', label: 'Run a routine on a schedule', word: 'promote',
        stepTitles: ['Which routine?', 'When?', 'Where does the answer go?', 'Anything else?'],
        inputs: [
          { ...ROUTINE, step: 1 },
          choiceInput({ id: 'how', label: 'When', help: 'How you say when it runs', choices: [{ value: 'cron', label: 'On a calendar pattern', help: 'Five cron fields, such as 0 9 * * 1-5' }, { value: 'every', label: 'Every so often', help: 'An interval such as 15m, 2h or 1d' }, { value: 'at', label: 'Once, at a date and time', help: 'Such as 2026-12-01T09:00' }], typed: { flag: '--how' }, step: 2 }),
          textInput({ id: 'when', label: 'Timing', help: 'The pattern, interval or date and time', why: 'a cron pattern, an interval or a date', typed: { flag: '--when' }, step: 2 }),
          textInput({ id: 'tz', label: 'Time zone', help: 'For a calendar pattern', why: 'a time zone such as Europe/Vienna', typed: { flag: '--timezone' }, optional: OPTIONAL('the host\'s'), step: 2 }),
          { ...textInput({ id: 'channel', label: 'To a channel', help: 'A channel such as slack or telegram:123; one per --delivery-channel', why: 'a channel as configuration writes it', typed: { flag: '--delivery-channel' }, optional: OPTIONAL('none'), step: 3 }), typed: { flag: '--delivery-channel', repeats: true } },
          { ...textInput({ id: 'route', label: 'To a route', help: 'A delivery route id', why: 'a route id', typed: { flag: '--delivery-route' }, optional: OPTIONAL('none'), step: 3 }), typed: { flag: '--delivery-route', repeats: true } },
          { ...textInput({ id: 'webhook', label: 'To a web address', help: 'A webhook address', why: 'a web address', typed: { flag: '--delivery-webhook' }, optional: OPTIONAL('none'), step: 3 }), typed: { flag: '--delivery-webhook', repeats: true } },
          { ...textInput({ id: 'link', label: 'To a linked surface', help: 'A linked surface such as web', why: 'a linked surface', typed: { flag: '--delivery-link' }, optional: OPTIONAL('none'), step: 3 }), typed: { flag: '--delivery-link', repeats: true } },
          textInput({ id: 'name', label: 'Schedule name', help: 'What the schedule is called', why: 'a name you choose', typed: { flag: '--name' }, optional: OPTIONAL('the routine\'s name'), step: 4 }),
          textInput({ id: 'provider', label: 'Provider', help: 'The provider a run uses', why: 'a provider id', typed: { flag: '--provider' }, optional: OPTIONAL('the host\'s usual'), step: 4 }),
          textInput({ id: 'model', label: 'Model', help: 'The model a run uses', why: 'a model id', typed: { flag: '--model' }, optional: OPTIONAL('the host\'s usual'), step: 4 }),
          choiceInput({ id: 'paused', label: 'Start paused', help: 'Kept, but runs only once resumed', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], typed: { flag: '--disabled', switchOn: 'yes' }, optional: { default: 'no', means: 'no' }, step: 4 }),
        ],
        sentence: 'Routine {routine} runs on the connected host ({how}: {when}), whether or not this Agent is open, until you change it.', example: { routine: 'morning-brief', how: 'cron', when: '0 9 * * 1-5' },
        touches: 'another-machine', operator: { terminalOnly: 'The schedule is made with this Agent\'s link to its host.' },
        async run(values, ctx) {
          const parsed = promotionOf(values);
          if (parsed.errors.length > 0) throw commandRefusal(['No schedule was made:', ...parsed.errors.map((error) => `  ${error}`)].join('\n'));
          const routine = registryFromContext(ctx).get(values.routine!);
          if (!routine) throw commandRefusal(`No routine ${values.routine}.`, '/routines list shows them.');
          await runRoutineSchedulePromotion(ctx, routine, parsed);
        },
      }),
      readAction<CommandContext>({
        id: 'receipts', label: 'See routines put on a schedule', word: 'receipts',
        sentence: 'Lists every time a routine was put on a schedule on the connected host, and how it went.', operator: { terminalOnly: 'Schedule receipts are kept in this Agent\'s home.' },
        async run(_values, ctx) { return formatRoutineScheduleReceipts(receiptStoreFromContext(ctx).snapshot()); },
      }),
      readAction<CommandContext>({
        id: 'receipt', label: 'See one schedule receipt', word: 'receipt',
        inputs: [listInput({ id: 'receipt', label: 'Receipt', help: 'Times a routine was put on a schedule', list: RECEIPTS })],
        sentence: 'Shows schedule receipt {receipt}: what was asked of the host and what it answered.', example: { receipt: 'rcpt-1a2b' }, operator: { terminalOnly: 'Schedule receipts are kept in this Agent\'s home.' },
        async run(values, ctx) {
          const receipt = receiptStoreFromContext(ctx).get(values.receipt!);
          if (!receipt) throw commandRefusal(`No schedule receipt ${values.receipt}.`, '/routines receipts lists them.');
          return formatRoutineScheduleReceipt(receipt);
        },
      }),
      readAction<CommandContext>({
        id: 'reconcile', label: 'Check scheduled routines against the host', word: 'reconcile',
        sentence: 'Compares the routines this Agent put on a schedule with the schedules the connected host has now.', operator: { terminalOnly: 'It reads the host through this Agent\'s link.' },
        async run(_values, ctx) {
          const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, requireShellPaths(ctx).homeDirectory);
          return formatRoutineScheduleCorrelation(await reconcileRoutineScheduleReceipts(connection, receiptStoreFromContext(ctx).snapshot()));
        },
      }),
    ],
  }));
}
