/** Closed schema classification, not a heuristic over credential spellings. */
import { isSecretBearingConfigKey } from '../config/secret-bearing-config-keys.js';
import { isSecretRefInput, normalizeSecretRef } from '../config/secret-refs.js';
import { replicatedSecretKeyFor } from './config-replication-policy.js';
export { isSecretBearingConfigKey };
export function canonicalReplicatedSecretRef(path: string): string { return `goodvibes://secrets/goodvibes/${encodeURIComponent(replicatedSecretKeyFor(path))}`; }
/** Only this machine-independent reference to the exact declared group key is
 * public credential metadata. Arbitrary file/exec/vault/environment references
 * can contain local paths, commands or embedded private provider parameters.
 */
export function publicCredentialPointer(path: string, value: unknown): boolean {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  try { const parsed = normalizeSecretRef(value); return parsed?.source === 'goodvibes' && parsed.id === replicatedSecretKeyFor(path); } catch { return false; }
}
export class ConfigReplicationPrivacyError extends Error {
  override readonly name = 'ConfigReplicationPrivacyError';
  constructor() { super('Credential replication requires the encrypted credential setting or its canonical GoodVibes secret reference.'); }
}
/** A literal is an actual supported local config source; resolve it only in the
 * current owned operation and seal it. No raw value is placed in a document.
 */
export function localCredentialLiteral(path: string, value: unknown): string | null {
  if (value === undefined || value === null || publicCredentialPointer(path, value)) return null;
  if (typeof value !== 'string' || !value || isSecretRefInput(value)) throw new ConfigReplicationPrivacyError();
  return value;
}
