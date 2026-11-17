import { commandJsonOrText as jsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { createShellPathService } from '@/runtime/index.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { discoverRoutines, type DiscoveredRoutineRecord } from '../agent/routine-discovery.ts';
import { AgentRoutineRegistry, evaluateAgentRoutineReadiness, type AgentRoutineRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { buildAgentSkillRequirements, formatAgentSkillRequirement } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import {
  buildRoutineSchedulePreview,
  promoteRoutineToConnectedSchedule,
  resolveAgentConnectedHostConnection,
  routinePromotionBlockers,
  routineScheduleName,
  type RoutineSchedulePromotionPreview,
} from '../agent/routine-schedule-promotion.ts';
import { parseRoutineSchedulePromotionArgs } from '../agent/routine-schedule-args.ts';
import { appendTemporalLabel } from './temporal-label.ts';
import {
  formatRoutineScheduleCorrelation,
  formatRoutineScheduleFailure,
  formatRoutineSchedulePreview,
  formatRoutineScheduleReceipt,
  formatRoutineScheduleReceipts,
  formatRoutineScheduleSuccess,
} from '../agent/routine-schedule-format.ts';
import { fetchLiveSchedules, formatReceiptsOnOtherHosts, reconcileRoutineScheduleReceipts, RoutineScheduleReceiptStore } from '../agent/routine-schedule-receipts.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

interface RoutinesCommandSuccess<TData> {
  readonly ok: true;
  readonly kind: string;
  readonly data: TData;
}

interface RoutinesCommandFailure {
  readonly ok: false;
  readonly kind: string;
  readonly error: string;
}

interface ParsedRoutineOptions {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly yes: boolean;
}

const ROUTINE_CREATE_USAGE =
  'Usage: goodvibes-agent routines create --name <name> --description <summary> --steps <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]';
const ROUTINE_VALUE_OPTIONS = [
  'name',
  'description',
  'steps',
  'tags',
  'triggers',
  'requires-env',
  'requires-command',
  'requires-commands',
] as const;

function commandFailure(runtime: CliCommandRuntime, kind: string, error: string, exitCode: number): CliCommandOutput {
  const failure: RoutinesCommandFailure = { ok: false, kind, error };
  return {
    output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(failure, null, 2) : error,
    exitCode,
  };
}

function routineRegistry(runtime: CliCommandRuntime): AgentRoutineRegistry {
  return AgentRoutineRegistry.fromShellPaths(
    createShellPathService({
      workingDirectory: runtime.workingDirectory,
      homeDirectory: runtime.homeDirectory,
    }),
  );
}

function shellPaths(runtime: CliCommandRuntime): ReturnType<typeof createShellPathService> {
  return createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
}

function routineReceiptStore(runtime: CliCommandRuntime): RoutineScheduleReceiptStore {
  return RoutineScheduleReceiptStore.fromShellPaths(
    createShellPathService({
      workingDirectory: runtime.workingDirectory,
      homeDirectory: runtime.homeDirectory,
    }),
  );
}

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRoutineOptions(args: readonly string[]): ParsedRoutineOptions {
  const valued: ReadonlySet<string> = new Set(ROUTINE_VALUE_OPTIONS);
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const raw = token.slice(2);
      const equalIndex = raw.indexOf('=');
      if (equalIndex >= 0) {
        flags.set(raw.slice(0, equalIndex), raw.slice(equalIndex + 1));
        continue;
      }
      const key = raw;
      const next = args[index + 1];
      if (next !== undefined && (valued.has(key) || !next.startsWith('--'))) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, 'true');
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags, yes };
}

function optionValue(options: ParsedRoutineOptions, key: string): string | undefined {
  const value = options.flags.get(key)?.trim();
  return value ? value : undefined;
}

function hasFlag(options: ParsedRoutineOptions, key: string): boolean {
  return options.flags.get(key) === 'true';
}

function requiredOption(options: ParsedRoutineOptions, key: string): string {
  const value = optionValue(options, key);
  if (!value) throw new Error(`${ROUTINE_CREATE_USAGE}\nMissing --${key}.`);
  return value;
}

