import type { ToolDefinition } from '../types/tools.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes/judgment';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { paramFill, paramFillCandidate, paramFillContext } from './batteries/param-fill.js';
import { booleanValue, booleanValueView } from './batteries/boolean-value.js';
import { decisionOrClassic, endDecisionPhaseWithoutModel, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';

const PARAM_FILL_SITE = 'tools.auto-repair.param-fill';
const BOOLEAN_VALUE_SITE = 'tools.auto-repair.boolean-value';

/** Result of a tool call repair attempt. */
export interface RepairResult {
  repaired: boolean;
  original: Record<string, unknown>;
  fixed: Record<string, unknown>;
  /** Human-readable list of what was fixed. */
  repairs: string[];
  /** Repair failures callers can surface as warning metadata. */
  warnings?: string[] | undefined;
  /**
   * Arguments the schema does not declare, which the tool will ignore, each
   * as a model-facing sentence (with a likely intended name when one is close).
   */
  unknownParameters?: string[] | undefined;
  /** Operation provenance; individual repairs describe only changes actually made. */
  provenance?: 'classic';
}

/**
 * Attempt to repair a malformed tool call by inferring missing/wrong params.
 *
 * Returns repaired arguments and a log of what was fixed.
 * If no repairs are needed (or repair is impossible), returns the original unchanged
 * with repaired=false.
 *
 * Design: the format repairs never throw; a failure there returns the
 * original arguments with a warning. Reading which boolean a non-literal
 * string means (`engine.tools.boolean-value`) and filling a missing required
 * parameter from a spare argument (`engine.tools.param-fill`) are readings,
 * and a JudgmentError from either propagates unless Hybrid exhausts its
 * configured chain. Without a decision model, this keeps format repairs and leaves unresolved values
 * for ordinary schema validation, even when the caller supplies its own port.
 * Calls that are already correct
 * pass through unchanged, and a call with no such string and no missing
 * required string parameter asks nothing.
 *
 * The original execution signal also owns this caller's repair wait. A
 * cancelled reading cannot apply a late answer, even when a borrowed port
 * ignores cancellation. Abort reasons are never exposed as repair errors.
 */
export async function repairToolCall(
  toolName: string,
  args: Record<string, unknown>,
  schema: ToolDefinition,
  signal?: AbortSignal,
  scopedPort?: JudgmentPort,
): Promise<RepairResult> {
  return withConfiguredDecisionModelPolicy(() => repairOwnedToolCall(toolName, args, schema, signal, scopedPort));
}

async function repairOwnedToolCall(
  toolName: string, args: Record<string, unknown>, schema: ToolDefinition,
  signal?: AbortSignal, scopedPort?: JudgmentPort,
): Promise<RepairResult> {
  assertRepairActive(signal);
  let fixed: Record<string, unknown>;
  const repairs: string[] = [];
  const booleanStrings: Array<{ key: string; value: string }> = [];
  const params = schema.parameters as JsonSchemaNode | undefined;
  const declared = params?.properties;
  const properties = (declared !== null && typeof declared === 'object' ? declared : {}) as Record<string, Record<string, unknown>>;
  const required = (Array.isArray(params?.required) ? params.required : []).filter((key): key is string => typeof key === 'string');

  try {
    fixed = structuredClone(args);

    // --- Rule 1: Missing `mode` on agent tool ---
    if (toolName === 'agent' && fixed['mode'] === undefined) {
      const inferred = _inferAgentMode(fixed);
      if (inferred !== null) {
        fixed['mode'] = inferred;
        repairs.push(`inferred missing mode='${inferred}' for agent tool`);
      }
    }

    // --- Rule 6: one naming convention. A key spelled in the other case
    // style of a declared key (timeoutMs / timeout_ms) is renamed to it. ---
    renameCaseVariants(fixed, params, '', repairs);
    // --- Rule 7: one vocabulary. Another tool's name for the same thing (cwd / working_dir,
    // fail_fast / stop_on_error, verbosity / output.format) is renamed to the declared one. ---
    renameAliases(fixed, params, '', repairs);
    relocateVerbosity(fixed, params, repairs);
    coerceNestedNumbers(fixed, params, '', repairs);

    // --- Rule 3 & 4 & 5: Per-property coercions ---
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in fixed)) {
        // Property missing, handle in Rule 2 below
        continue;
      }

      const value = fixed[key]!;
      const expectedType = propSchema['type'] as string | undefined;
      const enumValues = propSchema['enum'] as unknown[] | undefined;

      // Rule 3: String → number coercion. Only plain decimal text is read: Number()
      // would also turn '0x10', '1e3' and 'Infinity' into values nobody wrote as a count.
      // An integer parameter takes the same repair when the text is a whole number.
      if ((expectedType === 'number' || expectedType === 'integer') && typeof value === 'string') {
        const coerced = Number(value);
        if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()) && Number.isFinite(coerced)
          && (expectedType === 'number' || Number.isInteger(coerced))) {
          fixed[key] = coerced;
          repairs.push(`coerced ${key} from string '${value}' to ${expectedType === 'integer' ? 'integer' : 'number'} ${coerced}`);
        }
        continue;
      }

      // Rule 4: Boolean coercion. The JSON grammar spells the booleans `true`
      // and `false`, so a string holding exactly one is that boolean; any other
      // string is read by `engine.tools.boolean-value` after the format repairs.
      if (expectedType === 'boolean' && typeof value === 'string') {
        if (value === 'true' || value === 'false') {
          fixed[key] = value === 'true';
          repairs.push(`coerced ${key} from '${value}' to boolean ${value}`);
        } else {
          booleanStrings.push({ key, value });
        }
        continue;
      }

      // Rule 5: Enum normalization (case-insensitive match)
      if (enumValues && typeof value === 'string') {
        const exactMatch = enumValues.includes(value);
        if (!exactMatch) {
          const lower = value.toLowerCase();
          const spelling = (text: string): string => text.toLowerCase().replace(/[-\s]+/g, '_');
          // Case differences first, then kebab / snake / spaced spellings of the same word.
          const normalized = enumValues.find(
            (e) => typeof e === 'string' && e.toLowerCase() === lower,
          ) ?? enumValues.find((e) => typeof e === 'string' && spelling(e) === spelling(value));
          if (normalized !== undefined) {
            fixed[key] = normalized;
            repairs.push(`normalized ${key} from '${value}' to enum value '${normalized}'`);
          }
        }
      }
    }

  } catch (err) {
    // Cancellation is not a format failure and must not become a warning.
    assertRepairActive(signal);
    // Never let repair logic crash the caller
    const warning = `Auto-repair skipped for tool '${toolName}': ${summarizeError(err)}`;
    logger.warn('repairToolCall: unexpected error produced warning result', {
      toolName,
      error: summarizeError(err),
    });
    return { repaired: false, original: args, fixed: args, repairs: [], warnings: [warning] };
  }

  const warnings: string[] = [];
  // Without a decision model the format repairs above stand, and the values only a reading could settle
  // are left as sent: the call goes on to schema validation, whose error names what to supply.
  const classic = () => {
    assertRepairActive(signal);
    if (booleanStrings.length || required.some(key => !(key in fixed) && properties[key]?.['type'] === 'string')) {
      warnings.push('No decision model is in use, so only format repairs were made: boolean words and missing required parameters were left as sent. Supply exact boolean values and required parameters.');
    }
  };
  // Only the pure interpretation phase can fall back. No tool executes here.
  await decisionOrClassic(async () => {
    // --- Rule 4, read: which boolean, if any, a non-literal string means ---
    for (const { key, value } of booleanStrings) {
      const description = properties[key]?.['description'];
      const run = await booleanValue.run(
        repairPort(BOOLEAN_VALUE_SITE, signal, scopedPort),
        booleanValueView(toolName, key, typeof description === 'string' ? description : undefined, value),
        { site: BOOLEAN_VALUE_SITE, ...(signal === undefined ? {} : { signal }) },
      );
      assertRepairActive(signal);
      const reading = run.readings.boolean_value;
      const meant = reading.outcome === 'act' && reading.choice !== 'neither' ? reading.choice === 'true' : undefined;
      run.recordAction(meant === undefined ? `left ${key} as sent` : `coerced ${key} to ${meant}`);
      assertRepairActive(signal);
      if (meant !== undefined) {
        fixed[key] = meant;
        repairs.push(`coerced ${key} from '${value}' to boolean ${meant}`);
      }
    }

    // --- Rule 2: Missing required string params, filled from a spare argument Jev picks ---
    for (const requiredKey of required) {
      if (requiredKey in fixed) continue;
      const targetSchema = properties[requiredKey];
      if (targetSchema?.['type'] !== 'string') continue; // only string params
      const candidate = await _pickStringCandidate(toolName, schema, requiredKey, fixed, properties, required, signal, scopedPort);
      assertRepairActive(signal);
      if (candidate !== null) {
        fixed[requiredKey] = candidate.value;
        delete fixed[candidate.sourceKey];
        repairs.push(
          `filled missing required param '${requiredKey}' from non-required param '${candidate.sourceKey}'`,
        );
      }
    }

  }, classic, () => { assertRepairActive(signal); return true; });

  assertRepairActive(signal);
  const repaired = repairs.length > 0;
  const unknownParameters: string[] = [];
  // Arguments the host stamps in after the model's call are not the model's mistake to report.
  const hostArguments = new Set(schema.hostArguments ?? []);
  const modelArguments = hostArguments.size === 0 ? fixed : Object.fromEntries(Object.entries(fixed).filter(([key]) => !hostArguments.has(key)));
  try { collectUnknownParameters(modelArguments, params, '', toolName, unknownParameters); } catch { /* advisory only */ }

  if (repaired) {
    logger.debug('repairToolCall: repaired malformed tool call', {
      toolName,
      repairs,
    });
  }

  return { repaired, original: args, fixed, repairs,
    ...(warnings.length ? { warnings } : {}),
    ...(unknownParameters.length ? { unknownParameters } : {}),
    ...(isClassicOperation() ? { provenance: 'classic' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

function schemaObject(value: unknown): JsonSchemaNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchemaNode : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function declaredProperties(schema: JsonSchemaNode | undefined): Record<string, unknown> | undefined {
  return schemaObject(schema?.['properties']);
}

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Visits the declared object properties and array items of `value` under `schema`. */
function forEachDeclaredChild(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  path: string,
  visit: (child: Record<string, unknown>, schema: JsonSchemaNode, path: string) => void,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schemaObject(properties[key]);
    if (!childSchema) continue;
    if (Array.isArray(child)) {
      const items = schemaObject(childSchema['items']);
      if (!items) continue;
      for (const item of child) {
        const entry = plainObject(item);
        if (entry) visit(entry, items, `${path}${key}[].`);
      }
    } else {
      const entry = plainObject(child);
      if (entry) visit(entry, childSchema, `${path}${key}.`);
    }
  }
}

function renameCaseVariants(value: Record<string, unknown>, schema: JsonSchemaNode | undefined, path: string, repairs: string[]): void {
  const properties = declaredProperties(schema);
  if (!properties) return;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue;
    const target = [toSnakeCase(key), toCamelCase(key)]
      .find((candidate) => candidate !== key && Object.hasOwn(properties, candidate) && !Object.hasOwn(value, candidate));
    if (target === undefined) continue;
    value[target] = value[key];
    delete value[key];
    repairs.push(`renamed ${path}${key} to ${path}${target}`);
  }
  forEachDeclaredChild(value, properties, path, (child, childSchema, childPath) => renameCaseVariants(child, childSchema, childPath, repairs));
}

/**
 * Names that mean the same thing across tools. The first of each group is the one new schemas use;
 * a call that sends another spelling of a name the tool does not declare, where the tool declares
 * exactly one member of the group, is renamed to it. The old names keep working this way.
 */
const ALIAS_FAMILIES: readonly (readonly string[])[] = [
  ['working_dir', 'cwd', 'working_directory', 'workdir'],
  ['stop_on_error', 'fail_fast'],
  ['max_results', 'limit', 'page_size'],
  ['tool', 'tool_name'],
  ['command', 'cli_command', 'command_name'],
  ['session_id', 'session'],
];

function renameAliases(value: Record<string, unknown>, schema: JsonSchemaNode | undefined, path: string, repairs: string[]): void {
  const properties = declaredProperties(schema);
  if (!properties) return;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue;
    const family = ALIAS_FAMILIES.find((members) => members.includes(toSnakeCase(key)));
    if (!family) continue;
    // A tool may declare a member in its own case style (`toolName` for `tool_name`); the rename uses the declared spelling.
    const declaredSpellings = Object.keys(properties).filter((name) => family.includes(toSnakeCase(name)));
    const target = declaredSpellings.length === 1 ? declaredSpellings[0]! : undefined;
    if (target === undefined || Object.hasOwn(value, target)) continue;
    value[target] = value[key];
    delete value[key];
    repairs.push(`renamed ${path}${key} to ${path}${target}`);
  }
  forEachDeclaredChild(value, properties, path, (child, childSchema, childPath) => renameAliases(child, childSchema, childPath, repairs));
}

