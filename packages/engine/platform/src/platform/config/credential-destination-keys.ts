/**
 * Settings that name where a stored credential is sent, and the settings that
 * name that credential. Changing a destination while its credential stays
 * configured would send the credential to the new host, so the config owner
 * (ConfigManager set, setMany, reset and prepared changes) refuses such a
 * change with `CREDENTIAL_DESTINATION_UNBOUND` unless the same update states
 * the credential too: keep it for the new destination (send its key with its
 * value) or clear it. The Agent's settings tool refuses these keys outright
 * (gate/policy/agent-settings-refusals.ts): only the owner moves a credential.
 *
 * `judgment.fallbacks` is a destination whose credential lives inside each
 * target (`keySource`/`keyName` beside `endpoint`), so every write of the chain
 * states each target's credential with its endpoint; it has no separate key.
 */
import { refusal, type Refusal } from '@goodvibes/engine/errors';

export interface CredentialDestination {
  /** The settings that name the credential sent to this destination; any one in the same update states it. */
  readonly credentialKeys: readonly string[];
  /** Whether that credential is configured, from a reader of the current settings. */
  readonly configured: (get: (key: string) => unknown) => boolean;
}

const nonEmpty = (key: string) => (get: (key: string) => unknown): boolean => {
  const value = get(key);
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
};

function surface(credentialKey: string): CredentialDestination {
  return { credentialKeys: [credentialKey], configured: nonEmpty(credentialKey) };
}

/** A setting that names where a stored credential is sent, and the settings that name that credential. */
export const CREDENTIAL_DESTINATIONS: Readonly<Record<string, CredentialDestination>> = Object.freeze({
  'judgment.endpoint': {
    credentialKeys: ['judgment.keySource', 'judgment.keyName'],
    configured: (get) => get('judgment.keySource') !== 'none',
  },
  'judgment.fallbacks': { credentialKeys: [], configured: () => false },
  'surfaces.calendar.caldavUrl': surface('surfaces.calendar.caldavPassword'),
  'surfaces.ntfy.baseUrl': surface('surfaces.ntfy.token'),
  'surfaces.homeassistant.instanceUrl': surface('surfaces.homeassistant.accessToken'),
  'surfaces.signal.bridgeUrl': surface('surfaces.signal.token'),
  'surfaces.whatsapp.bridgeUrl': surface('surfaces.whatsapp.accessToken'),
  'surfaces.telephony.bridgeUrl': surface('surfaces.telephony.token'),
  'surfaces.imessage.bridgeUrl': surface('surfaces.imessage.token'),
  'surfaces.bluebubbles.serverUrl': surface('surfaces.bluebubbles.password'),
  'surfaces.mattermost.baseUrl': surface('surfaces.mattermost.botToken'),
  'surfaces.matrix.homeserverUrl': surface('surfaces.matrix.accessToken'),
});

/** Whether `key` names where a stored credential is sent. */
export function isCredentialDestinationKey(key: string): boolean {
  return Object.hasOwn(CREDENTIAL_DESTINATIONS, key);
}

/** Every destination key, for lists of settings with that fact. */
export const CREDENTIAL_DESTINATION_KEYS: readonly string[] = Object.freeze(Object.keys(CREDENTIAL_DESTINATIONS));

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The refusal for an update (`changes`, each key with the value it will hold
 * afterwards) that moves a destination while its configured credential is not
 * stated in the same update, or null. `get` reads the settings as they are now.
 */
export function unboundCredentialDestinationRefusal(
  changes: readonly { readonly key: string; readonly value: unknown }[],
  get: (key: string) => unknown,
): Refusal | null {
  const keys = new Set(changes.map(change => change.key));
  for (const change of changes) {
    const destination = CREDENTIAL_DESTINATIONS[change.key];
    if (!destination || destination.credentialKeys.length === 0) continue;
    if (same(get(change.key), change.value)) continue;
    if (!destination.configured(get)) continue;
    if (destination.credentialKeys.some(key => keys.has(key))) continue;
    const credential = destination.credentialKeys.join(' and ');
    return refusal({
      code: 'CREDENTIAL_DESTINATION_UNBOUND',
      state: 'nothing was saved',
      reason: `${change.key} decides where the credential in ${credential} is sent, and changing it alone would send that credential to the new destination`,
      next: [
        `Change ${change.key} together with ${credential} in one update (config.setMany, or the settings screen): send ${credential} with its current value to keep the credential for the new destination, or clear it`,
        `Or clear ${credential} first, then change ${change.key}`,
      ],
      retryable: false,
      status: 409,
    });
  }
  return null;
}