function parseImportFlags(args: readonly string[]): {
  readonly name: string;
  readonly enabled: boolean;
  readonly yes: boolean;
} {
  const positionals: string[] = [];
  let enabled = false;
  let yes = false;
  for (const arg of args) {
    if (arg === '--enabled') {
      enabled = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    positionals.push(arg);
  }
  return { name: positionals.join(' ').trim(), enabled, yes };
}

function summarizeRoutine(routine: AgentRoutineRecord): string {
  const enabled = routine.enabled ? 'enabled' : 'disabled';
  const tags = routine.tags.length > 0 ? `  tags ${routine.tags.join(', ')}` : '';
  const readiness = evaluateAgentRoutineReadiness(routine);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(',')}`;
  return `  ${routine.id}  ${enabled}  ${formatAgentRecordReviewState(routine.reviewState)}  ${ready}  starts ${routine.startCount}  ${routine.name} - ${routine.description}${tags}`;
}

function summarizeDiscoveredRoutine(routine: DiscoveredRoutineRecord): string {
  const description = routine.description ? ` - ${routine.description}` : '';
  return [`  ${routine.name}  ${routine.origin}${description}`, `    path ${routine.path}`].join('\n');
}

function renderDiscoveredRoutineList(routines: readonly DiscoveredRoutineRecord[]): string {
  if (routines.length === 0) {
    return [
      'Discovered Agent routine files',
      '  No routine markdown files found in Agent routine folders.',
      '  Search roots: .goodvibes/routines, .goodvibes/agent/routines, ~/.goodvibes/routines, ~/.goodvibes/agent/routines',
    ].join('\n');
  }
  return [
    `Discovered Agent routine files (${routines.length})`,
    ...routines.map(summarizeDiscoveredRoutine),
    '',
    'Import one with: goodvibes-agent routines import-discovered <name> --yes',
  ].join('\n');
}

function discoveredRoutineLookupValues(routine: DiscoveredRoutineRecord): readonly string[] {
  const slug = routine.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const basename = routine.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [routine.name, slug, routine.path, basename].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredRoutine(routines: readonly DiscoveredRoutineRecord[], idOrName: string): DiscoveredRoutineRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return routines.find((routine) => discoveredRoutineLookupValues(routine).includes(lookup)) ?? null;
}

function discoveredRoutineFrontmatterList(routine: DiscoveredRoutineRecord, key: string): readonly string[] {
  const value = routine.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

function discoveredRoutineFrontmatterAnyList(routine: DiscoveredRoutineRecord, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const values = discoveredRoutineFrontmatterList(routine, key);
    if (values.length > 0) return values;
  }
  return [];
}

function renderRoutineList(title: string, path: string, routines: readonly AgentRoutineRecord[], emptyMessage?: string): string {
  if (routines.length === 0) {
    return [
      title,
      `  ${emptyMessage ?? 'No Agent-local routines yet.'}`,
      emptyMessage ? '' : '  Open /agent routines in the TUI, or use goodvibes-agent routines create for scripted setup.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [`${title} (${routines.length})`, `  store ${path}`, ...routines.map(summarizeRoutine)].join('\n');
}

function renderRoutine(routine: AgentRoutineRecord): string {
  const readiness = evaluateAgentRoutineReadiness(routine);
  return [
    `Routine ${routine.name}`,
    `  id ${routine.id}`,
    `  enabled ${routine.enabled ? 'yes' : 'no'}`,
    `  readiness ${readiness.ready ? 'ready' : 'needs setup'}`,
    `  requirements ${routine.requirements.map(formatAgentSkillRequirement).join(', ') || '(none)'}`,
    readiness.missing.length > 0 ? `  missing ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}` : '',
    `  review ${formatAgentRecordReviewState(routine.reviewState)}`,
    `  origin ${formatAgentRecordOrigin(routine.source, routine.provenance)}`,
    `  tags ${routine.tags.join(', ') || '(none)'}`,
    `  triggers ${routine.triggers.join(', ') || '(manual)'}`,
    `  started ${routine.startCount}${routine.lastStartedAt ? `; last ${appendTemporalLabel(routine.lastStartedAt, routine.lastStartedAt)}` : ''}`,
    `  created ${appendTemporalLabel(routine.createdAt, routine.createdAt)}`,
    `  updated ${appendTemporalLabel(routine.updatedAt, routine.updatedAt)}`,
    routine.staleReason ? `  stale reason ${routine.staleReason}` : '',
    '',
    routine.description,
    '',
    routine.steps,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

async function handleRoutinePromotion(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseRoutineSchedulePromotionArgs(args);
  const json = runtime.cli.flags.outputFormat === 'json';
  if (parsed.errors.length > 0) {
    const failure: RoutinesCommandFailure = {
      ok: false,
      kind: 'invalid_routine_schedule_promotion',
      error: parsed.errors.join(' '),
    };
    return {
      output: json
        ? JSON.stringify(failure, null, 2)
        : [
            'Usage: goodvibes-agent routines promote <id> (--cron <expr>|--every <interval>|--at <iso-time>) [--timezone <tz>] [--name <schedule-name>] [--provider <id>] [--model <model>] [--delivery-channel <channel[:route][ | label]>|--delivery-route <route[ | label]>|--delivery-webhook <url>|--delivery-link <url>] [--disabled] --yes',
            ...parsed.errors.map((error) => `  ${error}`),
          ].join('\n'),
      exitCode: 2,
    };
  }
  const registry = routineRegistry(runtime);
  const routine = registry.get(parsed.routineId ?? '');
  if (!routine) {
    const failure: RoutinesCommandFailure = {
      ok: false,
      kind: 'routine_not_found',
      error: `Unknown Agent routine ${parsed.routineId ?? ''}`,
    };
    return {
      output: json ? JSON.stringify(failure, null, 2) : failure.error,
      exitCode: 1,
    };
  }
  const preview = buildRoutineSchedulePreview(routine, parsed);
  // An imported routine starts disabled and unreviewed, and a schedule turns its steps into a
  // standing prompt, so the same gate the terminal command applies holds here.
  const blockers = routinePromotionBlockers(routine, 'cli');
  if (parsed.yes && blockers.length > 0) {
    return commandFailure(
      runtime,
      'routine_not_ready',
      [`Refusing to promote ${routine.id}: no schedule was created.`, ...blockers.map((blocker) => `  ${blocker}`)].join('\n'),
      1,
    );
  }
  if (!parsed.yes) {
    const value: RoutinesCommandSuccess<typeof preview> = {
      ok: true,
      kind: 'automation.schedules.create.preview',
      data: preview,
    };
    return {
      output: jsonOrText(runtime, value, [
        formatRoutineSchedulePreview(preview),
        ...(blockers.length === 0 ? [] : ['', `Not ready to promote ${routine.id}:`, ...blockers.map((blocker) => `  ${blocker}`)]),
      ].join('\n')),
      exitCode: 0,
    };
  }
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const receipts = routineReceiptStore(runtime);

  // A repeat of an earlier promotion would create a second schedule with the same name: when
  // that attempt created one, or failed without saying whether the host acted (dropped
  // connection, timeout, host error), the host is asked first and what it holds decides.
  const scheduleName = routineScheduleName(preview);
  const earlier = latestAttemptFor(receipts, connection.baseUrl, preview);
  const earlierAmbiguous = earlier?.status === 'failed' && (earlier.failureKind === 'connected_host_unavailable' || earlier.failureKind === 'connected_host_error');
  if (earlier && (earlier.status === 'created' || earlierAmbiguous)) {
    const live = await fetchLiveSchedules(connection);
    const existing = live.ok ? live.schedules.find((schedule) => schedule.name === scheduleName) : undefined;
    if (!live.ok || existing) {
      const origin = earlier.status === 'created' ? 'from the earlier promotion' : 'most likely from the earlier attempt';
      const error = existing
        ? `A schedule named "${scheduleName}" (id ${existing.id}) already exists on the connected host, ${origin} (receipt ${earlier.id}). Nothing was created. Use routines reconcile to review it, or promote with a different --name to create another.`
        : `An earlier promotion of this routine (receipt ${earlier.id}) ${earlier.status === 'created' ? 'created a schedule' : 'failed without a known outcome'}, and the connected host's schedules could not be read to check (${live.error ?? 'no detail'}). Nothing was created. Retry once the host is reachable.`;
      return commandFailure(runtime, existing ? 'schedule_already_exists' : 'earlier_attempt_unverified', error, 1);
    }
  }

  const result = await promoteRoutineToConnectedSchedule(connection, preview);
  let receipt: ReturnType<RoutineScheduleReceiptStore['append']> | null = null;
  let receiptError: string | null = null;
  try {
    receipt = receipts.append(connection, preview, result);
  } catch (error) {
    // The host's answer stands whether or not the local record could be written.
    receiptError = summarizeError(error);
    logger.warn('Agent routine promotion receipt could not be written', { error: receiptError });
  }
  const receiptLine = receipt ? `receipt: ${receipt.id}` : `receipt not recorded: ${receiptError}`;
  if (!result.ok) {
    return {
      output: json ? JSON.stringify({ ...result, receipt, ...(receiptError ? { receiptError } : {}) }, null, 2) : `${formatRoutineScheduleFailure(result)}\n  ${receiptLine}`,
      exitCode: 1,
    };
  }
  const value = { ...result, receipt, ...(receiptError ? { receiptError } : {}) };
  return {
    output: jsonOrText(runtime, value, `${formatRoutineScheduleSuccess(result)}\n  ${receiptLine}`),
    exitCode: 0,
  };
}

