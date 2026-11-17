/**
 * The words a tool call is shown by while it runs and once it finished. Each
 * tool's definition carries them (`activity` beside `name` and `description`),
 * the companion chat sends one call's words on `turn.tool_call`, and the web UI
 * and both terminal apps build every tool line from them with the functions
 * below, so a tool reads the same on every surface.
 */

/** The words for one kind of call, e.g. Reading / read / a file / files. */
export interface ToolActivityWords {
  /** Present participle, capitalized: "Reading". */
  readonly doing: string;
  /** Past tense, lower case: "read". */
  readonly did: string;
  /** What one call acts on, with its article: "a file", "the web". Absent: the verb stands alone ("Researching"). */
  readonly object?: string | undefined;
  /** What several calls act on, to be counted: "files". Absent: several calls count as times ("searched the web 3 times"). */
  readonly objects?: string | undefined;
}

/** What a call's `action` (or `mode`) argument does. */
export type ToolActionClass = 'read' | 'change' | 'run' | 'send' | 'delete';

/** A tool's display words, as its definition declares them. */
export interface ToolActivity extends ToolActivityWords {
  /** Words for a call whose `action` or `mode` falls in a class, where they differ from the tool's own. */
  readonly byAction?: Readonly<Partial<Record<ToolActionClass, ToolActivityWords>>> | undefined;
}

const ACTION_CLASS: Readonly<Record<string, ToolActionClass>> = {
  list: 'read', search: 'read', get: 'read', show: 'read', status: 'read', inspect: 'read', read: 'read',
  review: 'read', stale: 'read', preview_import: 'read', provider: 'read', curator: 'read', candidate: 'read',
  channel: 'read', deliveries: 'read', triage: 'read', refinement: 'read', handoffs: 'read', templates: 'read',
  budget: 'read', plan: 'read', wait: 'read', contracts: 'read', 'contract-history': 'read', 'cohort-status': 'read',
  'cohort-report': 'read',
  create: 'change', update: 'change', set: 'change', reset: 'change', edit: 'change', enable: 'change',
  disable: 'change', import: 'change', pause: 'change', resume: 'change', clear_active: 'change', setup: 'change',
  autonomous: 'change', remind: 'change', reminder: 'change', depend: 'change', handoff: 'change',
  acknowledge: 'change', withdraw: 'change',
  run: 'run', start: 'run', use: 'run', run_refinement: 'run',
  send: 'send', notify: 'send', post: 'send', reply: 'send', share: 'send', message: 'send',
  delete: 'delete', remove: 'delete', forget: 'delete', clear: 'delete', cancel: 'delete',
};

/** The class of a call's `action` argument (else its `mode`), when the word is a known one. */
export function toolActionClass(args?: Readonly<Record<string, unknown>> | undefined): ToolActionClass | undefined {
  const word = typeof args?.action === 'string' ? args.action : typeof args?.mode === 'string' ? args.mode : undefined;
  return word !== undefined && Object.hasOwn(ACTION_CLASS, word) ? ACTION_CLASS[word] : undefined;
}

/** The words for one call of a tool: the ones for its action's class when the tool declares them, else the tool's own. */
export function toolCallActivity(activity: ToolActivity | undefined, args?: Readonly<Record<string, unknown>> | undefined): ToolActivityWords | undefined {
  if (!activity) return undefined;
  const verbClass = toolActionClass(args);
  const words = verbClass ? activity.byAction?.[verbClass] : undefined;
  const chosen = words ?? activity;
  return {
    doing: chosen.doing,
    did: chosen.did,
    ...(chosen.object !== undefined ? { object: chosen.object } : {}),
    ...(chosen.objects !== undefined ? { objects: chosen.objects } : {}),
  };
}

/** The words for a tool that declares none (an MCP or plugin tool): "Using <name>". */
export function toolActivityFallback(toolName: string): ToolActivityWords {
  const short = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  return { doing: 'Using', did: 'used', object: short.trim() || 'a tool' };
}

/**
 * One phrase for `count` calls with the same words: running ("Reading 2
 * files", "Searching the web") or finished ("read 2 files", "searched the web
 * 2 times"). Running phrases start with a capital, finished ones do not.
 */
export function toolActivityPhrase(words: ToolActivityWords, count: number, state: 'running' | 'done'): string {
  const verb = state === 'running' ? words.doing : words.did;
  const counted = count > 1 && words.objects !== undefined;
  if (counted) return `${verb} ${count} ${words.objects}`;
  const one = words.object ? `${verb} ${words.object}` : verb;
  return state === 'done' && count > 1 ? `${one} ${count} times` : one;
}
