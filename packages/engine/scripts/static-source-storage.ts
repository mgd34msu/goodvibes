/** Lossless JSON storage for the static source cache. Ordinals locate strings;
 * they are neither content fingerprints nor evidence of equality/currentness. */
export const STATIC_SOURCE_STORAGE = 'static-source-string-table';
export const STATIC_SOURCE_STORAGE_VERSION = 1;
export type EncodedStaticSourceValue = null | boolean | number
  | readonly ['s', number] | readonly ['a', readonly EncodedStaticSourceValue[]]
  | readonly ['o', ReadonlyArray<readonly [number, EncodedStaticSourceValue]>] | readonly ['z'];
export interface PackedStaticSourceStorage {
  readonly storage: typeof STATIC_SOURCE_STORAGE;
  readonly version: typeof STATIC_SOURCE_STORAGE_VERSION;
  readonly strings: readonly string[];
  readonly value: EncodedStaticSourceValue;
}
const invalid = (): never => { throw new Error('Invalid static source storage'); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function encoder() {
  const strings: string[] = [], ordinals = new Map<string, number>(), active = new Set<object>();
  const intern = (value: string): number => {
    const prior = ordinals.get(value); if (prior !== undefined) return prior;
    const index = strings.length; strings.push(value); ordinals.set(value, index); return index;
  };
  const objectEntries = (entries: Iterable<readonly [string, unknown]>): readonly ['o', ReadonlyArray<readonly [number, EncodedStaticSourceValue]>] => {
    const seen = new Set<string>(), encoded: Array<readonly [number, EncodedStaticSourceValue]> = [];
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || seen.has(key)) return invalid();
      seen.add(key); encoded.push([intern(key), encode(value)]);
    }
    return ['o', encoded];
  };
  const encode = (value: unknown): EncodedStaticSourceValue => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid();
      return Object.is(value, -0) ? ['z'] : value;
    }
    if (typeof value === 'string') return ['s', intern(value)];
    if (typeof value !== 'object' || active.has(value)) return invalid();
    const array = Array.isArray(value), proto: unknown = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return invalid();
    active.add(value);
    try {
      if (array) {
        const result: EncodedStaticSourceValue[] = [];
        if (keys.length !== value.length + 1) return invalid();
        for (let index = 0; index < value.length; index++) {
          const entry = Object.getOwnPropertyDescriptor(value, String(index));
          if (!entry || !('value' in entry) || !entry.enumerable) return invalid();
          result.push(encode(entry.value));
        }
        return ['a', result];
      }
      const entries: Array<readonly [string, unknown]> = [];
      for (const key of keys) {
        if (typeof key !== 'string') return invalid();
        const entry = Object.getOwnPropertyDescriptor(value, key);
        if (!entry || !('value' in entry) || !entry.enumerable) return invalid();
        entries.push([key, entry.value]);
      }
      return objectEntries(entries);
    } finally { active.delete(value); }
  };
  const finish = (value: EncodedStaticSourceValue): PackedStaticSourceStorage =>
    ({ storage: STATIC_SOURCE_STORAGE, version: STATIC_SOURCE_STORAGE_VERSION, strings, value });
  return { encode, objectEntries, finish, intern };
}

export function packStaticSourceStorage(value: unknown): PackedStaticSourceStorage {
  const packing = encoder(); return packing.finish(packing.encode(value));
}

/** Convert one genuine receipt at a time. Retains encoded data and one string
 * table, never a second complete raw readings tree or a giant raw JSON string. */
export function packStaticSourceReadings(entries: Iterable<readonly [string, unknown]>, readingPlanVersion?: 1 | 2 | 3): PackedStaticSourceStorage {
  const packing = encoder();
  const readings = packing.objectEntries(entries);
  const outer: Array<readonly [number, EncodedStaticSourceValue]> = [[packing.intern('format'), 2]];
  if (readingPlanVersion !== undefined) outer.push([packing.intern('readingPlanVersion'), readingPlanVersion]);
  outer.push([packing.intern('readings'), readings]);
  return packing.finish(['o', outer]);
}

export function isPackedStaticSourceStorage(value: unknown): value is PackedStaticSourceStorage {
  return record(value) && value.storage === STATIC_SOURCE_STORAGE;
}

/** Decode one node whose children have already been decoded. Explicit parser
 * roles, rather than the shape of a decoded user array, select this operation. */
export function createStaticSourceStorageValueDecoder(table: unknown) {
  if (!Array.isArray(table)) return invalid();
  const strings: string[] = [], seen = new Set<string>();
  for (const item of table) {
    if (typeof item !== 'string' || seen.has(item)) return invalid();
    strings.push(item); seen.add(item);
  }
  const stringAt = (index: unknown): string => {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= strings.length) return invalid();
    return strings[index]!;
  };
  return { decodeNode(node: unknown): unknown {
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? node : invalid();
    if (!Array.isArray(node)) return invalid();
    if (node[0] === 'z' && node.length === 1) return -0;
    if (node[0] === 's' && node.length === 2) return stringAt(node[1]);
    if (node[0] === 'a' && node.length === 2 && Array.isArray(node[1])) return node[1];
    if (node[0] !== 'o' || node.length !== 2 || !Array.isArray(node[1])) return invalid();
    const result: Record<string, unknown> = {}, keys = new Set<string>();
    for (const entry of node[1]) {
      if (!Array.isArray(entry) || entry.length !== 2) return invalid();
      const key = stringAt(entry[0]); if (keys.has(key)) return invalid(); keys.add(key);
      Object.defineProperty(result, key, { value: entry[1], enumerable: true, writable: true, configurable: true });
    }
    return result;
  } };
}

function unpack(value: unknown, consume: boolean): unknown {
  if (!record(value) || value.storage !== STATIC_SOURCE_STORAGE || value.version !== STATIC_SOURCE_STORAGE_VERSION
    || Object.keys(value).length !== 4 || !Object.hasOwn(value, 'value')) return invalid();
  const decoder = createStaticSourceStorageValueDecoder(value.strings);
  const decode = (node: unknown): unknown => {
    if (!Array.isArray(node)) return decoder.decodeNode(node);
    const body: unknown = node[1];
    if (node[0] === 'a' && node.length === 2 && Array.isArray(body)) {
      const items = consume ? body : [...body];
      for (let index = 0; index < items.length; index++) items[index] = decode(items[index]);
      return decoder.decodeNode(['a', items]);
    }
    if (node[0] === 'o' && node.length === 2 && Array.isArray(body)) {
      const entries = consume ? body : body.map(entry => Array.isArray(entry) ? [...entry] : entry);
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return invalid();
        entry[1] = decode(entry[1]);
      }
      const result = decoder.decodeNode(['o', entries]);
      // The streaming reader owns fallback containers when a valid envelope
      // orders value before its string table. Release consumed descendants.
      if (consume) entries.length = 0;
      return result;
    }
    return decoder.decodeNode(node);
  };
  const result = decode(value.value);
  if (consume) value.value = result;
  return result;
}

export function unpackStaticSourceStorage(value: unknown): unknown { return unpack(value, false); }
/** Parser-owned fallback only; never mutate a caller's packed storage value. */
export function consumeStaticSourceStorage(value: unknown): unknown { return unpack(value, true); }
