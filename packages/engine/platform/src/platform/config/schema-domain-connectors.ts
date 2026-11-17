/**
 * schema-domain-connectors.ts, the calendar connector's and Google setup's
 * config (`calendar.*`, `google.*`).
 *
 * These are real, schema-registered, described settings: daemon-owned
 * (config-ownership.ts), rendered in the settings modal, and in the walk that
 * `listDaemonOwnedConfigPaths()` derives credential names from.
 *
 * The mailbox is not here. It has one set of keys, `surfaces.email.*`
 * (schema-domain-daemon-mailbox.ts), read by every product and by the daemon.
 *
 * Secret-bearing rows (`calendar.google.clientSecretRef`,
 * `calendar.microsoft.clientSecretRef`, `calendar.google.icsUrl`) are declared
 * in `secret-bearing-config-keys.ts`, which routes a write into the encrypted
 * secret store and masks a render. The value held here is a reference into
 * the secret store; the secret itself is never held in config.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';
import type {
  CalendarConnectorConfig,
  GoogleConnectorConfig,
} from './schema-types-connectors.js';

export type {
  CalendarConnectorConfig,
  CalendarConnectorProviderConfig,
  GoogleConnectorConfig,
} from './schema-types-connectors.js';


/** Defaults for the connector's `calendar` section: one entry per OAuth calendar provider. */
const CALENDAR_CONNECTOR_DEFAULTS: CalendarConnectorConfig = {
  google: { clientId: '', clientSecretRef: '', icsUrl: '' },
  microsoft: { clientId: '', clientSecretRef: '' },
};

/** Defaults for the connector's `google` section: the Cloud project and the OAuth app's state. */
const GOOGLE_CONNECTOR_DEFAULTS: GoogleConnectorConfig = {
  oauth: { projectId: '', publishingStatus: '' },
  credentials: { migratedFrom: '' },
};

export const connectorConfigDefaults: {
  calendar: CalendarConnectorConfig;
  google: GoogleConnectorConfig;
} = {
  calendar: CALENDAR_CONNECTOR_DEFAULTS,
  google: GOOGLE_CONNECTOR_DEFAULTS,
};

export const connectorConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'calendar.google.clientId',
    type: 'string',
    default: '',
    description: 'The OAuth client id for a Google Calendar app registered by whoever set up this environment. Client ids are not secrets (RFC 8252) and are stored in plain config.',
  },
  {
    key: 'calendar.google.clientSecretRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the Google OAuth client secret, needed only for a confidential (Web-app) client registration, a Desktop-app client using PKCE needs none. Any non-empty value marks the secret as stored; it is always read from the name derived from this setting\'s key, not from where the reference text points. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'calendar.google.icsUrl',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the private calendar feed address (the "secret address in iCal format" from Google Calendar\'s Integrate Calendar settings). It is a URL rather than a password, but it grants read access to the operator\'s calendar to anyone holding it, so it is treated as a credential: the address itself is stored in the daemon secret tier, never in config. This is the read-only, credential-free route used when an app password is the mail connection, Google refuses Basic authentication on its CalDAV endpoint, so an app password cannot reach Calendar that way. Calendar writes require the OAuth path (calendar.google.clientId and the refresh token below).',
  },
  {
    key: 'calendar.microsoft.clientId',
    type: 'string',
    default: '',
    description: 'The OAuth client id for a Microsoft Entra app registration, for connecting an Outlook calendar. Client ids are not secrets and are stored in plain config.',
  },
  {
    key: 'calendar.microsoft.clientSecretRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the Microsoft OAuth client secret, needed only for a confidential registration, a public client with "Allow public client flows" enabled needs none. Any non-empty value marks the secret as stored; it is always read from the name derived from this setting\'s key, not from where the reference text points. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'google.oauth.projectId',
    type: 'string',
    default: '',
    description: 'The Google Cloud project id the OAuth calendar client and its enabled APIs belong to, recorded so a re-run reuses the same project instead of creating another one.',
  },
  {
    key: 'google.oauth.publishingStatus',
    type: 'string',
    default: '',
    description:
      'The OAuth consent screen\'s last-known publishing status ("testing" or "in-production"), cached after being read from the Cloud Console since it cannot be probed any other way. An app left in "Testing" is issued refresh tokens that expire after seven days; moving it to "In production" (self-certified, no Google review needed) removes that expiry. Empty until a setup or verification run has read it.',
  },
  {
    key: 'google.credentials.migratedFrom',
    type: 'string',
    default: '',
    description:
      'Marker recording that a legacy on-disk Google credential (from before credentials lived in the encrypted secret store) was already migrated in, so migration is not repeated on every start. Names where it came from; holds no credential value itself.',
  },
];

