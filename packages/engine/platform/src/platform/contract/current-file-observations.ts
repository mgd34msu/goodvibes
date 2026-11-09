import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { summarizeError } from '../utils/error-display.js';
import { originalContractInputFileDigest, type ContractInputFile } from './input-snapshot.js';
import { ownedContractCheckpointText, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';

const inputIdentity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const fileFacts = (stat: BigIntStats): readonly string[] => Object.freeze([
  stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs,
].map(String));
const sameFields = (left: readonly string[], right: readonly string[] | undefined): boolean => right !== undefined
  && left.length === right.length && left.every((value, index) => value === right[index]);
function directoryFacts(path: string): readonly string[] {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Current file directory owner changed.');
  return Object.freeze([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].map(String));
}
export interface CurrentFileReviewFacts {
  readonly version: 1;
  readonly directories: readonly (readonly string[])[];
  readonly file: readonly string[];
}
interface NativeFileObservation {
  readonly bytes: Buffer;
  readonly facts: CurrentFileReviewFacts;
  readonly assertCurrent: () => void;
  legacyDigest?: string;
}
// Original native objects own these bytes. Copies, reconstructed JSON and
// source flags cannot acquire the observation. No global path/content cache.
const nativeFiles = new WeakMap<object, NativeFileObservation>();
// Labels are stable only within the actual owner lifetime. Retain metadata,
// never file bytes, and only the latest incarnation per path: A -> B -> A
// cannot recover an earlier label after an intervening observed version.
const ownerLabels = new WeakMap<object, Map<string, { readonly facts: CurrentFileReviewFacts; readonly id: string }>>();
const observationLabel = /^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/;
export function parseCurrentFileReviewFacts(value: unknown): CurrentFileReviewFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native file observation facts');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(',') !== 'directories,file,version' || source['version'] !== 1
    || !Array.isArray(source['directories']) || !source['directories'].length || source['directories'].length > 1024) throw new Error('Invalid native file observation facts');
  const row = (fields: unknown, count: number): readonly string[] => {
    if (!Array.isArray(fields) || fields.length !== count || !fields.every(field => typeof field === 'string' && field.length <= 128 && /^-?\d+$/.test(field))) throw new Error('Invalid native file observation facts');
    return Object.freeze([...fields] as string[]);
  };
  return Object.freeze({ version: 1, directories: Object.freeze(source['directories'].map(fields => row(fields, 6))), file: row(source['file'], 10) });
}
/** Checkpoint-only labels keep saved refusal and candidate bindings stable.
 * No source bytes are retained here and these labels cannot issue byte proof. */
export function storedCurrentFileLabels(owner: object) {
  const labels = ownerLabels.get(owner);
  return labels?.size ? { version: 1, entries: [...labels].map(([path, label]) => ({ path, id: label.id, facts: label.facts })) } : undefined;
}
/** Graceful disposal owns a new metadata map, not the mutable original map
 * or any native byte observation. Only the original runtime owner supplies it. */
export function retainCurrentFileLabels(original: object, copy: object): void {
  const labels = ownerLabels.get(original);
  if (labels) ownerLabels.set(copy, new Map(labels));
}
/** Read the table from the actual owned checkpoint itself. Arbitrary parsed
 * JSON and public import cannot seed the native owner's label registry. */
export function restoreCurrentFileLabels(owner: object, receipt: OwnedContractCheckpointRead): void {
  const text = ownedContractCheckpointText(receipt), envelope: unknown = JSON.parse(text);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Invalid native file label checkpoint');
  const table = (envelope as Record<string, unknown>)['nativeFileLabels'];
  if (table === undefined) return;
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Invalid native file label checkpoint');
  const source = table as Record<string, unknown>;
  if (Object.keys(source).sort().join(',') !== 'entries,version' || source['version'] !== 1 || !Array.isArray(source['entries'])) throw new Error('Invalid native file label checkpoint');
  const labels = new Map<string, { readonly facts: CurrentFileReviewFacts; readonly id: string }>(), ids = new Set<string>();
  for (const entry of source['entries']) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid native file label checkpoint');
    const record = entry as Record<string, unknown>, path = record['path'], id = record['id'];
    if (Object.keys(record).sort().join(',') !== 'facts,id,path' || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path
      || typeof id !== 'string' || !observationLabel.test(id) || labels.has(path) || ids.has(id)) throw new Error('Invalid native file label checkpoint');
    labels.set(path, { facts: parseCurrentFileReviewFacts(record['facts']), id }); ids.add(id);
  }
  if (ownedContractCheckpointText(receipt) !== text) throw new Error('Native file label checkpoint changed');
  ownerLabels.set(owner, labels);
}
function retained(value: unknown): NativeFileObservation | undefined {
  return value !== null && typeof value === 'object' ? nativeFiles.get(value) : undefined;
}
export function isCurrentNativeFileObservation(value: unknown): boolean {
  const observation = retained(value);
  if (!observation) return false;
  try { observation.assertCurrent(); return true; } catch { return false; }
}
/** Exact original bytes and original physical owner, never a content label. */
export function currentFileMatchesText(value: unknown, text: string): boolean {
  const observation = retained(value);
  if (!observation || typeof text !== 'string' || Buffer.byteLength(text) !== observation.bytes.length) return false;
  try {
    observation.assertCurrent(); const matches = Buffer.from(text, 'utf8').equals(observation.bytes);
    observation.assertCurrent(); return matches;
  } catch { return false; }
}
/** Private native bookkeeping; do not place these facts in a model request. */
export function currentFileReviewFacts(value: unknown): CurrentFileReviewFacts | undefined {
  const observation = retained(value);
  if (!observation) return undefined;
  observation.assertCurrent(); return observation.facts;
}
/** Actual earlier saved reviewedFiles.sha256 records are the only consumer.
 * One compatibility commitment per original observation; fresh reads need none. */