/** Rule 3 for numbers inside declared objects and array items; the top level is handled by the per-property pass. */
function coerceNestedNumbers(value: Record<string, unknown>, schema: JsonSchemaNode | undefined, path: string, repairs: string[]): void {
  const properties = declaredProperties(schema);
  if (!properties) return;
  if (path !== '') {
    for (const [key, raw] of Object.entries(value)) {
      const expectedType = schemaObject(properties[key])?.['type'];
      if ((expectedType !== 'number' && expectedType !== 'integer') || typeof raw !== 'string') continue;
      const coerced = Number(raw);
      if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw.trim()) && Number.isFinite(coerced)
        && (expectedType === 'number' || Number.isInteger(coerced))) {
        value[key] = coerced;
        repairs.push(`coerced ${path}${key} from string '${raw}' to ${expectedType === 'integer' ? 'integer' : 'number'} ${coerced}`);
      }
    }
  }
  forEachDeclaredChild(value, properties, path, (child, childSchema, childPath) => coerceNestedNumbers(child, childSchema, childPath, repairs));
}

const VERBOSITY_KEYS = ['verbosity', 'view', 'detail'];

/**
 * Tools spell their output-detail choice as a top-level `verbosity` / `view` / `detail` or as
 * `output.format`, each with its own values. A value sent in the other place is moved to the one
 * declared place whose values include it; anything that fits nowhere or fits two places is left alone.
 */
