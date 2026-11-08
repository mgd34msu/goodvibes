/** Serialized recovery facts. Neither parsing nor possession authorizes act. */
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureBrowserPageConnection, type BrowserPageConnection } from './browser-page-connection-data.js';
import { captureBrowserControlSnapshot, BrowserControlSnapshotError, type BrowserControlSnapshot } from './browser-control-snapshot-data.js';

export interface BrowserCheckoutRecovery {
  readonly connection: BrowserPageConnection;
  readonly controls: BrowserControlSnapshot;
}
export function captureBrowserCheckoutRecovery(value: unknown): BrowserCheckoutRecovery {
  const row = captureOwnedJson(value);
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2
    || !('connection' in row) || !('controls' in row)) throw new BrowserControlSnapshotError();
  return Object.freeze({ connection: captureBrowserPageConnection(row.connection), controls: captureBrowserControlSnapshot(row.controls) });
}
