/**
 * Settings writes the Agent's settings tool refuses outright. The owner makes these
 * changes in the settings screens; nothing the Agent reads or is told can authorize
 * them, so there is no confirmation path here.
 */
import { CREDENTIAL_DESTINATION_KEYS } from '../../config/credential-destination-keys.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isStructuredCredentialReferenceConfigKey } from '../../config/structured-credential-config.js';
import { SURFACE_EMAIL_PASSWORD_REF, SURFACE_EMAIL_SMTP_PASSWORD_REF } from '../../email/surface-config.js';
import type { SettingsToolArgs } from './settings-write-evidence.js';

/** The only references besides the key's own derived one that a key may point at. */
const SHARED_REFERENCES: Readonly<Record<string, string>> = {
  'email.passwordRef': SURFACE_EMAIL_PASSWORD_REF,
  'email.smtpPasswordRef': SURFACE_EMAIL_SMTP_PASSWORD_REF,
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
  const writing = args.mode === 'set' || args.mode === 'reset';
  if (writing && key.startsWith('payments.')) {
    return `Settings under payments.* (${key}) hold spending limits, retailer lists, cards and addresses, and only the owner changes them, in the settings screen. Nothing was changed. Read the value if you need it, and ask the owner to make the change.`;
  }
  if (args.mode !== 'set') return null;
  if (CREDENTIAL_DESTINATION_KEYS.has(key)) {
    return `${key} decides which host receives this service's stored credential, so only the owner changes it, in the settings screen. Nothing was changed. Tell the owner the value you were given and ask them to set it.`;
  }
  if (isSecretBearingConfigKey(key) && !isStructuredCredentialReferenceConfigKey(key) && typeof args.value === 'string' && args.value.trim() !== '') {
    const secretKey = referencedSecretKey(args.value);
    const own = daemonSecretKeyFor(key);
    const shared = SHARED_REFERENCES[key];
    const allowed = secretKey !== null && (secretKey === own || (shared !== undefined && referencedSecretKey(shared) === secretKey));
    if (!allowed) {
      return `${key} may only point at its own stored secret, ${SECRET_REF_PREFIX}${encodeURIComponent(own)}. Nothing was changed. Store the credential for this key first, then set that reference, or ask the owner to enter it in the settings screen.`;
    }
  }
  return null;
}
