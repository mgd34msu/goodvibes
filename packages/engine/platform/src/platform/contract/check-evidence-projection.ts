import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '@goodvibes-jev/judgment';

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural compression only: every field, value, row and ordering survives. */
function observationTable(value: JsonValue | undefined, splitPaths = false): JsonValue | undefined {
  if (!Array.isArray(value) || value.length < 2 || !value.every(object)) return value;
  const common = Object.keys(value[0]!).filter(key => value.every(row => Object.hasOwn(row, key)));
  const shared = Object.fromEntries(common.filter(key => value.every(row => isDeepStrictEqual(row[key], value[0]![key])))
    .map(key => [key, value[0]![key]!]));
  const columns = common.filter(key => !Object.hasOwn(shared, key));
  const directories: string[] = [], directoryIds = new Map<string, number>();
  const pathParts = (path: JsonValue): JsonValue => {
    if (typeof path !== 'string') return path;
    const slash = path.lastIndexOf('/'), directory = path.slice(0, slash + 1);
    let id = directoryIds.get(directory);
    if (id === undefined) { id = directories.length; directories.push(directory); directoryIds.set(directory, id); }
    return [id, path.slice(slash + 1)];
  };
  const encodePaths = splitPaths && columns.includes('path') && value.every(row => typeof row['path'] === 'string');
  const rows = value.map(row => {
    const fields = columns.map(key => encodePaths && key === 'path' ? pathParts(row[key]!) : row[key]!);
    const additional = Object.fromEntries(Object.entries(row).filter(([key]) => !common.includes(key)));
    return Object.keys(additional).length ? [...fields, additional] : fields;
  });
  const table = { representation: 'lossless-observation-table', shared, columns: [...columns, 'additionalFields'], rows,
    ...(encodePaths ? { pathDirectories: directories } : {}),
    meaning: 'Expand each row in its original order: start with shared, assign the named columns, then merge additionalFields if present. An absent trailing additionalFields column means no extra fields; null is an actual value. When pathDirectories is supplied, each path cell is [directoryIndex, basename]; concatenate that exact directory string and basename. No field, path, observation or assessment is omitted. This representation grants no inspection, execution or acceptance.' };
  return JSON.stringify(table).length < JSON.stringify(value).length ? table : value;
}

/** Ordered references to the same paths already present in the file table. */
function pathReferences(value: JsonValue | undefined, files: readonly JsonObject[]): JsonValue | undefined {
  if (!Array.isArray(value) || !value.every(path => typeof path === 'string')) return value;
  const byPath = new Map<string, number>();
  for (const [index, file] of files.entries()) {
    const path = file['path'];
    if (typeof path !== 'string' || byPath.has(path)) return value;
    byPath.set(path, index);
  }
  const ranges: number[][] = [];
  for (const path of value) {
    const index = byPath.get(path);
    if (index === undefined) return value;
    const last = ranges.at(-1);
    if (last && last[1]! + 1 === index) last[1] = index;
    else ranges.push([index, index]);
  }
  const reference = { representation: 'file-row-ranges', ranges,
    meaning: 'The exact ordered path list: expand each inclusive zero-based [first,last] range into the paths of files rows in this same inventory. Repeated or out-of-order ranges retain their original order. This is not a count or a sample.' };
  return JSON.stringify(reference).length < JSON.stringify(value).length ? reference : value;
}

/** Keep native evidence untouched; pack only the state sent for judgment. */
export function projectCheckEvidence(state: JsonObject): JsonObject {
  const host = state['orchestration'];
  if (!object(host)) return state;
  const currentFiles = observationTable(host['currentFiles']);
  const inventory = host['reviewInventory'];
  let reviewInventory = inventory;
  if (object(inventory) && Array.isArray(inventory['files']) && inventory['files'].every(object)) {
    const files = observationTable(inventory['files'], true);
    if (files !== inventory['files']) reviewInventory = { ...inventory, files: files!,
      ...(inventory['remainingFiles'] === undefined ? {} : { remainingFiles: pathReferences(inventory['remainingFiles'], inventory['files'])! }),
      ...(inventory['versionChecksPending'] === undefined ? {} : { versionChecksPending: pathReferences(inventory['versionChecksPending'], inventory['files'])! }) };
  }
  // actualHostOperations prefixes owner validation and then repeats these exact
  // currentFiles objects. Replace only this proven contiguous duplicate, never
  // an unrelated or merely similarly labelled operation.
  let hostOperations = state['hostOperations'];
  if (currentFiles !== host['currentFiles'] && Array.isArray(host['currentFiles']) && Array.isArray(hostOperations)) {
    const files = host['currentFiles'], operations = hostOperations;
    const start = hostOperations.findIndex(entry => entry === files[0]);
    if (start >= 0 && files.every((entry, index) => operations[start + index] === entry)) {
      hostOperations = [...hostOperations.slice(0, start), {
        representation: 'same-state-reference', path: ['orchestration', 'currentFiles'],
        meaning: 'The complete current-file operations at this position are supplied once in orchestration.currentFiles in this same state. Expand its lossless table here; no operation is omitted.' }, ...hostOperations.slice(start + files.length)];
    }
  }
  return { ...state, ...(hostOperations === undefined ? {} : { hostOperations }), orchestration: { ...host,
    ...(currentFiles === undefined ? {} : { currentFiles }), ...(reviewInventory === undefined ? {} : { reviewInventory }) } };
}
