/**
 * schema-types-connectors.ts, the `calendar.*` / `google.*` connector
 * domains' types. The mailbox is configured under `surfaces.email.*`
 * (schema-domain-daemon-mailbox.ts).
 *
 * Split out the same way schema-types-owner-profile.ts and
 * schema-types-occasions.ts were: the shape, the key union and the key->value
 * map live beside each other here, and schema-types.ts folds them into
 * `ConfigKey` and `ConfigValue` with one arm each (`| ConnectorsConfigKey`,
 * `K extends ConnectorsConfigKey ? ConnectorsConfigValue<K> :`).
 *
 * Types only. The defaults, the descriptions and the editable settings rows
 * are in schema-domain-connectors.ts, which is also where the `declare
 * module` merge into `GoodVibesConfig` lives, co-located with the defaults,
 * as every other domain does it.
 */

/** One OAuth calendar provider's registered app (`calendar.<provider>.*`). */
export interface CalendarConnectorProviderConfig {
  clientId: string;
  clientSecretRef: string;
}

/** The `calendar` connector section: one entry per OAuth calendar provider. */
export interface CalendarConnectorConfig {
  google: CalendarConnectorProviderConfig & { icsUrl: string };
  microsoft: CalendarConnectorProviderConfig;
}

/** The `google` connector section: the Cloud project and the OAuth app's state. */
export interface GoogleConnectorConfig {
  oauth: {
    projectId: string;
    publishingStatus: string;
  };
  credentials: {
    migratedFrom: string;
  };
}

/** Dot-path keys for the `calendar.*` / `google.*` connector domains. */
export type ConnectorsConfigKey =
  | 'calendar.google.clientId'
  | 'calendar.google.clientSecretRef'
  | 'calendar.google.icsUrl'
  | 'calendar.microsoft.clientId'
  | 'calendar.microsoft.clientSecretRef'
  | 'google.oauth.projectId'
  | 'google.oauth.publishingStatus'
  | 'google.credentials.migratedFrom';

/**
 * Maps a connector key to its value type.
 *
 * Every key is written out, terminating in `never`, rather than collapsing
 * the repeated strings into a default arm, the completeness gate
 * (test/config-key-union-completeness.test.ts) reads these clauses out of
 * the source to prove no schema key is missing a typed accessor, and a
 * default arm would make most of them invisible to it.
 */
export type ConnectorsConfigValue<K extends ConnectorsConfigKey> =
  K extends 'calendar.google.clientId' ? string :
  K extends 'calendar.google.clientSecretRef' ? string :
  K extends 'calendar.google.icsUrl' ? string :
  K extends 'calendar.microsoft.clientId' ? string :
  K extends 'calendar.microsoft.clientSecretRef' ? string :
  K extends 'google.oauth.projectId' ? string :
  K extends 'google.oauth.publishingStatus' ? string :
  K extends 'google.credentials.migratedFrom' ? string :
  never;
