/**
 * schedule-delivery-targets.ts, the delivery-target half of the schedule
 * domain, owned once.
 *
 * Four commands create or edit a connected-host schedule (reminder, autonomy,
 * routine promotion, schedule edit) and one sends to a channel directly. They
 * each used to carry their own copy of the supported-surface list, the four
 * `--delivery-*` parsers, the provider/model normalizer and the arg scanner.
 * The copies had already drifted, and nothing could have caught it: a sixth
 * channel kind added to five of six lists compiles clean and simply makes one
 * command reject input the others accept.
 *
 * The surface-kind TYPE is derived from the runtime list here rather than
 * written out a second time as a union, so the two cannot disagree either.
 * Every schedule delivery-target rule lives in this file; adding a channel is
 * one line.
 */

import type { OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { parseEveryInterval } from '@goodvibes-jev/engine/platform/platform/automation';
import { getModelIdFromProviderModel, getProviderIdFromModel } from './provider-model.js';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleDeliveryInput = NonNullable<ScheduleCreateInput['delivery']>;
type ScheduleDeliveryTargetInput = ScheduleDeliveryInput['targets'] extends readonly (infer T)[] ? T : never;

/** The host's schedule route and the two methods every Agent schedule command creates and reads through. */
export const ROUTINE_SCHEDULE_ROUTE = '/api/automation/schedules';
export const ROUTINE_SCHEDULE_METHOD = 'automation.schedules.create';
export const ROUTINE_SCHEDULE_LIST_METHOD = 'automation.schedules.list';

export type RoutineScheduleKind = 'cron' | 'every' | 'at';

/** One schedule selector as the commands take it: `--cron`, `--every` or `--at` with its value. */
export interface RoutineScheduleSpec {
  readonly kind: RoutineScheduleKind;
  readonly value: string;
}

/** Every channel surface a schedule may deliver to. The one list. */
export const DELIVERY_SURFACE_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
] as const;

export type RoutineScheduleDeliverySurfaceKind = (typeof DELIVERY_SURFACE_KINDS)[number];

export type RoutineScheduleDeliveryKind = 'webhook' | 'surface' | 'integration' | 'link';

export interface RoutineScheduleDeliveryTargetSpec {
  readonly kind: RoutineScheduleDeliveryKind;
  readonly surfaceKind?: RoutineScheduleDeliverySurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export function isRoutineScheduleDeliverySurfaceKind(value: string): value is RoutineScheduleDeliverySurfaceKind {
  return (DELIVERY_SURFACE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Argument scanning
// ---------------------------------------------------------------------------

/**
 * The value for the option at `index`, whether it arrived as `--flag=value` or
 * as a following argument. Returns the index the caller's loop should resume
 * from, so a consumed following argument is not re-parsed as an option.
 */
export function readOptionValue(args: readonly string[], index: number, inlineValue: string | undefined): {
  readonly value: string | undefined;
  readonly nextIndex: number;
} {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = args[index + 1];
  if (next === undefined || looksLikeOptionName(next)) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

/**
 * Whether an argument is the next option rather than a value: `--` and a name,
 * with nothing after it but an optional `=value`. Free text that merely starts
 * with dashes ("--- no failed runs", "-- no errors") is a value, so a typed
 * field that a tool turns into an argument list is not refused as a missing one.
 */
function looksLikeOptionName(arg: string): boolean {
  return /^--[a-z][a-z0-9-]*(=.*)?$/i.test(arg);
}

// ---------------------------------------------------------------------------
// Delivery-target parsing
// ---------------------------------------------------------------------------

/**
 * Sets a label off from a route id: `matrix:!ops:example.org | Ops room`.
 * Route ids may themselves contain colons (a Matrix room `!room:server`, a
 * Teams conversation `19:...@thread.tacv2`), so only the first colon ends the
 * channel kind and the label follows the last ` | `.
 */
export const DELIVERY_LABEL_SEPARATOR = ' | ';

function splitRouteAndLabel(raw: string): { readonly routeId?: string; readonly label?: string } {
  const at = raw.lastIndexOf(DELIVERY_LABEL_SEPARATOR);
  const routeId = (at < 0 ? raw : raw.slice(0, at)).trim();
  const label = at < 0 ? '' : raw.slice(at + DELIVERY_LABEL_SEPARATOR.length).trim();
  return { ...(routeId ? { routeId } : {}), ...(label ? { label } : {}) };
}

/**
 * Each parser returns a target, or the message explaining why the input is not one.
 * A channel is `kind`, `kind:<route id>` or `kind:<route id> | <label>`; every
 * caller (schedules and an immediate channel send) parses it here.
 */
export function parseChannelDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const colon = raw.indexOf(':');
  const surfaceKind = (colon < 0 ? raw : raw.slice(0, colon)).trim();
  if (!isRoutineScheduleDeliverySurfaceKind(surfaceKind)) {
    return `Unsupported delivery channel "${surfaceKind}".`;
  }
  return { kind: 'surface', surfaceKind, ...splitRouteAndLabel(colon < 0 ? '' : raw.slice(colon + 1)) };
}

/** A route is `<route id>` or `<route id> | <label>`; the route id is taken whole, colons included. */
export function parseRouteDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const parsed = splitRouteAndLabel(raw);
  if (!parsed.routeId) return '--delivery-route requires a route id.';
  return { kind: 'surface', ...parsed };
}

export function parseWebhookDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const normalized = raw.trim();
  if (!normalized) return '--delivery-webhook requires a URL.';
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '--delivery-webhook must be an http(s) URL.';
  } catch {
    return '--delivery-webhook must be a valid URL.';
  }
  return {
    kind: 'webhook',
    address: normalized,
  };
}