/**
 * enable, disable, review, stale and update: the same registry methods the
 * terminal `/routines` command calls, so a routine created or imported from the
 * shell can be made ready for promotion from the shell.
 */
function handleRoutineChange(
  runtime: CliCommandRuntime,
  registry: AgentRoutineRegistry,
  sub: 'enable' | 'disable' | 'review' | 'stale' | 'update',
  rest: readonly string[],
): CliCommandOutput {
  const options = parseRoutineOptions(rest);
  const id = options.positionals[0];
  const usage: Record<typeof sub, string> = {
    enable: 'Usage: goodvibes-agent routines enable <id>',
    disable: 'Usage: goodvibes-agent routines disable <id>',
    review: 'Usage: goodvibes-agent routines review <id>',
    stale: 'Usage: goodvibes-agent routines stale <id> <reason>',
    update: 'Usage: goodvibes-agent routines update <id> [--name <name>] [--description <summary>] [--steps <steps>] [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq]',
  };
  if (!id) return commandFailure(runtime, 'invalid_routine_command', usage[sub], 2);
  if (!registry.get(id)) return commandFailure(runtime, 'routine_not_found', `Unknown Agent routine ${id}. List them with: goodvibes-agent routines list`, 1);
  try {
    let routine: AgentRoutineRecord;
    let headline: string;
    if (sub === 'enable' || sub === 'disable') {
      routine = registry.setEnabled(id, sub === 'enable');
      headline = `Agent routine ${sub === 'enable' ? 'enabled' : 'disabled'}`;
    } else if (sub === 'review') {
      routine = registry.markReviewed(id);
      headline = 'Agent routine reviewed';
    } else if (sub === 'stale') {
      const reason = options.positionals.slice(1).join(' ').trim();
      if (!reason) return commandFailure(runtime, 'invalid_routine_command', usage.stale, 2);
      routine = registry.markStale(id, reason);
      headline = 'Agent routine marked stale';
    } else {
      const requiresEnv = optionValue(options, 'requires-env');
      const requiresCommand = optionValue(options, 'requires-command') ?? optionValue(options, 'requires-commands');
      routine = registry.update(id, {
        name: optionValue(options, 'name'),
        description: optionValue(options, 'description'),
        steps: optionValue(options, 'steps'),
        tags: optionValue(options, 'tags') === undefined ? undefined : splitList(optionValue(options, 'tags')),
        triggers: optionValue(options, 'triggers') === undefined ? undefined : splitList(optionValue(options, 'triggers')),
        requirements: requiresEnv === undefined && requiresCommand === undefined
          ? undefined
          : buildAgentSkillRequirements({ env: splitList(requiresEnv), commands: splitList(requiresCommand) }),
      });
      // An edit changes what a schedule would run, so the registry marks it for review again.
      headline = 'Agent routine updated (review it again before promoting)';
    }
    const value: RoutinesCommandSuccess<AgentRoutineRecord> = { ok: true, kind: `agent.routines.${sub}`, data: routine };
    return {
      output: jsonOrText(runtime, value, [
        headline,
        `  id ${routine.id}`,
        `  enabled ${routine.enabled ? 'yes' : 'no'}`,
        `  review ${formatAgentRecordReviewState(routine.reviewState)}`,
      ].join('\n')),
      exitCode: 0,
    };
  } catch (error) {
    return commandFailure(runtime, `agent.routines.${sub}.error`, error instanceof Error ? error.message : String(error), 1);
  }
}

