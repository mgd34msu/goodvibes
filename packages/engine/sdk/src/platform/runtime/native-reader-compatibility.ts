/** Installation-owned reader requirements, published before incompatible data.
 * The publisher comes from native installation admission, never a workspace,
 * request or process-name heuristic. Publishing only restricts later installs;
 * it does not authorize reading data or executing any saved operation. */
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { drainOwned } from '@goodvibes-jev/judgment';
import { atomicWriteFileSync } from '../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { compareSemanticVersions, parseSemanticVersion } from './semantic-version.js';
import type { UpdateFileIo } from './self-update.js';

export const NATIVE_READER_REQUIREMENT_FILE = '.goodvibes-reader-requirements.json';
/** Installation metadata support, separate from application-data write floors. */
export const NATIVE_PREVIOUS_READER_RECEIPT_FORMAT = 'daemon-previous-reader-receipt-v1';
export type NativeDataFormat = 'payment-retained-holds-v2' | 'telegram-account-cursors-v2' | 'payment-window-checkpoints-v1' | 'payment-window-checkpoints-v2' | 'payment-reply-history-v1' | 'payment-reply-coverage-v1' | 'payment-operation-reconciliation-v2' | 'delegated-review-owner-v2' | 'discord-inbox-identities-v1';
const requirements: Readonly<Record<NativeDataFormat, string>> = {
  'payment-retained-holds-v2': '3.1.2', 'telegram-account-cursors-v2': '3.1.2',
  'payment-window-checkpoints-v1': '3.1.2',
  'payment-window-checkpoints-v2': '3.1.2',
  'payment-reply-history-v1': '3.1.2',
  'payment-reply-coverage-v1': '3.1.2',
  'payment-operation-reconciliation-v2': '3.1.2',
  'delegated-review-owner-v2': '3.1.2',
  'discord-inbox-identities-v1': '3.1.2',
};
export interface NativeReaderCapabilities {
  readonly schema: 1;
  readonly version: string;
  readonly formats: readonly string[];
}

/** Compiled into the same program as its actual readers; never inferred from
 * a candidate's version or filled in when opening an older artifact. */
export function nativeReaderCapabilities(readerVersion: string): NativeReaderCapabilities {
  version(readerVersion);
  return Object.freeze({ schema: 1, version: readerVersion,
    formats: Object.freeze([...Object.keys(requirements), NATIVE_PREVIOUS_READER_RECEIPT_FORMAT].sort()) });
}

export function parseNativeReaderCapabilities(value: unknown): NativeReaderCapabilities {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeDataCompatibilityError('unavailable');
    const prototype: unknown = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 3
      || keys.some(key => key !== 'schema' && key !== 'version' && key !== 'formats')) throw new NativeDataCompatibilityError('unavailable');
    const ownData = (object: object, key: PropertyKey): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) throw new NativeDataCompatibilityError('unavailable');
      return descriptor.value;
    };
    const schema = ownData(value, 'schema'), readerVersion = ownData(value, 'version'), input = ownData(value, 'formats');
    if (schema !== 1 || typeof readerVersion !== 'string' || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new NativeDataCompatibilityError('unavailable');
    const length = ownData(input, 'length');
    if (typeof length !== 'number' || length > 256 || Reflect.ownKeys(input).length !== length + 1) throw new NativeDataCompatibilityError('unavailable');
    const formats: string[] = [];
    for (let index = 0; index < length; index++) {
      const item = ownData(input, index);
      if (typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(item) || formats.includes(item)) throw new NativeDataCompatibilityError('unavailable');
      formats.push(item);
    }
    version(readerVersion);
    return Object.freeze({ schema: 1, version: readerVersion, formats: Object.freeze(formats) });
  } catch { throw new NativeDataCompatibilityError('unavailable'); }
}
interface ReaderRequirements { readonly schema: 1; readonly minimumReader: string; readonly formats: readonly NativeDataFormat[] }
export interface NativeDataWriteOwner { declare(format: NativeDataFormat): void }
export interface AdmittedNativeDataPublisher { readonly execPath: string; readonly version: string; readonly assertCurrent: () => void }

export class NativeDataCompatibilityError extends Error {
  override readonly name = 'NativeDataCompatibilityError';
  constructor(readonly kind: 'unavailable' | 'incompatible' | 'busy' | 'unconfirmed-reader', minimum?: string) {
    super(kind === 'incompatible' && minimum
      ? `Saved application data requires GoodVibes ${minimum} or newer. The previous reader cannot be installed or restored.`
      : kind === 'unconfirmed-reader' ? 'This candidate build does not confirm support for the saved data formats. Keep the current installation and select a build with verified reader capabilities.'
      : kind === 'busy' ? 'Another native owner is publishing data-reader requirements. Retry after that operation settles.'
      : 'The installed data-reader requirements could not be confirmed. Keep the current installation and inspect its original compatibility evidence.');
  }
}
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function version(value: string) {
  const parsed = parseSemanticVersion(value.replace(/^v/i, ''));
  if (!parsed) throw new NativeDataCompatibilityError('unavailable');
  return parsed;
}
function pathFor(execPath: string): string {
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath) throw new NativeDataCompatibilityError('unavailable');
  return join(dirname(execPath), NATIVE_READER_REQUIREMENT_FILE);
}
function parse(bytes: Uint8Array): ReaderRequirements {
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || row['schema'] !== 1 || typeof row['minimumReader'] !== 'string'
      || !Array.isArray(row['formats']) || row['formats'].length < 1 || row['formats'].length > Object.keys(requirements).length
      || new Set(row['formats']).size !== row['formats'].length
      || row['formats'].some(item => typeof item !== 'string' || !Object.hasOwn(requirements, item))) throw new Error();
    const minimum = version(row['minimumReader']);
    for (const item of row['formats'] as NativeDataFormat[]) {
      if (compareSemanticVersions(minimum, version(requirements[item])) < 0) throw new Error();
    }
    return Object.freeze({ schema: 1, minimumReader: row['minimumReader'], formats: Object.freeze([...row['formats']]) as readonly NativeDataFormat[] });
  } catch { throw new NativeDataCompatibilityError('unavailable'); }
}
function read(path: string): { readonly value: ReaderRequirements | null; readonly observed: FileObservation | null } {
  try { const observed = readFileObservation(path); return { value: parse(observed.bytes), observed }; }
  catch (error) {
    if (missing(error)) {
      try { lstatSync(path); } catch (absent) { if (missing(absent)) return { value: null, observed: null }; }
    }
    throw new NativeDataCompatibilityError('unavailable');
  }
}

