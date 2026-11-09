/** Only an actual retained native file read issues a checkpoint read receipt.
 * Parsing a public JSON payload cannot create one. No text-keyed global cache. */
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';

declare const ownedRead: unique symbol;
export interface OwnedContractCheckpointRead { readonly [ownedRead]: true }
interface Read { readonly text: string; readonly assertCurrent: () => void }
const reads = new WeakMap<OwnedContractCheckpointRead, Read>();
function ancestors(path: string): readonly string[] {
  const result: string[] = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = lstatSync(parent, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Contract checkpoint directory owner is unavailable');
    result.push([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':'));
    if (dirname(parent) === parent) return result;
  }
}
function checkpointAssertion(path: string, parents: readonly string[], physical: string): () => void {
  return () => {
    const current = ancestors(path);
    if (current.length !== parents.length || current.some((value, index) => value !== parents[index])
      || fileObservationIdentity(path) !== physical) throw new Error('Contract checkpoint changed during its owned read');
  };
}
export function readOwnedContractCheckpoint(path: string, format: 'contract' | 'durable-admission'): OwnedContractCheckpointRead {
  if (format !== 'contract' && format !== 'durable-admission') throw new Error('Contract checkpoint read format is unavailable');
  path = resolve(path);
  const parents = ancestors(path), source = readFileObservation(path);
  const stat = lstatSync(path);
  if (process.geteuid && stat.uid !== process.geteuid()) throw new Error('Contract checkpoint has a foreign owner');
  const assertCurrent = checkpointAssertion(path, parents, source.physical);
  assertCurrent();
  const original = source.bytes.toString('utf8');
  if (!Buffer.from(original, 'utf8').equals(source.bytes)) throw new Error('Contract checkpoint is not valid UTF-8');
  let text = original;
  if (format === 'durable-admission') {
    const envelope: unknown = JSON.parse(original);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || !('checkpoint' in envelope) || typeof envelope.checkpoint !== 'string') throw new Error('Durable contract checkpoint is unavailable');
    text = envelope.checkpoint;
  }
  assertCurrent();
  const receipt = Object.freeze({}) as OwnedContractCheckpointRead;
  // Retain text only until this read receipt is released; no source bytes or
  // physical facts are attached to the public receipt object.
  reads.set(receipt, { text, assertCurrent }); return receipt;
}
export function ownedContractCheckpointText(receipt: OwnedContractCheckpointRead): string {
  const found = reads.get(receipt);
  if (!found) throw new Error('Contract checkpoint read receipt is unavailable');
  found.assertCurrent(); return found.text;
}
