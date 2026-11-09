/** Control identities excluding entered field values. Parsing
 * storage data cannot create a browser snapshot or permission to use a control. */
import { captureOwnedJson } from '../gate/judgment-input.js';

export interface BrowserControlSnapshot {
  readonly version: 1;
  readonly snapshotId: string;
  readonly url: string;
  readonly controls: readonly {
    readonly ref: string;
    readonly role: string;
    readonly name: string;
    readonly tag: string;
    readonly selector: string;
    readonly depth: number;
    readonly submits: boolean;
    readonly frameChain: readonly string[];
    readonly disabled?: boolean;
    readonly cardField?: boolean;
    readonly metadata: {
      readonly name: string;
      readonly documentUrl: string;
      readonly control?: {
        readonly type: string;
        readonly autocomplete: string;
        readonly name: string;
        readonly id: string;
        readonly placeholder: string;
        readonly ariaLabel: string;
        readonly label: string;
      };
    };
  }[];
}
export class BrowserControlSnapshotError extends Error {
  override readonly name = 'BrowserControlSnapshotError';
  constructor() { super('The original browser control snapshot is unavailable.'); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function keys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => required.includes(key) || optional.includes(key));
}

/** Strict value-free projection: never accept form values, page text, titles
 * or arbitrary extra properties into retained control evidence. */
export function captureBrowserControlSnapshot(value: unknown): BrowserControlSnapshot {
  try {
    const row = captureOwnedJson(value);
    if (!object(row) || !keys(row, ['version', 'snapshotId', 'url', 'controls']) || row['version'] !== 1
      || !text(row['snapshotId']) || !text(row['url']) || !Array.isArray(row['controls'])
      || row['controls'].length === 0 || row['controls'].length > 4096) throw new BrowserControlSnapshotError();
    const refs = new Set<string>();
    for (const control of row['controls']) {
      if (!object(control) || !keys(control, ['ref', 'role', 'name', 'tag', 'selector', 'depth', 'submits', 'frameChain', 'metadata'], ['disabled', 'cardField'])
        || !text(control['ref']) || refs.has(control['ref']) || typeof control['role'] !== 'string' || typeof control['name'] !== 'string'
        || !text(control['tag']) || !text(control['selector']) || !Number.isSafeInteger(control['depth']) || Number(control['depth']) < 0
        || typeof control['submits'] !== 'boolean' || !Array.isArray(control['frameChain']) || control['frameChain'].length > 4096
        || control['frameChain'].some(part => !text(part)) || control['disabled'] !== undefined && typeof control['disabled'] !== 'boolean'
        || control['cardField'] !== undefined && typeof control['cardField'] !== 'boolean') throw new BrowserControlSnapshotError();
      refs.add(control['ref']);
      const metadata = control['metadata'];
      if (!object(metadata) || !keys(metadata, ['name', 'documentUrl'], ['control']) || typeof metadata['name'] !== 'string'
        || !text(metadata['documentUrl'])) throw new BrowserControlSnapshotError();
      const attributes = metadata['control'];
      const attributesKeys = ['type', 'autocomplete', 'name', 'id', 'placeholder', 'ariaLabel', 'label'];
      if (attributes !== undefined && (!object(attributes) || !keys(attributes, attributesKeys)
        || attributesKeys.some(key => typeof attributes[key] !== 'string'))) throw new BrowserControlSnapshotError();
    }
    return row as unknown as BrowserControlSnapshot;
  } catch { throw new BrowserControlSnapshotError(); }
}
