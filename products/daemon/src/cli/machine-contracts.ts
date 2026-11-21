/**
 * Versioned CLI output identity. These are producer facts, not prose readings.
 *
 * One layout for every `--json` document this program prints: indented by two
 * spaces with one key (and one array item) per line, `JSON.stringify(value,
 * null, 2)`. That covers the {ok:true, data} and {ok:false, code, error, fix}
 * envelopes and the schema-bearing documents a shell reads by line
 * (`service-status --json`, `webui enable --json`, both read by
 * scripts/install.sh). The declared exception is the single-line documents
 * read only by a JSON parser: `webui status --json`, `--help --json` and
 * `check-install-reader`.
 */
export const WEBUI_BINDING_RESULT = {
  schema: 'goodvibes.daemon.webui-binding',
  schemaVersion: 1,
  source: 'configuration',
  endpoint: 'web',
} as const;

/** The exact invocation that emits WEBUI_BINDING_RESULT without changing settings. */
export const WEBUI_BINDING_QUERY = {
  args: ['status', '--json'],
  result: WEBUI_BINDING_RESULT,
} as const;

/**
 * `webui enable --json`: the receipt of the settings it wrote, with `url`
 * (the origin that serves the bundle), `alternateUrl` when that origin uses a
 * name, and `lines` (the prose receipt). Read by scripts/install.sh.
 */
export const WEBUI_ENABLE_RESULT = {
  schema: 'goodvibes.daemon.webui-enable',
  schemaVersion: 1,
  source: 'configuration',
  endpoint: 'web',
} as const;

/**
 * `service-status --json`: the service's platform, name, path, owner and
 * state under `data`. Read line by line by scripts/install.sh
 * (read_daemon_service), which checks this schema and version first.
 */
export const SERVICE_STATUS_RESULT = {
  schema: 'goodvibes.daemon.service-status',
  schemaVersion: 1,
  source: 'service-manager',
  endpoint: 'service',
} as const;

/** The exact invocation that emits SERVICE_STATUS_RESULT without changing anything. */
export const SERVICE_STATUS_QUERY = {
  args: ['--json'],
  result: SERVICE_STATUS_RESULT,
} as const;
