/**
 * The blanks of "Watch for something" (the `/triggers watch` action's values,
 * by input id) read into the definition `watchers.triggers.create` keeps:
 * what to watch, how often, and what happens when it fires. One reading for
 * both terminal apps and for the daemon's `watchers.triggers.preview`, which
 * the web UI's sheet calls before it creates the trigger.
 */
import { normalizeEverySchedule } from '../automation/schedules.js';

/** "Watch for something" values by input id (a command's words one per line). */
export type WatchValues = Readonly<Record<string, string | undefined>>;

/** A value that cannot be watched; the message is the sentence to show, ending in what was not made. */
export class WatchValuesError extends Error {
  override readonly name = 'WatchValuesError';
  constructor(message: string, readonly next?: string) { super(message); }
}

/** A trigger id from its name: lower case, dashes, at most 40 characters. */
export function triggerSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'trigger';
}

/** A command the owner let triggers run, as `watchers.triggers.grant.list` names it. */
export interface WatchGrant { readonly id: string; readonly digest: string; readonly command?: string | undefined }

/**
 * The definition the values describe. `grant` is the command the owner let
 * triggers run that `values.grant` names (looked up by the caller), or
 * undefined when there is none by that name.
 */
export function watchDefinitionFromValues(values: WatchValues, grant: WatchGrant | undefined): Record<string, unknown> {
  const name = values.name?.trim();
  if (!name) throw new WatchValuesError('Give it a name. Nothing was made.');
  if (values.kind === 'written') {
    let written: unknown;
    try { written = JSON.parse(values.definition ?? ''); } catch (error) { throw new WatchValuesError(`The definition is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was made.`); }
    if (!written || typeof written !== 'object' || Array.isArray(written)) throw new WatchValuesError('The definition is a JSON object: { spec, action? } (the id and label come from its name). Nothing was made.');
    return { ...(written as Record<string, unknown>), id: triggerSlug(name), label: name };
  }
  const words = (values.command ?? '').split('\n').map((word) => word.trim()).filter(Boolean);
  const command = words[0];
  const args = words.slice(1);
  const interval = (): number => {
    try { return normalizeEverySchedule(values.every || '5m').intervalMs; } catch { throw new WatchValuesError(`"${values.every ?? ''}" is not an interval such as 5m or 1h. Nothing was made.`); }
  };
  let spec: Record<string, unknown>;
  switch (values.kind || 'finishes') {
    case 'finishes':
      if (!command) throw new WatchValuesError('Give the command to start. Nothing was made.');
      spec = { kind: 'on-exit', command, ...(args.length > 0 ? { args } : {}) };
      break;
    case 'prints':
      if (!command) throw new WatchValuesError('Give the command to keep running. Nothing was made.');
      try { new RegExp(values.match ?? ''); } catch { throw new WatchValuesError(`"${values.match ?? ''}" is not a pattern a line can match. Nothing was made.`); }
      spec = { kind: 'stream', command, ...(args.length > 0 ? { args } : {}), match: { kind: 'regex', pattern: values.match } };
      break;
    case 'page':
      if (!/^https?:\/\//i.test(values.url ?? '')) throw new WatchValuesError('A web address starts with https:// (or http://). Nothing was made.');
      spec = { kind: 'condition', probe: { kind: 'http', url: values.url, capture: 'body' }, extract: { kind: 'raw' }, rule: { kind: 'change' }, intervalMs: interval() };
      break;
    case 'file':
      if (!values.path) throw new WatchValuesError('Give the file to watch. Nothing was made.');
      spec = { kind: 'condition', probe: { kind: 'file', path: values.path, capture: 'stat' }, extract: { kind: 'raw' }, rule: { kind: 'change' }, intervalMs: interval() };
      break;
    default:
      throw new WatchValuesError(`"${values.kind ?? ''}" is not something a trigger watches. Nothing was made.`);
  }
  let action: Record<string, unknown>;
  if (values.then === 'run') {
    if (!grant) throw new WatchValuesError(`No approved command ${values.grant ?? ''}; nothing was made.`, 'Let triggers run it first: /triggers allow-command.');
    action = { kind: 'action-grant', grantId: grant.id, digest: grant.digest };
  } else {
    action = { kind: 'agent-turn', ...(values.say ? { prompt: values.say } : {}), ...(values.deliver ? { deliverTo: values.deliver } : {}) };
  }
  return { id: triggerSlug(name), label: name, spec, action };
}

/** What a definition built from the values watches and does, in one sentence for the sheet. */
export function describeWatchValues(values: WatchValues, grant: WatchGrant | undefined): string {
  const command = (values.command ?? '').split('\n').map((word) => word.trim()).filter(Boolean).join(' ');
  const every = values.every || '5m';
  const what = values.kind === 'written' ? 'what the written definition names'
    : values.kind === 'prints' ? `each line of "${command}" that matches ${values.match ?? ''}`
    : values.kind === 'page' ? `${values.url ?? ''} for a change, every ${every}`
    : values.kind === 'file' ? `${values.path ?? ''} for a change, every ${every}`
    : `"${command}" until it finishes`;
  const then = values.then === 'run'
    ? `then runs ${grant?.command ? `"${grant.command}"` : values.grant ?? ''}`
    : `then asks the agent to look at it; the answer goes to ${values.deliver || 'your owner inbox'}`;
  return `Watches ${what}; ${then}. Its id will be ${triggerSlug(values.name ?? '')}.`;
}
