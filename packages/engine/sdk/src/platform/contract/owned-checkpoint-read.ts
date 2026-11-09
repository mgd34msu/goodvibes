/** Only an actual retained native file read issues a checkpoint read receipt.
 * Parsing a public JSON payload cannot create one. No text-keyed global cache. */
import { captureQuarantineSource, readCapturedQuarantineSource, type QuarantineSource } from '../utils/atomic-json-store.js';

declare const ownedRead: unique symbol;
export interface OwnedContractCheckpointRead { readonly [ownedRead]: true }
interface Read { readonly text: string; readonly assertCurrent: () => void }
const reads = new WeakMap<OwnedContractCheckpointRead, Read>();
const nativeGet = WeakMap.prototype.get, nativeSet = WeakMap.prototype.set, nativeApply = Reflect.apply;
/** A borrowed source must be the actual native original captured for this path.
 * Its caller owns close; otherwise this function closes after the synchronous
 * read. The retained currentness assertion needs no open descriptor. */
export function readOwnedContractCheckpoint(path: string, format: 'contract' | 'durable-admission', borrowed?: QuarantineSource): OwnedContractCheckpointRead {
  if (format !== 'contract' && format !== 'durable-admission') throw new Error('Contract checkpoint read format is unavailable');
  const source = borrowed ?? captureQuarantineSource(path);
  if (!source) throw new Error('Contract checkpoint is unavailable');
  try {
    const original = readCapturedQuarantineSource(path, source);
    let text = original;
    if (format === 'durable-admission') {
      const envelope: unknown = JSON.parse(original);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || !('checkpoint' in envelope) || typeof envelope.checkpoint !== 'string') throw new Error('Durable contract checkpoint is unavailable');
      text = envelope.checkpoint;
    }
    source.assertCurrent();
    const receipt = Object.freeze({}) as OwnedContractCheckpointRead;
    nativeApply(nativeSet, reads, [receipt, { text, assertCurrent: source.assertCurrent }]);
    return receipt;
  } finally { if (!borrowed) source.close(); }
}
export function ownedContractCheckpointText(receipt: OwnedContractCheckpointRead): string {
  const found = nativeApply(nativeGet, reads, [receipt]) as Read | undefined;
  if (!found) throw new Error('Contract checkpoint read receipt is unavailable');
  found.assertCurrent(); return found.text;
}
