import { record, strictObject, string, number } from 'zod/v4';

export interface DecisionRouterTarget {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}
export interface DecisionRouterCategory {
  readonly label: string;
  readonly description: string;
  readonly target: DecisionRouterTarget | null;
}
export interface DecisionRouterSettings {
  readonly categories: Readonly<Record<string, DecisionRouterCategory>>;
  readonly initialContextChars: number;
  readonly expandedContextChars: number;
}

const BUILTIN_CATEGORIES = {
  'lookup-navigation': ['Lookup / navigation', 'Find a definition, locate a file or setting, or answer a narrow question about existing work.'],
  'coding-implementation': ['Coding / implementation', 'Implement, modify or refactor code and configuration.'],
  'analysis-decisions': ['Analysis / decisions', 'Reason through a problem, compare options, plan an approach or make a decision.'],
  'documentation-writing': ['Documentation / writing', 'Write or edit documentation, explanations and other prose.'],
  'summarization-extraction': ['Summarization / extraction', 'Summarize supplied material or extract its facts into a requested form.'],
  general: ['General', 'Catch-all for conversation and requests that do not fit a more specific category.'],
  'debugging-diagnosis': ['Debugging / diagnosis', 'Identify the cause of an error, failing test, crash or unexpected behavior.'],
  'review-verification': ['Review / verification', 'Review a change or verify claims, correctness, behavior or test evidence.'],
  research: ['Research', 'Find and synthesize information from external sources.'],
  'data-analysis': ['Data analysis', 'Analyze datasets, calculate metrics, or interpret quantitative results.'],
} as const;

export const DEFAULT_DECISION_ROUTER_SETTINGS: DecisionRouterSettings = Object.freeze({
  categories: Object.freeze(Object.fromEntries(Object.entries(BUILTIN_CATEGORIES).map(([id, [label, description]]) =>
    [id, Object.freeze({ label, description, target: null })]))),
  initialContextChars: 3000,
  expandedContextChars: 10_000,
});

const targetSchema = strictObject({ provider: string().min(1).max(100), model: string().min(1).max(256), effort: string().min(1).max(64).optional() });
const categorySchema = strictObject({ label: string().min(1).max(100).optional(), description: string().min(1).max(1000).optional(), target: targetSchema.nullable().optional() });
const settingsSchema = strictObject({
  categories: record(string().regex(/^[a-z][a-z0-9-]{0,63}$/), categorySchema).optional(),
  initialContextChars: number().int().min(512).max(32_000).optional(),
  expandedContextChars: number().int().min(512).max(65_536).optional(),
});

/** Snapshot data properties only, before schema parsing can read borrowed values. */
function snapshot(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Invalid Decision Router settings');
  seen.add(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new Error('Invalid Decision Router settings');
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) throw new Error('Invalid Decision Router settings');
    entries.push([key, snapshot(property.value, seen)]);
  }
  // Settings contain records, not arrays. Reject them rather than interpreting
  // sparse arrays or extra properties as a category map.
  if (Array.isArray(value)) throw new Error('Invalid Decision Router settings');
  return Object.fromEntries(entries);
}

/** All ten built-ins remain present; supplied categories override them or add custom ones. */
export function captureDecisionRouterSettings(value: unknown): DecisionRouterSettings {
  const parsed = settingsSchema.parse(snapshot(value ?? {}));
  const categories: Record<string, DecisionRouterCategory> = { ...DEFAULT_DECISION_ROUTER_SETTINGS.categories };
  for (const [id, entry] of Object.entries(parsed.categories ?? {})) {
    const previous = Object.hasOwn(categories, id) ? categories[id] : undefined;
    if (!previous && !entry.description) throw new Error('Custom routing categories require a description');
    if (entry.target?.provider === 'decision-router') throw new Error('Decision Router cannot route to itself');
    categories[id] = Object.freeze({ label: entry.label ?? previous?.label ?? id,
      description: entry.description ?? previous?.description ?? id,
      target: entry.target ? Object.freeze({ provider: entry.target.provider, model: entry.target.model,
        ...(entry.target.effort === undefined ? {} : { effort: entry.target.effort }) }) : null });
  }
  if (Object.keys(categories).length > 63) throw new Error('Decision Router supports at most 63 categories');
  const initialContextChars = parsed.initialContextChars ?? DEFAULT_DECISION_ROUTER_SETTINGS.initialContextChars;
  const expandedContextChars = parsed.expandedContextChars ?? DEFAULT_DECISION_ROUTER_SETTINGS.expandedContextChars;
  if (expandedContextChars < initialContextChars) throw new Error('Expanded routing context must cover the initial routing context');
  return Object.freeze({ categories: Object.freeze(categories), initialContextChars, expandedContextChars });
}

export function validDecisionRouterSettings(value: unknown): boolean {
  try { captureDecisionRouterSettings(value); return value !== undefined; }
  catch { return false; }
}
