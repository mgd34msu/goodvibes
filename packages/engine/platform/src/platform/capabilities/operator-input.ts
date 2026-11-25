import { CapabilityRefusal, type ActionValues } from './types.js';

/**
 * What an action sends to its operator method: each field (a dot path) takes
 * the value of the input it names. `input:first` and `input:rest` take the
 * first line and the lines after it as a list (a command and its arguments),
 * `input:lines` all lines as a list, `input:pairs` NAME=VALUE lines as an
 * object, and `input:number` a number. `=<json>` is a fixed value the method
 * always takes (`=true` for its `confirm`). A blank value is left out, so the
 * method sees only what was given.
 */
export function operatorInputFromValues(fields: Readonly<Record<string, string>>, values: ActionValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(fields)) {
    const [id, shape] = spec.startsWith('=') ? ['', '='] as [string, string] : spec.split(':') as [string, string | undefined];
    const raw = shape === '=' ? spec.slice(1) : values[id];
    if (raw === undefined || raw === '') continue;
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    let value: unknown = raw;
    if (shape === '=') value = JSON.parse(raw) as unknown;
    else if (shape === 'number') value = Number(raw);
    else if (shape === 'first') value = lines[0];
    else if (shape === 'rest') value = lines.slice(1);
    else if (shape === 'lines') value = lines;
    else if (shape === 'pairs') {
      value = Object.fromEntries(lines.flatMap((line) => {
        const eq = line.indexOf('=');
        return eq > 0 ? [[line.slice(0, eq).trim(), line.slice(eq + 1)]] : [];
      }));
    }
    if (value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)) continue;
    let node = input;
    const parts = field.split('.');
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node = (next && typeof next === 'object' ? next : (node[part] = {})) as Record<string, unknown>;
    }
    node[parts.at(-1)!] = value;
  }
  return input;
}

/** An action's daemon method: its id, which input fills which field, and the method that reads the fields first. */
export interface CapabilityMethod {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  /**
   * A read the fields go to first, with the caller's time zone (`zone`): it answers `{ summary, input }`, and
   * `input` is the body the method takes (`automation.schedules.preview` reads a schedule's blanks into the body of
   * `automation.schedules.create`). The web UI's sheet runs the same two calls.
   */
  readonly preview?: string | undefined;
}

/**
 * The body an action's method is sent: its fields filled from the values, or, for an action with a preview, the
 * `input` its preview answers for them. `readPreview` makes that read call; nothing is kept by it.
 */
export async function methodBodyOf(method: CapabilityMethod, values: ActionValues,
  readPreview: (previewId: string, input: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>> {
  const fields = operatorInputFromValues(method.fields, values);
  if (!method.preview) return fields;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const read = await readPreview(method.preview, { ...fields, zone });
  const record = read !== null && typeof read === 'object' && !Array.isArray(read) ? read as Record<string, unknown> : {};
  const input = record['input'];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityRefusal(`Nothing was kept: ${method.preview} did not say what ${method.id} would keep.`);
  }
  return input as Record<string, unknown>;
}
