import { type ConfigSettingDefinition, intRange, numRange, port } from './schema-shared.js';

/**
 * Per-project worktree cold-start setup (resolveEffectiveWorktreeSetup). Each
 * field is a list used as given, `{ mode: 'none' }` for nothing, or an empty
 * list (or `{ mode: 'auto' }`) to derive it from the repository. Read whole
 * (`get('worktree.setup.commands')`). GoodVibesConfig (schema-types.ts) imports
 * this interface as `worktree`.
 */
export type WorktreeSetupListValue = string[] | { mode: 'auto' | 'none' };
export interface WorktreeConfig {
  setup: { commands: WorktreeSetupListValue; carryOverGlobs: WorktreeSetupListValue };
}

/**
 * The proactive check-in section, imported into GoodVibesConfig
 * (schema-types.ts) as `checkin`.
 */
export interface CheckinConfig {
  enabled: boolean;
  cadence: string;
  deliveryChannel: string;
  quietHours: string;
}

export const runtimeConfigDefaults = {
  runtime: {
    companionChat: {
      closedRetentionDays: 0,
    },
    companionChatLimiter: {
      perSessionLimit: 0,
    },
    eventBus: {
      maxListeners: 100,
    },
    maxParallelToolCalls: 8,
    unifiedTasks: true,
    pluginLifecycle: true,
    mcpLifecycle: true,
    toolBudget: {
      enforced: false,
      maxMs: 0,
      maxTokens: 0,
      maxCostUsd: 0,
    },
  },
  batch: {
    mode: 'off',
    fallback: 'live',
    queueBackend: 'local',
    tickIntervalMs: 60_000,
    maxDelayMs: 5 * 60 * 1000,
    maxJobsPerProviderBatch: 100,
    maxQueuePayloadBytes: 16 * 1024,
    maxQueueMessagesPerDay: 1_000,
  },
  cloudflare: {
    enabled: false,
    freeTierMode: true,
    accountId: '',
    aiGatewayId: '',
    apiTokenRef: '',
    zoneId: '',
    zoneName: '',
    workerName: 'goodvibes-batch-worker',
    workerSubdomain: '',
    workerHostname: '',
    workerBaseUrl: '',
    daemonBaseUrl: '',
    daemonHostname: '',
    workerTokenRef: '',
    workerClientTokenRef: '',
    workerCron: '*/5 * * * *',
    queueName: 'goodvibes-batch',
    deadLetterQueueName: 'goodvibes-batch-dlq',
    tunnelName: 'goodvibes-daemon',
    tunnelId: '',
    tunnelTokenRef: '',
    accessAppId: '',
    accessServiceTokenId: '',
    accessServiceTokenRef: '',
    kvNamespaceName: 'goodvibes-runtime',
    kvNamespaceId: '',
    durableObjectNamespaceName: 'GoodVibesCoordinator',
    durableObjectNamespaceId: '',
    r2BucketName: 'goodvibes-artifacts',
    secretsStoreName: 'goodvibes',
    secretsStoreId: '',
    maxQueueOpsPerDay: 10_000,
  },
  telemetry: {
    includeRawPrompts: false,
    decisionOtlpEnabled: false,
    decisionOtlpEndpoint: '',
    decisionOtlpSignal: 'span',
    otelMode: 'off',
  },
  automation: {
    enabled: true,
    maxConcurrentRuns: 4,
    runHistoryLimit: 100,
    defaultTimeoutMs: 2 * 60 * 60 * 1000,
    catchUpWindowMinutes: 30,
    failureCooldownMs: 5 * 60 * 1000,
    deleteAfterRun: false,
  },
  checkin: {
    enabled: false,
    cadence: '0 */4 * * *',
    deliveryChannel: '',
    quietHours: '',
  },
  controlPlane: {
    enabled: false,
    gateway: true,
    hostMode: 'local',
    host: '127.0.0.1',
    port: 3421,
    publicBaseUrl: '',
    streamMode: 'sse',
    trustProxy: false,
    openaiCompatible: {
      enabled: true,
      pathPrefix: '/v1',
    },
    webui: {
      serve: false,
      bundleDir: '',
    },
    cors: {
      enabled: false,
      allowedOrigins: '',
    },
    tls: {
      mode: 'off',
      certFile: '',
      keyFile: '',
    },
  },
  httpListener: {
    hostMode: 'local',
    host: '127.0.0.1',
    port: 3422,
    trustProxy: false,
    trustCloudflare: false,
    tls: {
      mode: 'off',
      certFile: '',
      keyFile: '',
    },
  },
  web: {
    enabled: true,
    hostMode: 'local',
    host: '127.0.0.1',
    port: 3423,
    publicBaseUrl: '',
    staticAssetsDir: 'dist/web',
  },
  watchers: {
    enabled: true,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 15_000,
    recoveryWindowMinutes: 10,
    ciPollIntervalMs: 60_000,
  },
  service: {
    enabled: true,
    autostart: false,
    restartOnFailure: true,
    platform: 'auto',
    serviceName: '',
    logPath: '',
  },
  network: {
    outboundTls: {
      mode: 'bundled',
      customCaFile: '',
      customCaDir: '',
      allowInsecureLocalhost: false,
    },
    remoteFetch: {
      allowPrivateHosts: false,
    },
    privateDeliveryHosts: '',
  },
  relay: {
    enabled: true,
    url: '',
    rendezvousId: '',
    label: '',
    requireStepUpForMutations: false,
  },
  worktree: {
    setup: {
      commands: [] as string[],
      carryOverGlobs: [] as string[],
    },
  },
};

