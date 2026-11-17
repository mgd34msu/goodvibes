/**
 * schema-types-connectors.ts, the `calendar.*` / `google.*` connector
 * domains' types. The mailbox is configured under `surfaces.email.*`
 * (schema-domain-daemon-mailbox.ts).
 *
 * The shapes only: GoodVibesConfig (schema-types.ts) imports them as
 * `calendar` and `google`, and `ConfigKey` / `ConfigValue` are read off them.
 * The defaults, the descriptions and the editable settings rows are in
 * schema-domain-connectors.ts.
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
