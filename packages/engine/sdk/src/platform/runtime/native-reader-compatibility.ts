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
export type NativeDataFormat = 'payment-retained-holds-v2';
const requirements: Readonly<Record<NativeDataFormat, string>> = { 'payment-retained-holds-v2': '3.1.2' };
interface ReaderRequirements { readonly schema: 1; readonly minimumReader: string; readonly formats: readonly NativeDataFormat[] }
export interface NativeDataWriteOwner { declare(format: NativeDataFormat): void }
export interface AdmittedNativeDataPublisher { readonly execPath: string; readonly version: string; readonly assertCurrent: () => void }

export class NativeDataCompatibilityError extends Error {
  override readonly name = 'NativeDataCompatibilityError';
  constructor(readonly kind: 'unavailable' | 'incompatible' | 'busy', minimum?: string) {
    super(kind === 'incompatible' && minimum
      ? `Saved application data requires GoodVibes ${minimum} or newer. The previous reader cannot be installed or restored.`
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
export function assertNativeReaderCompatible(execPath: string, proposedVersion: string, io: Pick<UpdateFileIo, 'observe' | 'readFile'>): void {
  try {
    const proposed = version(proposedVersion);
    const path = pathFor(execPath);
    if (!io.observe || !io.readFile) throw new Error();
    const observed = io.observe(path); if (observed === null) return;
    const bytes = io.readFile(path), required = parse(bytes), after = io.observe(path);
    if (after === null || observed.identity !== after.identity || observed.ownerIdentity !== after.ownerIdentity) throw new Error();
    if (compareSemanticVersions(proposed, version(required.minimumReader)) < 0) throw new NativeDataCompatibilityError('incompatible', required.minimumReader);
  } catch (error) { throw error instanceof NativeDataCompatibilityError ? error : new NativeDataCompatibilityError('unavailable'); }
}