/**
 * A link target: each run's result is published as a document on the host and
 * the link to it is announced on the owner's web surface. The value names the
 * link (its title and file name).
 */
export function parseLinkDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const normalized = raw.trim();
  if (!normalized) return '--delivery-link requires a name for the link.';
  return { kind: 'link', address: normalized };
}

/**
 * The mixed-kind check, or null when the targets are usable.
 *
 * `commandNoun` names the command in the message ("reminder command",
 * "autonomous schedule command"). It is a parameter rather than a fixed string
 * because the wording is the only part that legitimately differs per command.
 */
export function validateDeliveryTargets(
  targets: readonly RoutineScheduleDeliveryTargetSpec[],
  commandNoun: string,
): string | null {
  const kinds = new Set(targets.map((target) => target.kind));
  return kinds.size > 1 ? `Use one delivery target kind per ${commandNoun}.` : null;
}

export function deliveryModeFromTargets(
  targets: readonly RoutineScheduleDeliveryTargetSpec[],
): RoutineScheduleDeliveryKind | 'none' {
  const first = targets[0];
  return first ? first.kind : 'none';
}

export function toDeliveryTargetInput(target: RoutineScheduleDeliveryTargetSpec): ScheduleDeliveryTargetInput {
  return {
    kind: target.kind,
    ...(target.surfaceKind !== undefined ? { surfaceKind: target.surfaceKind } : {}),
    ...(target.address !== undefined ? { address: target.address } : {}),
    ...(target.routeId !== undefined ? { routeId: target.routeId } : {}),
    ...(target.label !== undefined ? { label: target.label } : {}),
  };
}

/**
 * The command-line flag and value that parse back into `target`: the inverse of
 * the four parsers above, so a printed confirmation command reproduces the
 * targets a preview showed.
 */
export function deliveryTargetFlag(target: {
  readonly kind?: string | undefined;
  readonly surfaceKind?: string | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}): { readonly flag: string; readonly value: string } | null {
  if (target.kind === 'webhook' && target.address) return { flag: '--delivery-webhook', value: target.address };
  if (target.kind === 'link' && target.address) return { flag: '--delivery-link', value: target.address };
  if (target.kind !== 'surface') return null;
  const label = target.label ? `${DELIVERY_LABEL_SEPARATOR}${target.label}` : '';
  if (target.surfaceKind) {
    const tail = target.routeId || label ? `:${target.routeId ?? ''}${label}` : '';
    return { flag: '--delivery-channel', value: `${target.surfaceKind}${tail}` };
  }
  if (!target.routeId) return null;
  return { flag: '--delivery-route', value: `${target.routeId}${label}` };
}

// ---------------------------------------------------------------------------
// Provider/model
// ---------------------------------------------------------------------------

/** Splits a `provider/model` value into its parts, inferring the provider when only a model is given. */
export function normalizeProviderModel(provider: string | undefined, model: string | undefined): {
  readonly provider?: string;
  readonly model?: string;
} {
  if (!model) return provider ? { provider } : {};
  // A bare model id carries no provider; only a `provider:model` value names one.
  const qualified = model.trim().indexOf(':') > 0;
  const normalizedProvider = provider ?? (qualified ? getProviderIdFromModel(model) : undefined);
  return {
    ...(normalizedProvider ? { provider: normalizedProvider } : {}),
    model: getModelIdFromProviderModel(model),
  };
}

