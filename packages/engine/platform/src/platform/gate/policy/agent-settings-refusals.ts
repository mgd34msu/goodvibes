/**
 * Settings writes an agent's settings tool refuses outright, decided by code
 * from the key and the value: card material (entered only through the secure
 * card setup), a credential destination (which host receives a stored
 * credential), and a secret-bearing key given a literal or another key's
 * secret (which would send one service's credential to another). The settings
 * tool's input projector calls this once, before any effect is prepared.
 * Every other write, payments settings included, goes on to the normal
 * admission; one its key declares as loosening (a higher spending limit, the
 * per-purchase ceiling off, see config/config-key-facts.ts) is put to the owner
 * there, as an owner-only change (permissions/manager.ts `settingsWriteLoosens`).
 */
import { CREDENTIAL_DESTINATION_KEYS } from '../../config/credential-destination-keys.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isStructuredCredentialReferenceConfigKey } from '../../config/structured-credential-config.js';
import { configKeyFacts } from '../../config/config-key-facts.js';

/** The settings tool's argument shape. */
export type SettingsToolArgs = {
  readonly mode?: unknown;
  readonly key?: unknown;
  readonly [name: string]: unknown;
};

const SECRET_REF_PREFIX = 'goodvibes://secrets/goodvibes/';

function referencedSecretKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SECRET_REF_PREFIX)) return null;
  const tail = trimmed.slice(SECRET_REF_PREFIX.length);
  if (tail === '' || tail.includes('/')) return null;
  try { return decodeURIComponent(tail); } catch { return null; }
}

/** Why the Agent's settings tool may not apply this call, or null when it may go on to the normal checks. */
export function agentSettingsWriteRefusal(args: SettingsToolArgs): string | null {
  if (typeof args.key !== 'string') return null;
  const key = args.key.trim();
  if (args.mode !== 'set') return null;
  if (configKeyFacts(key).cardMaterial) {
    return `${key} holds payment card material, which is entered only through the local terminal or web UI secure card setup. Nothing was changed. Ask the owner to enter the card there and use the stored card id.`;
  }
  if (CREDENTIAL_DESTINATION_KEYS.has(key)) {
    return `${key} decides which host receives this service's stored credential, so only the owner changes it, in the settings screen. Nothing was changed. Tell the owner the value you were given and ask them to set it.`;
  }
  if (isSecretBearingConfigKey(key) && !isStructuredCredentialReferenceConfigKey(key) && args.value !== undefined && args.value !== null && args.value !== '') {
    const own = daemonSecretKeyFor(key);
    if (typeof args.value !== 'string') {
      return `${key} takes only a stored secret reference, ${SECRET_REF_PREFIX}${encodeURIComponent(own)}, never a literal value. Nothing was changed. Store the credential for this key first, then set that reference, or ask the owner to enter it in the settings screen.`;
    }
    if (args.value.trim() === '') return null;
    if (referencedSecretKey(args.value) !== own) {
      return `${key} may only point at its own stored secret, ${SECRET_REF_PREFIX}${encodeURIComponent(own)}. Nothing was changed. Store the credential for this key first, then set that reference, or ask the owner to enter it in the settings screen.`;
    }
  }
  return null;
}
