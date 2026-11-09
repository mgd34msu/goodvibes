/** Native review bookkeeping. Public/runtime descriptors contain no filesystem
 * facts; only the explicit checkpoint writer projects them onto local disk. */
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '@goodvibes-jev/judgment';
import type { Contract } from './types.js';
import { currentFileReviewFacts, currentFileMatchesSavedDigest, parseCurrentFileReviewFacts, retainCurrentFileLabels, type CurrentFileReviewFacts } from './current-file-observations.js';
import { ownedContractCheckpointText, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';

export type ReviewedFileReference =
  | { readonly path: string; readonly sha256: string }
  | { readonly path: string; readonly observationId: string };
interface RetainedReview { readonly facts: CurrentFileReviewFacts; readonly native: boolean; readonly persistableNative: boolean }
const reviews = new WeakMap<object, RetainedReview>();
const historicalReviews = new WeakSet<object>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Contract reviewed file observation is unavailable');

/** Only the exact original host-read object can issue a native descriptor. */
export function reviewedFileFromObservation(value: JsonValue): ReviewedFileReference | undefined {
  if (!record(value) || typeof value['path'] !== 'string' || typeof value['observationId'] !== 'string') return undefined;
  const facts = currentFileReviewFacts(value);
  if (!facts) return undefined;
  const descriptor = Object.freeze({ path: value['path'], observationId: value['observationId'] });
  reviews.set(descriptor, { facts, native: true, persistableNative: true }); return descriptor;
}
export function reviewedFileVersionState(currentFile: JsonValue, descriptor: ReviewedFileReference): 'current' | 'changed' | 'unverified' {
  const retained = reviews.get(descriptor);
  if (retained?.native) {
    try {
      const current = currentFileReviewFacts(currentFile);
      return current && isDeepStrictEqual(current, retained.facts) ? 'current' : 'changed';
    } catch { return 'changed'; }
  }
  if ('sha256' in descriptor && historicalReviews.has(descriptor)) {
    return currentFileMatchesSavedDigest(currentFile, descriptor.sha256) ? 'current' : 'changed';
  }
  return 'unverified';
}
export function reviewedFileProvenance(descriptor: ReviewedFileReference): string {
  return 'sha256' in descriptor && historicalReviews.has(descriptor) ? 'historical-content-commitment; original physical ownership was not recorded'
    : reviews.get(descriptor)?.native ? 'native-original-physical-file-observation' : 'unverified-import-or-copy';
}
export function hasNativeReviewedFileReference(descriptor: ReviewedFileReference): boolean {
  return reviews.get(descriptor)?.native === true || historicalReviews.has(descriptor);
}
function serializeReference(descriptor: ReviewedFileReference) {
  if ('sha256' in descriptor) return { ...descriptor, historicalReviewOrigin: historicalReviews.has(descriptor) ? 'owned-historical-checkpoint' : 'unverified-import' };
  const retained = reviews.get(descriptor);
  if (!retained) throw invalid();
  return { ...descriptor, nativeFileObservation: { ...retained.facts,
    origin: retained.persistableNative ? 'native-host-filesystem' : 'unverified-import' } };
}

/** Walk only the real unit/check locations. A generic JSON replacer could leak
 * facts if a native descriptor were also referenced by unrelated model data. */
export function contractWithStoredReviewObservations(contract: Contract): Contract {
  return { ...contract, units: contract.units.map(unit => ({ ...unit, checks: unit.checks.map(check => check.reviewedFiles === undefined ? check
    : { ...check, reviewedFiles: check.reviewedFiles.map(serializeReference) }) })) };
}
function physicalFacts(value: unknown): CurrentFileReviewFacts {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'directories,file,origin,version'
    || (value['origin'] !== 'native-host-filesystem' && value['origin'] !== 'unverified-import')) throw invalid();
  return parseCurrentFileReviewFacts({ version: value['version'], directories: value['directories'], file: value['file'] });
}
/** Public parse/import retains data but cannot mint native provenance. Only a
 * receipt from an actual owned checkpoint read admits its earlier native facts. */
export function hydrateStoredReviewObservations(contract: Contract, schemaVersion: number, serialized: string,
  receipt?: OwnedContractCheckpointRead): void {
  const native = receipt !== undefined && ownedContractCheckpointText(receipt) === serialized;
  for (const unit of contract.units) for (const check of unit.checks) {
    if (check.reviewedFiles === undefined) continue;
    if (!Array.isArray(check.reviewedFiles)) throw invalid();
    const descriptors = check.reviewedFiles.map((source: unknown): ReviewedFileReference => {
      if (!record(source) || typeof source['path'] !== 'string' || !source['path']) throw invalid();
      const keys = Object.keys(source).sort().join(',');
      const historicalShape = schemaVersion < 6 ? keys === 'path,sha256'
        : keys === 'historicalReviewOrigin,path,sha256' && (source['historicalReviewOrigin'] === 'owned-historical-checkpoint' || source['historicalReviewOrigin'] === 'unverified-import');
      if (historicalShape && typeof source['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(source['sha256'])) {
        const descriptor = Object.freeze({ path: source['path'], sha256: source['sha256'] });
        if (native && (schemaVersion < 6 || source['historicalReviewOrigin'] === 'owned-historical-checkpoint')) historicalReviews.add(descriptor);
        return descriptor;
      }
      if (schemaVersion < 6 || Object.keys(source).sort().join(',') !== 'nativeFileObservation,observationId,path'
        || typeof source['observationId'] !== 'string' || !/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/.test(source['observationId'])) throw invalid();
      const facts = physicalFacts(source['nativeFileObservation']);
      const origin = (source['nativeFileObservation'] as Record<string, unknown>)['origin'];
      const descriptor = Object.freeze({ path: source['path'], observationId: source['observationId'] });
      reviews.set(descriptor, { facts, native: native && origin === 'native-host-filesystem', persistableNative: native && origin === 'native-host-filesystem' });
      return descriptor;
    });
    Object.defineProperty(check, 'reviewedFiles', { value: Object.freeze(descriptors), enumerable: true, configurable: true, writable: true });
  }
  if (receipt !== undefined && ownedContractCheckpointText(receipt) !== serialized) throw invalid();
}
/** Graceful disposal retains the exact immutable native descriptor objects in
 * its owned checkpoint copy. Copies themselves never inherit WeakMap proof. */
export function retainOriginalReviewDescriptors(original: Contract, copy: Contract): void {
  retainCurrentFileLabels(original, copy);
  for (const [unitIndex, unit] of original.units.entries()) {
    const target = copy.units[unitIndex]; if (!target || target.id !== unit.id) throw invalid();
    for (const [checkIndex, check] of unit.checks.entries()) {
      const cloned = target.checks[checkIndex]; if (!cloned || cloned.id !== check.id) throw invalid();
      if (check.reviewedFiles !== undefined) Object.defineProperty(cloned, 'reviewedFiles', {
        value: Object.freeze([...check.reviewedFiles]), enumerable: true, configurable: true, writable: true,
      });
    }
  }
}