function relocateVerbosity(value: Record<string, unknown>, schema: JsonSchemaNode | undefined, repairs: string[]): void {
  const properties = declaredProperties(schema);
  if (!properties) return;
  const targets: Array<{ name: string; values: readonly unknown[]; nested: boolean }> = [];
  for (const key of VERBOSITY_KEYS) {
    const values = schemaObject(properties[key])?.['enum'];
    if (Array.isArray(values)) targets.push({ name: key, values, nested: false });
  }
  const outputProperties = declaredProperties(schemaObject(properties['output']));
  const formatValues = schemaObject(outputProperties?.['format'])?.['enum'];
  if (Array.isArray(formatValues)) targets.push({ name: 'output.format', values: formatValues, nested: true });
  if (targets.length === 0) return;

  const spelling = (text: string): string => text.toLowerCase().replace(/[-\s]+/g, '_');
  const sources: Array<{ name: string; read: () => unknown; remove: () => void }> = [];
  for (const key of VERBOSITY_KEYS) {
    if (!Object.hasOwn(properties, key) && Object.hasOwn(value, key)) sources.push({ name: key, read: () => value[key], remove: () => { delete value[key]; } });
  }
  const output = plainObject(value['output']);
  if (output && Object.hasOwn(output, 'format') && !(outputProperties && Object.hasOwn(outputProperties, 'format'))) {
    sources.push({ name: 'output.format', read: () => output['format'], remove: () => { delete output['format']; } });
  }
  for (const source of sources) {
    const sent = source.read();
    if (typeof sent !== 'string') continue;
    const fits = targets.filter((target) => target.values.some((allowed) => typeof allowed === 'string' && spelling(allowed) === spelling(sent)));
    if (fits.length !== 1) continue;
    const target = fits[0]!;
    const canonical = target.values.find((allowed) => typeof allowed === 'string' && spelling(allowed) === spelling(sent)) as string;
    const occupied = target.nested ? Boolean(plainObject(value['output']) && Object.hasOwn(plainObject(value['output'])!, 'format')) : Object.hasOwn(value, target.name);
    if (occupied) continue;
    if (target.nested) value['output'] = { ...(plainObject(value['output']) ?? {}), format: canonical };
    else value[target.name] = canonical;
    source.remove();
    if (source.name === 'output.format' && output && Object.keys(output).length === 0) delete value['output'];
    repairs.push(`moved ${source.name} to ${target.name}`);
  }
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

function collectUnknownParameters(
  value: Record<string, unknown>,
  schema: JsonSchemaNode | undefined,
  path: string,
  toolName: string,
  out: string[],
): void {
  const properties = declaredProperties(schema);
  if (!properties) return;
  const declared = Object.keys(properties);
  // Report only where the schema describes its keys: extra keys allowed, or an
  // empty property list with no explicit closing, say nothing about extras.
  const additional = schema?.['additionalProperties'];
  const closed = additional === false || (additional === undefined && declared.length > 0);
  if (closed) {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue;
      const closest = declared
        .map((name) => ({ name, distance: editDistance(key.toLowerCase(), name.toLowerCase()) }))
        .filter(({ distance, name }) => distance <= Math.max(1, Math.floor(Math.min(key.length, name.length) / 3)))
        .sort((left, right) => left.distance - right.distance)[0];
      out.push(`Unknown parameter '${path}${key}' for ${toolName}: it is not in the tool's schema and is likely ignored.`
        + (closest ? ` Did you mean '${path}${closest.name}'?`
          : declared.length > 0 ? ` Accepted here: ${declared.join(', ')}.` : ' It takes no parameters here.'));
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schemaObject(properties[key]);
    if (!childSchema) continue;
    const entry = plainObject(child);
    if (entry) { collectUnknownParameters(entry, childSchema, `${path}${key}.`, toolName, out); continue; }
    // Array items are checked only where one object shape describes them. A union (oneOf / anyOf / allOf)
    // or a reference says an item may legitimately hold keys this schema does not list.
    const items = schemaObject(childSchema['items']);
    if (!Array.isArray(child) || !items || items['oneOf'] !== undefined || items['anyOf'] !== undefined
      || items['allOf'] !== undefined || items['$ref'] !== undefined) continue;
    child.forEach((item, index) => {
      const itemEntry = plainObject(item);
      if (itemEntry) collectUnknownParameters(itemEntry, items, `${path}${key}[${index}].`, toolName, out);
    });
  }
}

function assertRepairActive(signal?: AbortSignal): void {
  // A caller's arbitrary abort reason can contain private context. Keep the
  // judgment protocol's typed cancellation without retaining that reason.
  if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
}

/**
 * Interrupt the ask, before the battery can attach readings or apply an
 * answer. The existing wait helper drains late rejections and removes this
 * caller's listener; it never cancels another caller's reading. An operation
 * that moved to no decision model ends the repair's reading phase, so the
 * no-model repair path finishes the call (even with a caller-supplied port).
 */
function repairPort(site: string, signal?: AbortSignal, scopedPort?: JudgmentPort): JudgmentPort {
  const current = () => { assertRepairActive(signal); endDecisionPhaseWithoutModel('tool argument repair'); };
  current();
  const port = scopedPort ?? judgmentPort(site);
  const recorder = port.recorder;
  return {
    get model() { return port.model; },
    ...(recorder === undefined ? {} : { recorder: {
      recordReadings(id, readings) { current(); recorder.recordReadings(id, readings); current(); },
      recordAction(id, action) { current(); recorder.recordAction(id, action); current(); },
    } satisfies JudgmentPort['recorder'] }),
    ...(port.health === undefined ? {} : { health: () => port.health!() }),
    async ask(request) {
      try {
        current();
        const result = await executePolicyCheck(() => { current(); return port.ask(request); }, signal);
        current();
        return result;
      } catch (error) {
        assertRepairActive(signal);
        throw error;
      }
    },
  };
}

/**
 * Rule 1: the agent tool's `mode`, when the arguments settle it. `task` and
 * `template` are fields of spawn mode only (agent/schema.ts), so a call that
 * carries either is a spawn. Nothing else settles it: `agentId` belongs to
 * seven modes (status, cancel, get, budget, plan, wait, message) and an empty
 * call names none, so those calls are left without a mode and fail on it.
 */
function _inferAgentMode(args: Record<string, unknown>): string | null {
  const hasTask = typeof args['task'] === 'string' && args['task'].length > 0;
  const hasTemplate = typeof args['template'] === 'string';
  return hasTask || hasTemplate ? 'spawn' : null;
}

/**
 * Rule 2: which spare argument, if any, holds the value meant for the missing
 * required string parameter `targetKey`. Code offers the spare arguments that
 * could type-check as it (present, non-empty strings the schema does not
 * require and types as a string or does not declare); the
 * `engine.tools.param-fill` selection picks one or none. Only a pick that
 * acts fills the parameter; anything else leaves it missing, so the call
 * fails on it as it would have without repair.
 */
async function _pickStringCandidate(
  toolName: string,
  schema: ToolDefinition,
  targetKey: string,
  args: Record<string, unknown>,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
  signal?: AbortSignal,
  scopedPort?: JudgmentPort,
): Promise<{ sourceKey: string; value: string } | null> {
  const spare = Object.entries(args).filter(([key, value]) => {
    if (required.includes(key)) return false;
    if (typeof value !== 'string' || value.length === 0) return false;
    const propType = properties[key]?.['type'];
    return propType === 'string' || propType === undefined;
  }) as [string, string][];
  if (spare.length === 0) return null;

  const describe = (key: string): string | undefined => {
    const description = properties[key]?.['description'];
    return typeof description === 'string' ? description : undefined;
  };
  const selection = await paramFill.select(
    repairPort(PARAM_FILL_SITE, signal, scopedPort),
    paramFillContext(toolName, schema.description, targetKey, describe(targetKey)),
    spare.map(([key, value]) => paramFillCandidate(key, value, describe(key))),
    { site: PARAM_FILL_SITE, ...(signal === undefined ? {} : { signal }) },
  );
  assertRepairActive(signal);
  const filled = selection.chosen !== undefined && selection.outcome === 'act';
  selection.recordAction(filled ? `filled ${targetKey} from ${selection.chosen}` : `left ${targetKey} missing`);
  assertRepairActive(signal);
  if (!filled) return null;
  const picked = spare.find(([key]) => key === selection.chosen);
  return picked ? { sourceKey: picked[0], value: picked[1] } : null;
}