function latestAttemptFor(
  receipts: RoutineScheduleReceiptStore,
  baseUrl: string,
  preview: RoutineSchedulePromotionPreview,
) {
  const scheduleName = routineScheduleName(preview);
  let latest: ReturnType<RoutineScheduleReceiptStore['get']> = null;
  for (const receipt of receipts.snapshot().receipts) {
    if (receipt.routineId !== preview.routineId || receipt.scheduleName !== scheduleName || receipt.connectedHostBaseUrl !== baseUrl) continue;
    if (!latest || receipt.createdAt > latest.createdAt) latest = receipt;
  }
  return latest;
}

export async function handleRoutinesCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  const registry = routineRegistry(runtime);
  const snapshot = registry.snapshot();
  const normalized = sub.toLowerCase();
  if (normalized === 'list' || normalized === 'enabled' || normalized === 'attention' || normalized === 'needs-setup') {
    const routines =
      normalized === 'enabled'
        ? snapshot.enabledRoutines
        : normalized === 'attention' || normalized === 'needs-setup'
          ? snapshot.routines.filter((routine) => !evaluateAgentRoutineReadiness(routine).ready)
          : snapshot.routines;
    const value: RoutinesCommandSuccess<{
      readonly path: string;
      readonly routines: readonly AgentRoutineRecord[];
      readonly enabledCount: number;
    }> = {
      ok: true,
      kind:
        normalized === 'enabled'
          ? 'agent.routines.enabled'
          : normalized === 'attention' || normalized === 'needs-setup'
            ? 'agent.routines.attention'
            : 'agent.routines.list',
      data: {
        path: snapshot.path,
        routines,
        enabledCount: snapshot.enabledRoutines.length,
      },
    };
    return {
      output: jsonOrText(
        runtime,
        value,
        renderRoutineList(
          normalized === 'enabled'
            ? 'Enabled Agent routines'
            : normalized === 'attention' || normalized === 'needs-setup'
              ? 'Agent routines needing setup'
              : 'Agent routines',
          snapshot.path,
          routines,
          normalized === 'attention' || normalized === 'needs-setup' ? 'No Agent-local routines need setup.' : undefined,
        ),
      ),
      exitCode: 0,
    };
  }
  if (normalized === 'discover') {
    const discovered = await discoverRoutines(shellPaths(runtime));
    const value: RoutinesCommandSuccess<{ readonly routines: readonly DiscoveredRoutineRecord[] }> = {
      ok: true,
      kind: 'agent.routines.discover',
      data: { routines: discovered },
    };
    return {
      output: jsonOrText(runtime, value, renderDiscoveredRoutineList(discovered)),
      exitCode: 0,
    };
  }
  if (normalized === 'import-discovered' || normalized === 'import-routine') {
    const parsed = parseImportFlags(rest);
    if (!parsed.name) {
      const failure: RoutinesCommandFailure = {
        ok: false,
        kind: 'invalid_routine_command',
        error: 'Usage: goodvibes-agent routines import-discovered <name> [--enabled] --yes',
      };
      return {
        output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(failure, null, 2) : failure.error,
        exitCode: 2,
      };
    }
    const discovered = findDiscoveredRoutine(await discoverRoutines(shellPaths(runtime)), parsed.name);
    if (!discovered) {
      const failure: RoutinesCommandFailure = {
        ok: false,
        kind: 'routine_discovery_not_found',
        error: `Unknown discovered Agent routine ${parsed.name}\nRun goodvibes-agent routines discover to inspect available routine files.`,
      };
      return {
        output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(failure, null, 2) : failure.error,
        exitCode: 1,
      };
    }
    if (!parsed.yes) {
      const value: RoutinesCommandSuccess<{ readonly routine: DiscoveredRoutineRecord }> = {
        ok: true,
        kind: 'agent.routines.import_discovered.preview',
        data: { routine: discovered },
      };
      return {
        output: jsonOrText(
          runtime,
          value,
          [
            'Agent routine import preview',
            `  name ${discovered.name}`,
            `  origin ${discovered.origin}`,
            `  path ${discovered.path}`,
            `  description ${discovered.description || '(none)'}`,
            `  steps characters ${discovered.steps.length}`,
            '  next rerun with --yes to import into the Agent-local routine registry',
          ].join('\n'),
        ),
        exitCode: 0,
      };
    }
    const routine = registry.create({
      name: discovered.name,
      description: discovered.description || `Imported routine from ${discovered.origin} markdown file.`,
      steps: discovered.steps,
      tags: discoveredRoutineFrontmatterList(discovered, 'tags'),
      triggers: discoveredRoutineFrontmatterList(discovered, 'triggers'),
      requirements: buildAgentSkillRequirements({
        env: discoveredRoutineFrontmatterAnyList(discovered, ['requiresEnv', 'requires-env', 'requires_env']),
        commands: discoveredRoutineFrontmatterAnyList(discovered, [
          'requiresCommands',
          'requires-commands',
          'requires_commands',
          'commands',
        ]),
      }),
      enabled: parsed.enabled,
      source: 'imported',
      provenance: `discovered:${discovered.origin}:${discovered.path}`,
    });
    const value: RoutinesCommandSuccess<AgentRoutineRecord> = {
      ok: true,
      kind: 'agent.routines.import_discovered',
      data: routine,
    };
    return {
      output: jsonOrText(
        runtime,
        value,
        [
          `Imported Agent routine ${routine.id}: ${routine.name}${routine.enabled ? ' (enabled)' : ''}`,
          `  name ${routine.name}`,
          `  enabled ${routine.enabled ? 'yes' : 'no'}`,
        ].join('\n'),
      ),
      exitCode: 0,
    };
  }
  if (normalized === 'create') {
    const options = parseRoutineOptions(rest);
    try {
      const routine = registry.create({
        name: requiredOption(options, 'name'),
        description: requiredOption(options, 'description'),
        steps: optionValue(options, 'steps') ?? options.positionals.join(' ').trim(),
        tags: splitList(optionValue(options, 'tags')),
        triggers: splitList(optionValue(options, 'triggers')),
        requirements: buildAgentSkillRequirements({
          env: splitList(optionValue(options, 'requires-env')),
          commands: splitList(optionValue(options, 'requires-command') ?? optionValue(options, 'requires-commands')),
        }),
        enabled: hasFlag(options, 'enabled'),
        source: 'user',
        provenance: 'cli',
      });
      const value: RoutinesCommandSuccess<AgentRoutineRecord> = {
        ok: true,
        kind: 'agent.routines.create',
        data: routine,
      };
      return {
        output: jsonOrText(
          runtime,
          value,
          [
            `Created Agent routine ${routine.id}: ${routine.name}${routine.enabled ? ' (enabled)' : ''}`,
            `  name ${routine.name}`,
            `  enabled ${routine.enabled ? 'yes' : 'no'}`,
          ].join('\n'),
        ),
        exitCode: 0,
      };
    } catch (error) {
      return commandFailure(
        runtime,
        error instanceof Error && error.message.startsWith('Usage:') ? 'invalid_routine_command' : 'agent.routines.create.error',
        error instanceof Error ? error.message : String(error),
        error instanceof Error && error.message.startsWith('Usage:') ? 2 : 1,
      );
    }
  }
  if (normalized === 'show') {
    const id = rest[0];
    if (!id) return { output: 'Usage: goodvibes-agent routines show <id>', exitCode: 2 };
    const routine = registry.get(id);
    if (!routine) {
      const failure: RoutinesCommandFailure = { ok: false, kind: 'routine_not_found', error: `Unknown Agent routine: ${id}` };
      return {
        output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(failure, null, 2) : failure.error,
        exitCode: 1,
      };
    }
    const value: RoutinesCommandSuccess<AgentRoutineRecord> = { ok: true, kind: 'agent.routines.show', data: routine };
    return {
      output: jsonOrText(runtime, value, renderRoutine(routine)),
      exitCode: 0,
    };
  }
  if (normalized === 'enable' || normalized === 'disable' || normalized === 'review' || normalized === 'stale' || normalized === 'update') {
    return handleRoutineChange(runtime, registry, normalized, rest);
  }
  if (normalized === 'delete' || normalized === 'remove') {
    const options = parseRoutineOptions(rest);
    const id = options.positionals[0];
    if (!id) return commandFailure(runtime, 'invalid_routine_command', 'Usage: goodvibes-agent routines delete <id> --yes', 2);
    if (!options.yes) {
      return commandFailure(runtime, 'confirmation_required', `Refusing to delete Agent routine ${id} without --yes.`, 2);
    }
    try {
      const routine = registry.deleteRoutine(id);
      const value: RoutinesCommandSuccess<AgentRoutineRecord> = { ok: true, kind: 'agent.routines.delete', data: routine };
      return {
        output: jsonOrText(runtime, value, `Deleted Agent routine ${routine.id}: ${routine.name}`),
        exitCode: 0,
      };
    } catch (error) {
      return commandFailure(runtime, 'routine_not_found', error instanceof Error ? error.message : String(error), 1);
    }
  }
  if (normalized === 'receipts' || normalized === 'history') {
    const snapshot = routineReceiptStore(runtime).snapshot();
    const value: RoutinesCommandSuccess<typeof snapshot> = {
      ok: true,
      kind: 'agent.routines.scheduleReceipts.list',
      data: snapshot,
    };
    return {
      output: jsonOrText(runtime, value, formatRoutineScheduleReceipts(snapshot)),
      exitCode: 0,
    };
  }
  if (normalized === 'reconcile' || normalized === 'sync' || normalized === 'status') {
    const store = routineReceiptStore(runtime);
    const result = await reconcileRoutineScheduleReceipts(
      resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory),
      store.snapshot(),
    );
    return {
      output: jsonOrText(runtime, result, [formatRoutineScheduleCorrelation(result), ...formatReceiptsOnOtherHosts(result)].join('\n')),
      exitCode: result.ok ? 0 : 1,
    };
  }
  if (normalized === 'receipt') {
    const id = rest[0];
    if (!id) return { output: 'Usage: goodvibes-agent routines receipt <receipt-id>', exitCode: 2 };
    const receipt = routineReceiptStore(runtime).get(id);
    if (!receipt) {
      const failure: RoutinesCommandFailure = {
        ok: false,
        kind: 'routine_schedule_receipt_not_found',
        error: `Unknown routine schedule receipt ${id}`,
      };
      return {
        output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(failure, null, 2) : failure.error,
        exitCode: 1,
      };
    }
    const value: RoutinesCommandSuccess<typeof receipt> = {
      ok: true,
      kind: 'agent.routines.scheduleReceipts.get',
      data: receipt,
    };
    return {
      output: jsonOrText(runtime, value, formatRoutineScheduleReceipt(receipt)),
      exitCode: 0,
    };
  }
  if (normalized === 'promote' || normalized === 'schedule' || normalized === 'promote-schedule') {
    return handleRoutinePromotion(runtime, rest);
  }
  return {
    output: `Usage: goodvibes-agent routines [list|enabled|attention|discover|import-discovered <name> --yes|create --name <name> --description <summary> --steps <steps>|show <id>|enable <id>|disable <id>|review <id>|stale <id> <reason>|update <id> [--name ...] [--description ...] [--steps ...]|delete <id> --yes|receipts|reconcile|receipt <id>|promote <id> (--cron <expr>|--every <interval>|--at <iso-time>) [--delivery-channel <channel>|--delivery-route <route>|--delivery-webhook <url>] --yes]`,
    exitCode: 2,
  };
}