export const runtimePrimaryConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'automation.enabled',
    label: 'Run scheduled routines',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'Enable the automation subsystem (durable routines, schedule evaluation, run history). Default on: with no routines defined it idles and surfaces a how-to-create-your-first-routine empty state.',
  },
  {
    key: 'automation.maxConcurrentRuns',
    label: 'Routines that may run at once',
    type: 'number',
    description: 'Maximum automation runs that may execute concurrently',
    ...intRange(1, 64),
  },
  {
    key: 'automation.runHistoryLimit',
    label: 'Past runs kept for each routine',
    type: 'number',
    description: 'Maximum run history entries retained per automation job',
    ...intRange(1, 5000),
  },
  {
    key: 'automation.defaultTimeoutMs',
    label: 'Longest a routine may run (ms)',
    type: 'number',
    description: 'How long an automation run without its own timeout may run, in milliseconds (default two hours); a run past it is stopped and recorded as failed. Applies to running runs at once. 0 removes the deadline',
    ...intRange(0, 2_147_483_647),
  },
  {
    key: 'automation.catchUpWindowMinutes',
    label: 'Catch up on routines missed this recently (minutes)',
    type: 'number',
    description: 'How long after startup the engine should catch up missed runs. The same window (at least 5 minutes) is also how long a running run whose agent has vanished is left before it is failed as "Agent state lost", so a large value keeps such a run holding a concurrency slot for as long.',
    ...intRange(0, 24 * 60),
  },
  {
    key: 'automation.failureCooldownMs',
    label: 'Wait before retrying a failed routine (ms)',
    type: 'number',
    description: 'Cooldown applied after a failed automation run before retrying',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'automation.deleteAfterRun',
    label: 'Delete a one-time routine after it runs',
    type: 'boolean',
    description: 'Default for the deleteAfterRun flag of newly created one-shot (at) automation jobs: a job with the flag is deleted after its first successful run. Recurring jobs are never deleted by this default. Existing jobs keep the value they were created with.',
  },
  {
    key: 'checkin.enabled',
    label: 'Check in with you on a schedule',
    type: 'boolean',
    description: 'Enable the proactive check-in: on a cadence, a briefing is judged and the user is contacted only when something warrants it',
  },
  {
    key: 'checkin.cadence',
    label: 'How often to check in',
    type: 'string',
    description: 'Proactive check-in cadence as a cron expression (default: every 4 hours)',
  },
  {
    key: 'checkin.deliveryChannel',
    label: 'Where check-ins are sent',
    type: 'string',
    description: 'Where a proactive check-in message is delivered: "surfaceKind" or "surfaceKind:address" (e.g. "slack:C123"). Empty falls back to the owner profile field contactMe.channel.',
  },
  {
    key: 'checkin.quietHours',
    label: 'Hours when check-ins stay quiet',
    type: 'string',
    description: 'Proactive check-in quiet hours as "HH:MM-HH:MM" local time; no message is sent during this window. Empty falls back to the owner profile field contactMe.quietHours, and disables quiet hours only when the profile has none.',
  },
  {
    key: 'controlPlane.enabled',
    label: 'Let other machines reach this daemon',
    type: 'boolean',
    description: 'Whether the control plane is served to other machines. Off (default): the daemon listener answers only requests from this machine (loopback or one of its own addresses), whatever controlPlane.hostMode binds, and refuses any other address with CONTROL_PLANE_LOCAL_ONLY naming this setting. On: every address the binding reaches is served (paired devices, the web UI from another device, a reverse proxy). Channel webhooks under /webhook/ are answered either way; each surface\'s own switch decides them. Takes effect on the next request; the outbound relay has its own switch (relay.enabled). goodvibes-daemon webui enable --lan turns it on with the network binding.',
  },
  {
    key: 'controlPlane.gateway',
    label: 'Serve live updates and remote control',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'The shared gateway/control-plane host serving state snapshots, live streams (SSE/WS), and authenticated control APIs to terminal hosts and remote clients. Default on so a stock daemon can stream companion chat; every streaming endpoint stays auth-gated and the default bind stays loopback. Turn off for a request/response-only daemon.',
  },
  {
    key: 'controlPlane.hostMode',
    label: 'Who the daemon listens to',
    type: 'enum',
    description: 'Network binding mode for the control-plane listener: local (127.0.0.1, default port), network (0.0.0.0, default port), custom (the host and port below). This and host decide what the listener binds; whether another machine is then served is controlPlane.enabled.',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'controlPlane.host',
    label: 'Address the daemon listens on',
    type: 'string',
    description: 'Bind host for the control-plane HTTP server, used when controlPlane.hostMode is custom',
  },
  {
    key: 'controlPlane.port',
    label: 'Port the daemon listens on',
    type: 'number',
    description: 'Bind port for the control-plane HTTP server',
    ...port(),
  },
  {
    key: 'controlPlane.publicBaseUrl',
    label: "The daemon's outside address",
    type: 'string',
    description:
      'Override for a genuinely external control-plane address (tunnel or reverse proxy). '
      + 'Leave empty, the everyday base URL is derived from hostMode/host/port/tls.mode, '
      + 'so it cannot drift. Set this only when an off-box address differs from the bind.',
  },
  {
    key: 'controlPlane.streamMode',
    label: 'Kind of live update stream',
    type: 'enum',
    description: 'Which live update stream the daemon listener serves: sse serves GET /api/control-plane/events only, websocket serves the /api/control-plane/ws upgrade only, both serves both. The other one is refused with STREAM_MODE_NOT_SERVED naming this setting. The terminal apps and the web UI read the Server-Sent Events stream, so websocket alone leaves them without live updates. Takes effect on the next request.',
    enumValues: ['sse', 'websocket', 'both'],
  },
  {
    key: 'controlPlane.trustProxy',
    label: "Trust a proxy's client addresses",
    type: 'boolean',
    description: 'Trust proxy forwarding headers such as x-forwarded-for for the control plane',
  },
  {
    key: 'controlPlane.openaiCompatible.enabled',
    label: 'Offer an OpenAI-compatible API',
    type: 'boolean',
    description: 'Expose OpenAI-compatible /v1/models and /v1/chat/completions routes on the authenticated daemon',
  },
  {
    key: 'controlPlane.openaiCompatible.pathPrefix',
    label: 'Path of the OpenAI-compatible API',
    type: 'string',
    description: 'Path prefix for the daemon OpenAI-compatible routes',
    validate: (v) => typeof v === 'string' && /^(\/[A-Za-z0-9._~-]+)+$/.test(v) && !v.includes('..'),
    validationHint: 'a path such as /v1: segments of letters, digits, . _ ~ -, with no trailing slash and not just /',
  },
  {
    key: 'controlPlane.webui.serve',
    label: 'Serve the web UI from the daemon',
    type: 'boolean',
    description: 'Serve a built web UI bundle same-origin from the daemon (opt-in; loopback default unchanged). The bundle is public and the app token-authenticates its own API calls.',
  },
  {
    key: 'controlPlane.webui.bundleDir',
    label: 'Folder of the web UI the daemon serves',
    type: 'string',
    description: 'Directory holding the built web UI bundle (index.html + assets) served when controlPlane.webui.serve is true. Takes precedence over web.staticAssetsDir: this key is the specific answer for this daemon, so when it names a directory that is the one served. Empty falls back to web.staticAssetsDir.',
  },
  {
    key: 'controlPlane.cors.enabled',
    label: 'Let listed websites call the daemon',
    type: 'boolean',
    description: 'Answer OPTIONS preflight and emit Access-Control-Allow-* headers for allowlisted origins (opt-in; off by default). Never wildcards; credentials are allowlist-gated.',
  },
  {
    key: 'controlPlane.cors.allowedOrigins',
    label: 'Websites allowed to call the daemon',
    type: 'string',
    description: 'Comma-separated explicit allowlist of browser origins permitted to make cross-origin requests when controlPlane.cors.enabled is true (e.g. http://localhost:5173). Empty refuses every cross-origin request. The WebSocket upgrade origin check reads this list on its own, whether or not controlPlane.cors.enabled is true.',
  },
  {
    key: 'controlPlane.tls.mode',
    label: "Encryption for the daemon's connections",
    type: 'enum',
    description: 'TLS mode for the control-plane HTTP server',
    enumValues: ['off', 'proxy', 'direct'],
  },
  {
    key: 'controlPlane.tls.certFile',
    label: 'Certificate file for the daemon',
    type: 'string',
    description: 'Certificate chain PEM path for direct control-plane TLS (empty = certs/fullchain.pem under this surface\'s settings directory, e.g. ~/.goodvibes/tui/certs/fullchain.pem for the terminal app and the daemon)',
  },
  {
    key: 'controlPlane.tls.keyFile',
    label: 'Private key file for the daemon',
    type: 'string',
    description: 'Filesystem pathname of the PEM file used for direct control-plane TLS. This setting stores a path, not the private key contents. Empty uses certs/privkey.pem under this surface\'s settings directory (e.g. ~/.goodvibes/tui/certs/privkey.pem for the terminal app and the daemon).',
  },
  {
    key: 'httpListener.hostMode',
    label: 'Who the webhook receiver listens to',
    type: 'enum',
    description: 'Network binding mode: local (127.0.0.1, default port), network (0.0.0.0, default port), custom (editable host and port)',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'httpListener.host',
    label: 'Address the webhook receiver listens on',
    type: 'string',
    description: 'Bind host for the webhook HTTP listener',
  },
  {
    key: 'httpListener.port',
    label: 'Port the webhook receiver listens on',
    type: 'number',
    description: 'Bind port for the webhook HTTP listener',
    ...port(),
  },
  {
    key: 'httpListener.trustProxy',
    label: "Trust a proxy's client addresses for webhooks",
    type: 'boolean',
    description: 'Trust proxy forwarding headers such as x-forwarded-for for the webhook listener',
  },
  {
    key: 'httpListener.trustCloudflare',
    label: "Trust Cloudflare's client addresses for webhooks",
    type: 'boolean',
    description: 'Read the real client IP from CF-Connecting-IP, and only when the connecting peer is inside a published Cloudflare range. Requires httpListener.trustProxy: with it off, CF-Connecting-IP is ignored no matter what this says. The range check is the point, without it any peer could send a CF-Connecting-IP header and choose which address the rate limiter and the audit log recorded. Leave off unless this listener genuinely sits behind Cloudflare.',
  },
  {
    key: 'httpListener.tls.mode',
    label: 'Encryption for webhooks',
    type: 'enum',
    description: 'TLS mode for the webhook HTTP listener',
    enumValues: ['off', 'proxy', 'direct'],
  },
  {
    key: 'httpListener.tls.certFile',
    label: 'Certificate file for webhooks',
    type: 'string',
    description: 'Certificate chain PEM path for direct webhook-listener TLS (empty = certs/fullchain.pem under this surface\'s settings directory)',
  },
  {
    key: 'httpListener.tls.keyFile',
    label: 'Private key file for webhooks',
    type: 'string',
    description: 'Private key PEM path for direct webhook-listener TLS (empty = certs/privkey.pem under this surface\'s settings directory)',
  },
  {
    key: 'web.enabled',
    label: 'Mark the web UI as switched on',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'Declare the browser-based operator surface as switched on (its channel status and delivery policy). Where the web UI is, and every link to it, does not depend on it. This does not bind a listener: the bundle is served by the control-plane listener when controlPlane.webui.serve is true, so who can reach it follows controlPlane.hostMode and controlPlane.host.',
  },
  {
    key: 'web.hostMode',
    label: "Who the web UI's development server listens to",
    type: 'enum',
    description: 'Where the web UI\'s development server listens (local, network or custom), with web.host and web.port; the development server reads it through goodvibes-daemon webui status --json. It is never the web UI\'s address: the bundle the daemon serves, and every link to it, follow controlPlane.hostMode.',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'web.host',
    label: "Address of the web UI's development server",
    type: 'string',
    description: 'Host the web UI\'s development server binds (with web.hostMode custom). Nothing else listens on web.host:web.port, and no link uses it; the served bundle follows controlPlane.host and controlPlane.port.',
  },
  {
    key: 'web.port',
    label: "Port of the web UI's development server",
    type: 'number',
    description: 'Port the web UI\'s development server binds. The daemon does not bind it and no link, pairing address, goodvibes web or tailscale serve uses it: the bundle the daemon serves is at the control-plane address (controlPlane.port).',
    ...port(),
  },
  {
    key: 'web.publicBaseUrl',
    label: 'Outside address used in web links',
    type: 'string',
    description: 'Public base URL for web links and notification deep links, for a web app served somewhere the daemon cannot describe (a tunnel or reverse proxy). Empty (the default) means links are derived: the daemon\'s own reachable address when it serves the web app (controlPlane.webui.serve), otherwise there is no web app and no link; a link only reachable on this machine is left out of messages read on other devices.',
  },
  {
    key: 'web.staticAssetsDir',
    label: 'Fallback folder of web UI files',
    type: 'string',
    description: 'Static asset directory for the embedded web surface (index.html + assets), served when controlPlane.webui.serve is true. Used when controlPlane.webui.bundleDir is empty; that more specific key wins when it names a directory.',
  },
];

