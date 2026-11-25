import { CapabilityRefusal, type ActionValues } from './types.js';

/**
 * What an action sends to its operator method: each field (a dot path) takes
 * the value of the input it names. `input:first` and `input:rest` take the
 * first line and the lines after it as a list (a command and its arguments),
 * `input:lines` all lines as a list, `input:pairs` NAME=VALUE lines as an
 * object, `input:number` a number, `input:onoff` true for `on` and false for
 * `off`, and `input:commas` a comma list (`none` sends an empty list, which
 * clears it). `input:yes` is `true` for the value `yes` and left out
 * otherwise (a switch). `input:only:a,b,c` is an object over the names a, b and
 * c, each `true` when it is one of the input's lines and `false` when not (the
 * parts chosen, out of every part). `input:except:<value>` is the value as
 * given, left out when it is `<value>` (a choice whose default means the
 * method's own). This is the one reader of these shapes: the daemon's
 * `capabilities.run`, the web UI's sheet and the model's tools all call it. `=<json>` is a fixed value the method
 * always takes (`=true` for its `confirm`). A blank value is left out, so the
 * method sees only what was given.
 */
export function operatorInputFromValues(fields: Readonly<Record<string, string>>, values: ActionValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(fields)) {
    const [id, shape, universe] = spec.startsWith('=') ? ['', '=', undefined] as [string, string, undefined] : spec.split(':') as [string, string | undefined, string | undefined];
    if (shape === 'yes' && values[id] !== 'yes') continue;
    // `input:except:<value>`: the value as given, left out when it is <value> (a choice whose default means "the method's own").
    if (shape === 'except' && values[id] === universe) continue;
    const raw = shape === '=' ? spec.slice(1) : values[id];
    if (raw === undefined || raw === '') continue;
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    let value: unknown = raw;
    if (shape === '=') value = JSON.parse(raw) as unknown;
    else if (shape === 'number') value = Number(raw);
    else if (shape === 'first') value = lines[0];
    else if (shape === 'rest') value = lines.slice(1);
    else if (shape === 'lines') value = lines;
    else if (shape === 'yes') value = true;
    else if (shape === 'only') value = Object.fromEntries((universe ?? '').split(',').filter(Boolean).map((name) => [name, lines.includes(name)]));
    else if (shape === 'onoff') value = raw.trim().toLowerCase() === 'on' ? true : raw.trim().toLowerCase() === 'off' ? false : undefined;
    else if (shape === 'commas') {
      // `none` clears the list: the one empty list that is sent.
      if (raw.trim().toLowerCase() === 'none') {
        setPath(input, field, []);
        continue;
      }
      value = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
    } else if (shape === 'pairs') {
      value = Object.fromEntries(lines.flatMap((line) => {
        const eq = line.indexOf('=');
        return eq > 0 ? [[line.slice(0, eq).trim(), line.slice(eq + 1)]] : [];
      }));
    }
    if (value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)) continue;
    setPath(input, field, value);
  }
  return input;
}

/**
 * The input a method is given for what `operatorInputFromValues` built, read the way the invoke endpoint reads a
 * request's `{ body }` envelope: a field written `body.<name>` (as the web UI's sheets and older actions name the
 * request's body) lands at `<name>` of the method's input, beside the fields written without it, and wins over a
 * field of the same name. A method whose own input declares an object named `body` is sent what was built, as it is.
 * `inputSchema` is the method's declared input schema.
 */
export function methodInputOf(built: Readonly<Record<string, unknown>>, inputSchema?: unknown): Record<string, unknown> {
  const envelope = built['body'];
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return { ...built };
  const properties = inputSchema !== null && typeof inputSchema === 'object' ? (inputSchema as { properties?: unknown }).properties : undefined;
  const declared = properties !== null && typeof properties === 'object' ? (properties as Record<string, unknown>)['body'] : undefined;
  if (declared !== null && typeof declared === 'object' && (declared as { type?: unknown }).type === 'object') return { ...built };
  const rest = Object.fromEntries(Object.entries(built).filter(([key]) => key !== 'body'));
  return { ...rest, ...(envelope as Record<string, unknown>) };
}

/** Put `value` at the dot path `field` of `input`, making the objects on the way. */
function setPath(input: Record<string, unknown>, field: string, value: unknown): void {
  let node = input;
  const parts = field.split('.');
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    node = (next && typeof next === 'object' ? next : (node[part] = {})) as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
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
  /**
   * What it makes belongs to the caller's project (a schedule's runs work there): the caller's project folder goes
   * with the body as `workingDirectory`, and a caller that names none is refused by the method.
   */
  readonly project?: true | undefined;
}

/**
 * The body an action's method is sent: its fields filled from the values, or, for an action with a preview, the
 * `input` its preview answers for them. `readPreview` makes that read call; nothing is kept by it.
 */
export async function methodBodyOf(method: CapabilityMethod, values: ActionValues,
  readPreview: (previewId: string, input: Record<string, unknown>) => Promise<unknown>, project?: string | undefined): Promise<Record<string, unknown>> {
  const withProject = (body: Record<string, unknown>): Record<string, unknown> =>
    method.project && project ? { ...body, workingDirectory: project } : body;
  const fields = operatorInputFromValues(method.fields, values);
  if (!method.preview) return withProject(fields);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const read = await readPreview(method.preview, { ...fields, zone });
  const record = read !== null && typeof read === 'object' && !Array.isArray(read) ? read as Record<string, unknown> : {};
  const input = record['input'];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityRefusal(`Nothing was kept: ${method.preview} did not say what ${method.id} would keep.`);
  }
  return withProject(input as Record<string, unknown>);
}