export function currentFileMatchesSavedDigest(value: unknown, digest: string): boolean {
  const observation = retained(value);
  if (!observation || !/^[a-f0-9]{64}$/.test(digest)) return false;
  try {
    observation.assertCurrent();
    observation.legacyDigest ??= createHash('sha256').update(observation.bytes).digest('hex');
    observation.assertCurrent(); return observation.legacyDigest === digest;
  } catch { return false; }
}

/** Actual file identity observations shared by native checks and repair context. */
export function currentFileObservations(cwd: string, paths: readonly string[], options: {
  readonly includeText?: boolean;
  /** Actual captured publication-input contract; its existing digest is a
   * cross-boundary commitment, not the ordinary local read identity. */
  readonly inputFile?: ContractInputFile;
  /** Actual contract/check owner, never a source identity supplied by a model. */
  readonly owner?: object;
} = {}): JsonValue[] {
  const root = resolve(cwd);
  return [...new Set(paths)].flatMap<JsonValue>(path => {
    const parts = path.split('/');
    if (isAbsolute(path) || path.includes('\\') || parts.some(part => ['', '.', '..', '.git', '.goodvibes'].includes(part))) return [];
    try {
      const roots: string[] = [];
      for (let parent = root;; parent = dirname(parent)) { roots.unshift(parent); if (dirname(parent) === parent) break; }
      const directories = [...roots, ...parts.slice(0, -1).map((_part, index) => join(root, ...parts.slice(0, index + 1)))];
      if (directories.some(directory => !lstatSync(directory).isDirectory())) return [];
      const originalDirectories = Object.freeze(directories.map(directoryFacts));
      const absolute = join(root, path), before = lstatSync(absolute, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) return [];
      const originalFile = fileFacts(before);
      const assertCurrent = () => {
        if (directories.some((directory, index) => !sameFields(directoryFacts(directory), originalDirectories[index])))
          throw new Error('Current file directory owner changed.');
        const now = lstatSync(absolute, { bigint: true });
        if (!now.isFile() || now.isSymbolicLink() || !sameFields(fileFacts(now), originalFile))
          throw new Error('Current file observation is stale.');
      };
      const facts: CurrentFileReviewFacts = Object.freeze({ version: 1, directories: originalDirectories, file: originalFile });
      let labels: Map<string, { readonly facts: CurrentFileReviewFacts; readonly id: string }> | undefined;
      if (options.owner) {
        labels = ownerLabels.get(options.owner);
        if (!labels) { labels = new Map(); ownerLabels.set(options.owner, labels); }
      }
      const previous = labels?.get(absolute);
      const observationId = previous && isDeepStrictEqual(previous.facts, facts) ? previous.id : opaqueUuid();
      labels?.set(absolute, { facts, id: observationId });
      const expected = options.inputFile, expectedOid = expected?.oid;
      if (expected && (expected.path !== path || expected.kind !== 'file' || !expectedOid || expected.identity !== inputIdentity(before)))
        throw new Error('Current file no longer belongs to the selected captured input.');
      const originalInput = expected?.digest === undefined ? undefined : originalContractInputFileDigest(expected, root, path);
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        assertCurrent();
        if (!sameFields(fileFacts(fstatSync(fd, { bigint: true })), originalFile)) throw new Error('Current file changed before reading.');
        bytes = readFileSync(fd);
        if (BigInt(bytes.length) !== before.size || !sameFields(fileFacts(fstatSync(fd, { bigint: true })), originalFile))
          throw new Error('Current file changed while reading.');
        assertCurrent();
      } finally { closeSync(fd); }
      // Fresh native input already bound this original physical leaf's bytes.
      // Its exact owner may lend that commitment, but copied/foreign expected
      // files still require a complete independent byte comparison.
      originalInput?.assertCurrent();
      const sha256 = expected?.digest === undefined ? undefined : originalInput?.digest ?? createHash('sha256').update(bytes).digest('hex');
      if (expected?.digest !== undefined && sha256 !== expected.digest) throw new Error('Current file does not match its captured publication input.');
      const binary = bytes.includes(0), text = options.includeText && !binary ? bytes.toString('utf8') : undefined;
      let retired = false;
      const assertObservationCurrent = () => {
        if (retired) throw new Error('Current file observation has retired.');
        try {
          assertCurrent();
          if (labels && labels.get(absolute)?.id !== observationId) throw new Error('Current file observation was superseded.');
        } catch (error) { retired = true; throw error; }
      };
      const observation = Object.freeze({ operation: 'read-current-file', source: 'native-host-filesystem', success: true,
        path, bytes: bytes.length, binary, observationId,
        ...(sha256 === undefined ? {} : { sha256 }), ...(expectedOid ? { inputBlobOid: expectedOid } : {}),
        ...(text !== undefined && Buffer.from(text, 'utf8').equals(bytes) ? { text } : {}),
        meaning: 'A native read from the original current physical tree, with text when requested and representable. The observation ID labels this owner’s latest observed physical file version; it proves neither byte equality nor semantic correctness, worker inspection, execution or native approval.' });
      nativeFiles.set(observation, { bytes, facts, assertCurrent: assertObservationCurrent,
        ...(sha256 === undefined ? {} : { legacyDigest: sha256 }) });
      return [observation];
    } catch (error) {
      return [{ operation: 'read-current-file', source: 'native-host-filesystem', success: false, path,
        error: summarizeError(error), meaning: 'Current file identity could not be established.' }];
    }
  });
}