// ---------------------------------------------------------------------------
// The schedule a lost create already made
// ---------------------------------------------------------------------------

function isScheduleRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One delivery target as a comparable key: what it reaches, not how it is labelled. */
function deliveryTargetKey(target: unknown): string {
  if (!isScheduleRecord(target)) return '';
  const part = (value: unknown): string => (typeof value === 'string' ? value : '');
  return [part(target.kind), part(target.surfaceKind), part(target.address), part(target.routeId)].join('\u0000');
}

/** The delivery mode and target keys of a policy; an absent policy is the host's default (`none`, no targets). */
function deliveryShape(delivery: unknown): string {
  const record = isScheduleRecord(delivery) ? delivery : {};
  const mode = typeof record.mode === 'string' ? record.mode : 'none';
  const targets = Array.isArray(record.targets) ? record.targets.map(deliveryTargetKey).sort() : [];
  return JSON.stringify([mode, targets]);
}

/** A stored or requested model or provider name as compared: trimmed, lower case, '' for none. */
function comparableName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Whether a stored job's model is the one a request named. The host stores a
 * provider-qualified registry key; a request may name the key or the model id
 * alone, which can itself hold a colon (`llama3:8b`), so the key matches the
 * request whole or with its provider segment taken off. No model on either
 * side matches only no model on the other.
 */
function sameModel(storedKey: string, requested: string): boolean {
  if (!storedKey || !requested) return storedKey === requested;
  return storedKey === requested || storedKey.slice(storedKey.indexOf(':') + 1) === requested;
}

/**
 * The listed job that is the schedule `payload` would create, or undefined.
 * The host takes no idempotency key on `automation.schedules.create`, so a
 * create whose answer was lost (a daemon restart, a laptop asleep mid-request)
 * would add a second standing schedule on the natural retry; every create path
 * reads the list first and matches here. Same name, same kind and time, the
 * same prompt, the same on/off state and the same delivery: matching the prompt
 * keeps two different schedules that share a name (the first 48 characters of a
 * reminder) and a time from reading as one, and matching state and delivery
 * keeps a paused schedule, or one that delivers elsewhere, from being reported
 * as the one just asked for; matching the model and provider keeps a schedule
 * re-created for another model from reading as the old one. `listed` is the
 * `automation.schedules.list` answer; any other shape matches nothing.
 */
export function findSameSchedule(listed: unknown, payload: ScheduleCreateInput): Record<string, unknown> | undefined {
  const jobs: readonly unknown[] = isScheduleRecord(listed) && Array.isArray(listed.jobs) ? listed.jobs : [];
  let intervalMs: number | undefined;
  if (payload.kind === 'every') {
    try { intervalMs = parseEveryInterval(String(payload.every)); } catch { return undefined; }
  }
  // The host creates a schedule switched on unless the request says otherwise.
  const enabled = payload.enabled ?? true;
  const delivery = deliveryShape(payload.delivery);
  // The host stores the model as a provider-qualified key and the provider only when one was asked for.
  const model = comparableName(payload.model);
  const provider = comparableName(payload.provider);
  return jobs.find((job): job is Record<string, unknown> => {
    if (!isScheduleRecord(job) || job.name !== payload.name) return false;
    const execution = job.execution;
    if (isScheduleRecord(execution) && typeof execution.prompt === 'string' && execution.prompt !== payload.prompt) return false;
    const stored = isScheduleRecord(execution) ? execution : {};
    if (!sameModel(comparableName(stored.modelId), model) || comparableName(stored.modelProvider) !== provider) return false;
    if (job.enabled !== enabled) return false;
    if (deliveryShape(job.delivery) !== delivery) return false;
    const schedule = job.schedule;
    if (!isScheduleRecord(schedule) || schedule.kind !== payload.kind) return false;
    if (payload.kind === 'cron') {
      const zone = typeof schedule.timezone === 'string' ? schedule.timezone : undefined;
      // Without a timezone the host stores its own local zone, so only an explicit zone is compared.
      return schedule.expression === payload.cron && (!payload.timezone || zone === payload.timezone);
    }
    if (payload.kind === 'every') return schedule.intervalMs === intervalMs;
    return typeof schedule.at === 'number' && schedule.at === Date.parse(String(payload.at));
  });
}