export const runtimeSecondaryConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'watchers.enabled',
    label: 'Watch outside sources',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'Enable managed watcher/listener services (checkpointing and recovery for long-running external sources). Default on: with no watchers configured the framework idles.',
  },
  {
    key: 'watchers.pollIntervalMs',
    label: 'How often a new watcher checks (ms)',
    type: 'number',
    description: 'Default polling interval in milliseconds for new watchers registered through the API; existing watchers and other registration paths keep their own interval',
    ...intRange(1_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.heartbeatIntervalMs',
    label: 'How often watchers report in (ms)',
    type: 'number',
    description: 'Heartbeat interval for watcher services in milliseconds',
    ...intRange(1_000, 60 * 60 * 1000),
  },
  {
    key: 'watchers.ciPollIntervalMs',
    label: 'How often CI results are checked (ms)',
    type: 'number',
    description: 'Cadence (ms) for the daemon\'s recurring CI-watch poll; the poller enforces a 15s floor to respect the status source\'s rate limits. Read once when the daemon starts: a new value applies after the next restart.',
    ...intRange(1_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.recoveryWindowMinutes',
    label: 'Catch up on missed events this recently (minutes)',
    type: 'number',
    description: 'Recovery window for watcher restart and missed-event catch-up',
    ...intRange(0, 24 * 60),
  },
  {
    key: 'service.enabled',
    label: 'Run the daemon as a service',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'Whether this machine runs the daemon as a service. On, a daemon started by hand installs the service at its first idle moment and doctor reports a missing or stopped service; off (the installers\' --no-service, or goodvibes-daemon uninstall-service), nothing installs one and doctor does not ask for one. goodvibes-daemon install-service turns it on. A daemon setting: one value every program and installer reads, in the daemon\'s settings file.',
  },
  {
    key: 'service.autostart',
    label: 'Start the daemon at login',
    type: 'boolean',
    description: 'Whether the daemon\'s service starts on its own at login. The daemon applies every change, however it is set (a settings screen, /config set, the Agent\'s /settings set, goodvibes-daemon config set, the API, or an edit of the daemon\'s settings file): on installs the service when it is not installed and enables it at login (systemd enable; a LaunchAgent with RunAtLoad); off disables it at login and leaves it installed and running. A value set while no daemon runs is applied when the daemon next starts. goodvibes-daemon install-service turns it on and uninstall-service off. A Windows logon task starts at login while installed whatever its value. A daemon setting, in the daemon\'s settings file.',
  },
  {
    key: 'service.restartOnFailure',
    label: 'Restart the daemon if it stops',
    type: 'boolean',
    description: 'Restart the service automatically after failure',
  },
  {
    key: 'service.platform',
    label: 'Service manager',
    type: 'enum',
    description: 'Target service manager platform',
    enumValues: ['auto', 'systemd', 'launchd', 'windows', 'manual'],
  },
  {
    key: 'service.serviceName',
    label: "Name of the daemon's service",
    type: 'string',
    description: 'Name of the daemon\'s service unit, used by the installer, the daemon\'s and the terminal apps\' service commands and onboarding alike. Empty (the default) uses goodvibes (goodvibes.service under systemd) on Linux and Windows, and sh.goodvibes.daemon (the launchd label) on macOS.',
  },
  {
    key: 'service.logPath',
    label: 'Daemon log file',
    type: 'string',
    description: 'File path for daemon/service logs (empty = platform default under the configured service directory)',
  },
  {
    key: 'network.outboundTls.mode',
    label: 'Certificates trusted for outgoing connections',
    type: 'enum',
    description: 'Outbound HTTPS trust mode for Bun fetch-based network calls',
    enumValues: ['bundled', 'bundled+custom', 'custom'],
  },
  {
    key: 'network.outboundTls.customCaFile',
    label: 'Extra certificate file to trust',
    type: 'string',
    description: 'Additional PEM file to trust for outbound HTTPS when using bundled+custom or custom mode',
  },
  {
    key: 'network.outboundTls.customCaDir',
    label: 'Folder of extra certificates to trust',
    type: 'string',
    description: 'Directory of PEM/CRT/CER files to trust for outbound HTTPS when using bundled+custom or custom mode',
  },
  {
    key: 'network.outboundTls.allowInsecureLocalhost',
    label: 'Accept self-signed certificates on this computer',
    type: 'boolean',
    description: 'Allow self-signed HTTPS only for localhost/loopback outbound requests',
  },
  {
    key: 'network.remoteFetch.allowPrivateHosts',
    label: 'Allow fetching from addresses on your own network',
    type: 'boolean',
    description: 'Allow explicit admin-approved remote fetches from private, localhost, or metadata hosts for artifacts and ingest flows',
  },
  {
    key: 'network.privateDeliveryHosts',
    label: 'Machines on your network deliveries may reach',
    type: 'string',
    description:
      'Comma-separated hosts on your own network that deliveries you configured may reach: a watcher\'s target, a notification webhook, the default webhook target (a LAN device 192.168.1.20, a name such as ha.lan, or *.home.lan for every name under it). Such a host may resolve to a private, loopback, link-local, unique-local or shared (CGNAT, Tailscale) address; a cloud metadata address is always refused, and addresses from outside parties never use this list. Your own settings only: a project settings file cannot set it, and adding a host is yours to decide.',
  },
  {
    key: 'relay.enabled',
    label: 'Reach this daemon from outside through a relay',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'Connect the daemon OUTBOUND to a zero-knowledge relay for reachability from outside the LAN. Default on, but no connection is ever made without an explicitly configured relay.url, leave the URL empty to keep the daemon LAN-only.',
  },
  {
    key: 'relay.url',
    label: 'Relay address',
    type: 'string',
    description: 'Relay URL to dial (wss://…); empty disables the outbound relay connection',
  },
  {
    key: 'relay.rendezvousId',
    label: "This daemon's relay id",
    type: 'string',
    description: 'The rendezvous id the daemon registers under on the relay, derived from the daemon\'s relay identity key and recorded here by the daemon; setting it has no effect',
  },
  {
    key: 'relay.label',
    label: "This daemon's name for pairing",
    type: 'string',
    description: 'Human-facing daemon label carried in relay pairing payloads',
  },
  {
    key: 'relay.requireStepUpForMutations',
    label: 'Ask for your passkey before changes made through the relay',
    type: 'boolean',
    description: 'Require a recent WebAuthn step-up assertion on mutating operator calls arriving via relay (checked against a passkey registered through pairing or the step-up verbs)',
  },
  {
    key: 'runtime.companionChat.closedRetentionDays',
    label: 'Delete closed chats after (days, 0 to keep)',
    type: 'number',
    description:
      'Days after a companion chat is closed before its saved files are deleted. ' +
      '0 (the default) keeps closed chats forever. Read on every cleanup pass, so a change applies without a restart.',
    ...intRange(0, 36_500),
  },
  {
    key: 'runtime.companionChatLimiter.perSessionLimit',
    label: 'Most chat messages per minute',
    type: 'number',
    description:
      'Max companion chat messages per 60-second window per session. ' +
      '0 (the default) means unset: the GOODVIBES_CHAT_LIMITER_THRESHOLD env var (read once at daemon startup) applies, else 10. ' +
      'A positive integer overrides the env var and is read on each check() call.',
    ...intRange(0, 100_000),
  },
  {
    key: 'runtime.eventBus.maxListeners',
    label: 'Most listeners per event',
    type: 'number',
    description:
      'Maximum number of listeners per event channel (per-type and per-domain) before a warning is emitted in production ' +
      'or a RangeError is thrown in development mode. Raise this only if you have verified there is no subscriber leak.',
    ...intRange(1, 100_000),
  },
  {
    key: 'runtime.maxParallelToolCalls',
    label: 'Tool calls that run at once',
    type: 'number',
    description:
      'Most tool calls of one model response that run at the same time. Reads run side by side, and so do writes to files that do not overlap; ' +
      'a command, an action the owner decides and a tool with undeclared effects always run alone, in the order the model asked. 1 runs every call one after another. ' +
      'Applies to the main session, sub-agents and companion chat; read once per response.',
    ...intRange(1, 64),
  },
  {
    key: 'telemetry.includeRawPrompts',
    label: 'Allow reading prompts in telemetry',
    type: 'boolean',
    description:
      'Allow raw telemetry reads from this daemon while enabled. Default false rejects raw reads; safe views always redact content. ' +
      'HTTP raw reads also require read:telemetry and an admin session or read:telemetry-sensitive scope. Active raw streams stop after this opt-in is revoked. ' +
      'Raw prompts may contain private data. Enabling the setting at startup emits a WARN log.',
  },
  {
    key: 'telemetry.decisionOtlpEnabled',
    label: 'Send permission decisions to a tracing collector',
    type: 'boolean',
    description: 'Export permission/policy decision-log records to an OTLP endpoint (export-only, no ingestion). Requires telemetry.decisionOtlpEndpoint',
  },
  {
    key: 'telemetry.decisionOtlpEndpoint',
    label: 'Tracing collector for permission decisions',
    type: 'string',
    description: 'OTLP/HTTP JSON endpoint base for decision-log export (empty = disabled). Spans POST to <base>/v1/traces, logs to <base>/v1/logs',
  },
  {
    key: 'telemetry.decisionOtlpSignal',
    label: 'Send permission decisions as',
    type: 'enum',
    description: 'Which OTLP record shape each decision is emitted as: span, log, or both',
    enumValues: ['span', 'log', 'both'],
  },
  {
    key: 'batch.mode',
    label: 'Send requests in cheaper batches',
    type: 'enum',
    description: 'Daemon provider Batch API mode. off: nothing is queued (the batch job API refuses with BATCH_DISABLED). explicit: the batch job API is open, and a non-streaming OpenAI-compatible chat completion is queued when it sends x-goodvibes-execution: batch. eligible-by-default: every non-streaming OpenAI-compatible chat completion whose provider has a Batch API is queued unless it sends x-goodvibes-execution: live (one whose provider cannot batch runs live as usual; batch.fallback applies only to an explicit batch request); a queued one is answered 202 with the job id and read back at <pathPrefix>/chat/completions/<id>. Streaming requests and terminal, companion and web chat always run live.',
    enumValues: ['off', 'explicit', 'eligible-by-default'],
  },
  {
    key: 'batch.fallback',
    label: "When a provider can't batch",
    type: 'enum',
    description: 'What a batch job does when its provider has no Batch API: live runs the request once, now, as an ordinary request and answers the job already finished; fail refuses the job. A job that asks for a live execution mode is refused either way: the batch API only queues.',
    enumValues: ['live', 'fail'],
  },
  {
    key: 'batch.queueBackend',
    label: 'Where batched requests wait',
    type: 'enum',
    description: 'Queue backend for daemon batch signals. local stores jobs under the daemon config directory; cloudflare sends them through the provisioned Worker\'s queue. /cloudflare provision switches this to cloudflare only after the Worker reaches the daemon.',
    enumValues: ['local', 'cloudflare'],
  },
  {
    key: 'batch.tickIntervalMs',
    label: 'How often batches are sent (ms)',
    type: 'number',
    description: 'Daemon-local batch scheduler tick interval in milliseconds. Read once when the scheduler starts: a new value applies after the next restart.',
    ...intRange(5_000, 60 * 60 * 1000),
  },
  {
    key: 'batch.maxDelayMs',
    label: 'Longest a request waits for a batch (ms)',
    type: 'number',
    description: 'Maximum time a queued local batch job should wait before the daemon submits its provider batch',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'batch.maxJobsPerProviderBatch',
    label: 'Most requests per batch',
    type: 'number',
    description: 'Maximum platform jobs grouped into a single upstream provider batch submission',
    ...intRange(1, 100_000),
  },
  {
    key: 'batch.maxQueuePayloadBytes',
    label: 'Largest batched request (bytes)',
    type: 'number',
    description: 'Maximum Cloudflare queue message payload size in bytes; a larger cloudflare-queue job is refused (HTTP 413). Queue messages should be signals, not full prompt archives',
    ...intRange(1024, 128 * 1024),
  },
  {
    key: 'batch.maxQueueMessagesPerDay',
    label: 'Most Cloudflare queue messages per day',
    type: 'number',
    description: 'Daily Cloudflare queue message budget, enforced by the provisioned Worker (its Durable Object coordinator counts per UTC day): past it, the Worker answers 429 QUEUE_BUDGET_EXHAUSTED with the use so far and when it resets, and nothing more is queued. 0 means no limit. Takes effect at the next /cloudflare provision.',
    ...intRange(0, 10_000_000),
  },
  {
    key: 'cloudflare.enabled',
    label: 'Use Cloudflare',
    type: 'boolean',
    description: 'Enable optional Cloudflare Worker/Queue integration points. The daemon does not require Cloudflare when this is false.',
  },
  {
    key: 'cloudflare.freeTierMode',
    label: "Stay within Cloudflare's free plan",
    type: 'boolean',
    description: 'Keep job bodies out of Cloudflare Queues: the provisioned Worker stores each body in R2 and queues only its key, and refuses a job when R2 is not provisioned (409 QUEUE_PAYLOADS_NEED_R2). Off, a body up to batch.maxQueuePayloadBytes travels in the queue message. Takes effect at the next /cloudflare provision.',
  },
  {
    key: 'cloudflare.accountId',
    label: 'Cloudflare account',
    type: 'string',
    description: 'Cloudflare account id used by platform-owned Worker/Queue provisioning and by the cloudflare-ai-gateway provider (which falls back to CLOUDFLARE_ACCOUNT_ID when this is empty).',
  },
  {
    key: 'cloudflare.aiGatewayId',
    label: 'Cloudflare AI Gateway',
    type: 'string',
    description: 'Cloudflare AI Gateway id the cloudflare-ai-gateway provider sends through (with cloudflare.accountId). If empty, the provider falls back to CLOUDFLARE_AI_GATEWAY_ID. A change to either id takes effect at once.',
  },
  {
    key: 'cloudflare.apiTokenRef',
    label: 'Cloudflare API token',
    type: 'string',
    description: 'GoodVibes secret reference for the Cloudflare API token. If empty, the platform falls back to CLOUDFLARE_API_TOKEN.',
  },
  {
    key: 'cloudflare.zoneId',
    label: 'Cloudflare domain id',
    type: 'string',
    description: 'Optional Cloudflare zone id selected for platform-managed DNS and Zero Trust Access hostnames',
  },
  {
    key: 'cloudflare.zoneName',
    label: 'Cloudflare domain',
    type: 'string',
    description: 'Optional Cloudflare zone name selected during discovery/onboarding when zone id is not known yet',
  },
  {
    key: 'cloudflare.workerName',
    label: 'Cloudflare worker name',
    type: 'string',
    description: 'Cloudflare Worker script name managed by GoodVibes provisioning',
    validate: (v) => typeof v === 'string' && (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(v) || v === ''),
  },
  {
    key: 'cloudflare.workerSubdomain',
    label: 'Cloudflare workers.dev subdomain',
    type: 'string',
    description: 'Cloudflare account workers.dev subdomain used to infer cloudflare.workerBaseUrl',
  },
  {
    key: 'cloudflare.workerHostname',
    label: "Cloudflare worker's own address",
    type: 'string',
    description: 'Optional custom hostname for the GoodVibes Cloudflare Worker when DNS automation is enabled',
  },
  {
    key: 'cloudflare.workerBaseUrl',
    label: 'Cloudflare worker address',
    type: 'string',
    description: 'Optional deployed GoodVibes Cloudflare Worker base URL used by clients that proxy batch signals through Workers',
  },
  {
    key: 'cloudflare.daemonBaseUrl',
    label: 'Address Cloudflare uses to reach the daemon',
    type: 'string',
    description: 'Daemon origin URL the Cloudflare Worker or Tunnel uses for Worker-to-daemon batch calls',
  },
  {
    key: 'cloudflare.daemonHostname',
    label: 'Public address of the daemon through Cloudflare',
    type: 'string',
    description: 'Optional public daemon hostname managed through Cloudflare DNS, Tunnel, and Access provisioning',
  },
  {
    key: 'cloudflare.workerTokenRef',
    label: 'Token the worker uses with the daemon',
    type: 'string',
    description: 'Optional GoodVibes secret reference for the Worker-to-daemon bearer token',
  },
  {
    key: 'cloudflare.workerClientTokenRef',
    label: 'Token apps use with the worker',
    type: 'string',
    description: 'Optional GoodVibes secret reference for the bearer token clients use when calling the Cloudflare Worker',
  },
  {
    key: 'cloudflare.workerCron',
    label: 'Cloudflare worker schedule',
    type: 'string',
    description: 'Cron trigger installed on the GoodVibes Cloudflare Worker for batch scheduler ticks',
  },
  {
    key: 'cloudflare.queueName',
    label: 'Cloudflare queue',
    type: 'string',
    description: 'Cloudflare Queue binding/name for GoodVibes batch job signals',
  },
  {
    key: 'cloudflare.deadLetterQueueName',
    label: 'Cloudflare queue for failed jobs',
    type: 'string',
    description: 'Cloudflare dead-letter queue binding/name for failed GoodVibes batch job signals',
  },
  {
    key: 'cloudflare.tunnelName',
    label: 'Cloudflare tunnel name',
    type: 'string',
    description: 'Zero Trust Tunnel name managed by GoodVibes provisioning when tunnel integration is enabled',
  },
  {
    key: 'cloudflare.tunnelId',
    label: 'Cloudflare tunnel id',
    type: 'string',
    description: 'Cloudflare Zero Trust Tunnel id selected or created by GoodVibes provisioning',
  },
  {
    key: 'cloudflare.tunnelTokenRef',
    label: 'Cloudflare tunnel token',
    type: 'string',
    description: 'GoodVibes secret reference for the cloudflared tunnel token generated by provisioning',
  },
  {
    key: 'cloudflare.accessAppId',
    label: 'Cloudflare Access app protecting the daemon',
    type: 'string',
    description: 'Cloudflare Zero Trust Access application id protecting the GoodVibes daemon hostname',
  },
  {
    key: 'cloudflare.accessServiceTokenId',
    label: 'Cloudflare Access service token id',
    type: 'string',
    description: 'Id of the Cloudflare Zero Trust Access service token created for GoodVibes daemon access: the public half, sent beside the client secret, which is stored separately under cloudflare.accessServiceTokenRef',
  },
  {
    key: 'cloudflare.accessServiceTokenRef',
    label: 'Cloudflare Access service token',
    type: 'string',
    description: 'GoodVibes secret reference storing Access service token client id/secret JSON',
  },
  {
    key: 'cloudflare.kvNamespaceName',
    label: 'Cloudflare store for job delivery state',
    type: 'string',
    description: 'Cloudflare KV namespace that records each queued job\'s delivery state (queued, delivered with the daemon job id, rejected), served by the Worker at /batch/queue/jobs/<id>, so a redelivered message is acknowledged without a second daemon call.',
  },
  {
    key: 'cloudflare.kvNamespaceId',
    label: 'Cloudflare store id',
    type: 'string',
    description: 'Cloudflare KV namespace id used for the GoodVibes Worker binding',
  },
  {
    key: 'cloudflare.durableObjectNamespaceName',
    label: 'Cloudflare counter for daily queue use',
    type: 'string',
    description: 'Cloudflare Durable Object class whose coordinator counts queue operations and messages per UTC day for the queue budgets; added automatically when a budget is set.',
  },
  {
    key: 'cloudflare.durableObjectNamespaceId',
    label: 'Cloudflare counter id',
    type: 'string',
    description: 'Cloudflare Durable Object namespace id, recorded by provisioning after the Worker migration (not an input).',
  },
  {
    key: 'cloudflare.r2BucketName',
    label: 'Cloudflare bucket for queued jobs',
    type: 'string',
    description: 'Cloudflare R2 bucket that holds queued job bodies so queue messages carry only their key; a body is deleted once the daemon has the job.',
  },
  {
    key: 'cloudflare.secretsStoreName',
    label: 'Cloudflare secrets store name',
    type: 'string',
    description: 'Name of the Cloudflare Secrets Store that optional GoodVibes provisioning creates and manages (the store holds the secrets; this is its name)',
  },
  {
    key: 'cloudflare.secretsStoreId',
    label: 'Cloudflare secrets store id',
    type: 'string',
    description: 'Cloudflare Secrets Store id selected or created by GoodVibes provisioning',
  },
  {
    key: 'cloudflare.maxQueueOpsPerDay',
    label: 'Most Cloudflare queue operations per day',
    type: 'number',
    description: 'Daily Cloudflare queue operation budget, enforced by the provisioned Worker (its Durable Object coordinator counts per UTC day): past it, the Worker answers 429 QUEUE_BUDGET_EXHAUSTED with the use so far and when it resets. 0 means no limit. Takes effect at the next /cloudflare provision.',
    ...intRange(0, 10_000_000),
  },
];