/** The real composition passes the already-admitted executable and its retained
 * native installation guard. Preserve that guard across every publication. */
export function createNativeDataWriteOwner(publisher: AdmittedNativeDataPublisher): NativeDataWriteOwner {
  const execPath = publisher.execPath, runningVersion = publisher.version, guard = publisher.assertCurrent;
  const path = pathFor(execPath); version(runningVersion);
  let observedFile = false, failed = false;
  const current = () => {
    if (failed || publisher.execPath !== execPath || publisher.version !== runningVersion || publisher.assertCurrent !== guard) throw new NativeDataCompatibilityError('unavailable');
    const result: unknown = guard.call(publisher);
    if (result !== undefined) { drainOwned(result); throw new NativeDataCompatibilityError('unavailable'); }
  };
  return Object.freeze({ declare(format: NativeDataFormat): void {
    let release: (() => void) | null = null;
    try {
      if (failed) throw new NativeDataCompatibilityError('unavailable');
      if (!Object.hasOwn(requirements, format)) throw new Error();
      release = tryAcquireCrossProcessLock(`${path}.lock`);
      if (!release) throw new NativeDataCompatibilityError('busy');
      const lease = readFileObservation(`${path}.lock`);
      const assertLease = () => {
        const now = readFileObservation(`${path}.lock`);
        if (now.physical !== lease.physical || !now.bytes.equals(lease.bytes)) throw new Error();
      };
      const previous = read(path);
      if (observedFile && previous.value === null) throw new Error();
      if (previous.value !== null) observedFile = true;
      const required = requirements[format];
      const minimumReader = previous.value !== null && compareSemanticVersions(version(previous.value.minimumReader), version(required)) >= 0
        ? previous.value.minimumReader : required;
      if (compareSemanticVersions(version(runningVersion), version(minimumReader)) < 0) throw new NativeDataCompatibilityError('incompatible', minimumReader);
      if (!previous.value?.formats.includes(format) || previous.value.minimumReader !== minimumReader) {
        current();
        const next: ReaderRequirements = { schema: 1, minimumReader, formats: [...(previous.value?.formats ?? []), format].filter((value, index, all) => all.indexOf(value) === index) };
        const contents = `${JSON.stringify(next)}\n`;
        atomicWriteFileSync(path, contents, { mode: 0o600, assertCurrent: () => {
          current(); assertLease();
          const now = read(path);
          if (now.observed?.physical !== previous.observed?.physical || (now.observed !== null && !now.observed.bytes.equals(previous.observed?.bytes ?? Buffer.alloc(0)))) throw new Error();
        } });
        if (!readFileObservation(path).bytes.equals(Buffer.from(contents))) throw new Error();
        observedFile = true;
        current();
      }
      assertLease();
      // An already established requirement is a retained data fact, not a
      // fresh execution grant. Final accounting may use it while the host
      // drains after cancellation; no new requirement is published there.
    } catch (error) {
      if (!(error instanceof NativeDataCompatibilityError && error.kind === 'busy')) failed = true;
      throw error instanceof NativeDataCompatibilityError ? error : new NativeDataCompatibilityError('unavailable');
    } finally {
      try { release?.(); } catch { failed = true; throw new NativeDataCompatibilityError('unavailable'); }
    }
  } });
}

/** Call inside the existing native swap claims, using its captured filesystem.
 * A requirement is established before its data write. A publisher checks those
 * same claims through its installation guard, so a downgrade cannot race it. */
export function assertNativeReaderCompatible(execPath: string, proposedVersion: string, io: Pick<UpdateFileIo, 'observe' | 'readFile'>,
  capabilities?: NativeReaderCapabilities): void {
  try {
    const proposed = version(proposedVersion);
    const readers = capabilities === undefined ? undefined : parseNativeReaderCapabilities(capabilities);
    const path = pathFor(execPath);
    if (!io.observe || !io.readFile) throw new Error();
    const observed = io.observe(path); if (observed === null) return;
    const bytes = io.readFile(path), required = parse(bytes), after = io.observe(path);
    if (after === null || observed.identity !== after.identity || observed.ownerIdentity !== after.ownerIdentity) throw new Error();
    if (compareSemanticVersions(proposed, version(required.minimumReader)) < 0) throw new NativeDataCompatibilityError('incompatible', required.minimumReader);
    if (!readers) throw new NativeDataCompatibilityError('unconfirmed-reader');
    if (readers.version.replace(/^v/i, '') !== proposedVersion.replace(/^v/i, '')
      || required.formats.some(format => !readers.formats.includes(format))) throw new NativeDataCompatibilityError('unconfirmed-reader');
  } catch (error) { throw error instanceof NativeDataCompatibilityError ? error : new NativeDataCompatibilityError('unavailable'); }
}
