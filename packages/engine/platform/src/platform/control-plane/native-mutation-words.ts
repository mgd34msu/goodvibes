/**
 * native-mutation-words.ts, the question a natively admitted daemon method
 * puts to the owner, worded from the method and its inputs ("Add a schedule
 * "Morning brief", every weekday at 09:00?"), never the generic "Modify local
 * file or project state via write" of the `write` call the admission is judged
 * as (native-mutation.ts). Registered as the presenter of the `write` and
 * `send_message` asks; any other call of those tools is not one it words.
 * `methodAskWords` is the same wording for every daemon method a model can
 * reach (a program gate's nested method call, a method id run through
 * `capability_run`).
 */
import { NATIVELY_ADMITTED_METHOD_IDS } from './native-admission-methods.js';
import { OUTSIDE_AGENT_ISSUE_METHOD_ID, outsideAgentQuestion } from './method-catalog-programs.js';
import { formatScheduleTiming } from '../automation/schedule-words.js';
import { METHOD_QUESTIONS } from './method-questions.js';
import type { AutomationScheduleDefinition } from '../automation/schedules.js';
import type { ToolAskWords } from '../permissions/tool-ask-words.js';

type Fields = Readonly<Record<string, unknown>>;

function record(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim().replace(/\s+/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

const clip = (words: string, max = 80): string => words.length <= max ? words : `${words.slice(0, max - 1)}…`;

/** A held method call's body (kept as JSON under `request`, `{ body, query }`), or the request itself. */
function heldBody(request: Fields): Fields {
  if (typeof request['request'] !== 'string') return request;
  try { return record(record(JSON.parse(request['request']))['body']); } catch { return {}; }
}

/** A field's name as a person reads it: `profileId` is "Profile id", `surface_kind` "Surface kind". */
function fieldWords(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').toLowerCase();
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/** A kept schedule (its clock fields as ISO text, native-automation.ts) in words; undefined when it cannot be read. */
function timingOf(value: unknown, zone: string): string | undefined {
  const schedule = record(value);
  const kind = schedule['kind'];
  try {
    if (kind === 'every' && typeof schedule['intervalMs'] === 'number') return formatScheduleTiming({ kind, intervalMs: schedule['intervalMs'] } as AutomationScheduleDefinition, zone);
    if (kind === 'cron' && typeof schedule['expression'] === 'string') return formatScheduleTiming(schedule as unknown as AutomationScheduleDefinition, zone);
    if (kind === 'at') {
      const at = typeof schedule['at'] === 'number' ? schedule['at'] : Date.parse(String(record(schedule['at'])['iso'] ?? schedule['at']));
      if (Number.isFinite(at)) return formatScheduleTiming({ kind, at } as AutomationScheduleDefinition, zone);
    }
  } catch { /* unreadable: no timing words */ }
  return undefined;
}

/** The thing a call acts on, by its name where the target names one: `"Morning brief"`, else its id. */
function named(target: Fields, request: Fields, ...ids: string[]): string {
  const name = text(target['name']) ?? text(request['name']);
  if (name) return `"${clip(name, 60)}"`;
  for (const id of ids) {
    const value = text(request[id]) ?? text(target[id]);
    if (value) return value;
  }
  return '';
}

function question(method: string, request: Fields, target: Fields, zone: string, title: string | undefined): string {
  const thing = (noun: string, ...ids: string[]): string => { const it = named(target, request, ...ids); return it ? `the ${noun} ${it}` : `a ${noun}`; };
  switch (method) {
    // The outside agent's one question at its first start (held as its method call: its body as JSON under `request`).
    case OUTSIDE_AGENT_ISSUE_METHOD_ID: {
      let project = text(request['project']);
      if (project === undefined && typeof request['request'] === 'string') {
        try { project = text(record(record(JSON.parse(request['request']))['body'])['project']); } catch { project = undefined; }
      }
      return `${outsideAgentQuestion(project?.trim() || undefined)}?`;
    }
    case 'automation.schedules.create':
    case 'automation.jobs.create': {
      const name = text(request['name']) ?? text(request['prompt']);
      const timing = timingOf(target['schedule'], zone);
      return `Add a schedule${name ? ` "${clip(name, 60)}"` : ''}${timing ? `, ${timing}` : ''}?`;
    }
    // A credential asked for by someone other than the owner in person (the card names who asks): what the owner's yes gives that
    // caller, in plain words. A yes to someone else's request never makes the owner's own device (gate-review-6 G1).
    case 'pairing.tokens.migrate':
    case 'pairing.tokens.create':
    case 'pairing.handoff.create': {
      const body = heldBody(request);
      const name = text(body['name']) ?? text(request['name']);
      const scopes = Array.isArray(body['scopes']) ? body['scopes'].filter((scope): scope is string => typeof scope === 'string') : [];
      const holds = scopes.length > 0 ? `only ${clip(scopes.join(', '), 80)}` : 'every operator right on this daemon';
      if (body['client'] === 'agent') return 'Make the Agent\'s credential for the caller asking? (It is refused: only your own Agent or your sign-in has it made.)';
      const what = method === 'pairing.handoff.create' ? `Make a pairing code${name ? ` for "${clip(name, 60)}"` : ''}: whoever uses it gets` : `Give the caller asking${name ? ` (it names it "${clip(name, 60)}")` : ''}`;
      return `${what} its own lasting key to this daemon, holding ${holds}, until you revoke it? It will not be your device: it answers none of your questions, and its risky acts are put to you here. To make one of your programs your own device, pair it with the code your own screen shows (Devices and network, Pair something).`;
    }
    case 'automation.jobs.update': return `Change ${thing('schedule', 'jobId')}?`;
    case 'automation.jobs.enable': case 'automation.schedules.resume': return `Resume ${thing('schedule', 'jobId', 'scheduleId')}?`;
    case 'automation.jobs.disable': case 'automation.schedules.pause': return `Pause ${thing('schedule', 'jobId', 'scheduleId')}?`;
    case 'automation.jobs.delete': case 'automation.schedules.delete': return `Remove ${thing('schedule', 'jobId', 'scheduleId')}?`;
    case 'channels.routing.assign': {
      const where = [text(request['surfaceKind']), text(request['routeId'])].filter(Boolean).join(' ');
      return `Route ${where || 'a channel'} to the profile ${text(request['profileId']) ?? 'named'}?`;
    }
    case 'channels.routing.delete': return `Remove ${thing('channel route', 'assignmentId', 'id')}?`;
    case 'channels.drafts.save': return `Save a draft${text(request['surface']) ? ` for ${text(request['surface'])}` : ''}?`;
    case 'channels.drafts.delete': return `Delete ${thing('draft', 'draftId', 'id')}?`;
    case 'calendar.events.create': {
      const title = text(request['title']);
      return `Add ${title ? `"${clip(title, 60)}"` : 'an event'} to your calendar?`;
    }
    case 'calendar.events.update': return `Change ${thing('calendar event', 'eventId')}?`;
    case 'calendar.events.delete': return `Remove ${thing('calendar event', 'eventId')} from your calendar?`;
    default: break;
  }
  if (method.startsWith('profile.')) {
    const key = text(request['key']) ?? text(request['field']) ?? text(request['path']);
    const verb = method === 'profile.set' ? 'Set' : method === 'profile.append' ? 'Add to' : method === 'profile.forget' ? 'Forget' : 'Put back the earlier value of';
    return `${verb} ${key ? `"${key}"` : 'a fact'} in your profile?`;
  }
  // Every other builtin method: its own question about the act, in plain words (method-questions.ts).
  const own = Object.hasOwn(METHOD_QUESTIONS, method) ? METHOD_QUESTIONS[method] : undefined;
  if (own !== undefined) return own;
  // A plugin's method: its catalog title, as a question.
  const words = (title ?? method).trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1).toLowerCase()}?`;
}

/**
 * The words of a native admission's ask, from its arguments as native-mutation.ts builds them (`method`, `request`,
 * `selectedTarget`); undefined for any other call of the tool. `titleOf` reads a method's catalog title.
 */
export function nativeMutationAskWords(args: Readonly<Record<string, unknown>>, titleOf: (method: string) => string | undefined, zone = 'UTC'): ToolAskWords | undefined {
  const method = typeof args['method'] === 'string' ? args['method'] : '';
  if (!NATIVELY_ADMITTED_METHOD_IDS.has(method) || !('request' in args) || !('selectedTarget' in args)) return undefined;
  return methodAskWords(method, args['request'], titleOf, zone, args['selectedTarget']);
}

/**
 * The one source of words for a question about any daemon method a model can reach, natively admitted or not: the
 * method's own question (above), else its catalog title as a question ("Create calendar event?"), and each plain input
 * on a labelled line. Used for a native admission's ask, for the nested method call a program's gate decides
 * (`agent_operator_method`), and for a method named by id through `capability_run`; never "Delegate work through ...".
 * `input` is the method's input as sent (a profile or occasions write carries its HTTP body under `body`).
 */
export function methodAskWords(method: string, input: unknown, titleOf: (method: string) => string | undefined, zone = 'UTC', selectedTarget?: unknown): ToolAskWords | undefined {
  if (!method) return undefined;
  const raw = record(input);
  const request = 'body' in raw && Object.keys(raw).every((key) => key === 'body' || key === 'query') ? { ...record(raw['query']), ...record(raw['body']) } : raw;
  const target = record(selectedTarget);
  const lines = Object.entries(request).flatMap(([name, value]) => {
    if (name === 'confirm' || name === 'expectedMutationRevision' || name === 'expectedRevision') return [];
    // Plain values only: a nested object (where a schedule's answer goes, its target) is the method's, not words.
    const said = text(value);
    return said === undefined ? [] : [`${fieldWords(name)}: ${clip(said)}`];
  });
  const asked = question(method, request, target, zone, titleOf(method));
  return { question: asked, lines, subject: asked.replace(/\?$/, ''), doing: `"${asked.replace(/\?$/, '')}"` };
}
