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
    type: 'boolean',
    default: true,
    description: 'Enable the automation subsystem (durable routines, schedule evaluation, run history). Default on: with no routines defined it idles and surfaces a how-to-create-your-first-routine empty state.',
  },
  {
    key: 'automation.maxConcurrentRuns',
    type: 'number',
    default: 4,
    description: 'Maximum automation runs that may execute concurrently',
    ...intRange(1, 64),
  },
  {
    key: 'automation.runHistoryLimit',
    type: 'number',
    default: 100,
    description: 'Maximum run history entries retained per automation job',
    ...intRange(1, 5000),
  },
  {
    key: 'automation.defaultTimeoutMs',
    type: 'number',
    default: 2 * 60 * 60 * 1000,
    description: 'How long an automation run without its own timeout may run, in milliseconds (default two hours); a run past it is stopped and recorded as failed. Applies to running runs at once. 0 removes the deadline',
    ...intRange(0, 2_147_483_647),
  },
  {
    key: 'automation.catchUpWindowMinutes',
    type: 'number',
    default: 30,
    description: 'How long after startup the engine should catch up missed runs. The same window (at least 5 minutes) is also how long a running run whose agent has vanished is left before it is failed as "Agent state lost", so a large value keeps such a run holding a concurrency slot for as long.',
    ...intRange(0, 24 * 60),
  },
  {
    key: 'automation.failureCooldownMs',
    type: 'number',
    default: 5 * 60 * 1000,
    description: 'Cooldown applied after a failed automation run before retrying',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'automation.deleteAfterRun',
    type: 'boolean',
    default: false,
    description: 'Default for the deleteAfterRun flag of newly created one-shot (at) automation jobs: a job with the flag is deleted after its first successful run. Recurring jobs are never deleted by this default. Existing jobs keep the value they were created with.',
  },
  {
    key: 'checkin.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the proactive check-in: on a cadence, a briefing is judged and the user is contacted only when something warrants it',
  },
  {
    key: 'checkin.cadence',
    type: 'string',
    default: '0 */4 * * *',
    description: 'Proactive check-in cadence as a cron expression (default: every 4 hours)',
  },
  {
    key: 'checkin.deliveryChannel',
    type: 'string',
    default: '',
    description: 'Where a proactive check-in message is delivered: "surfaceKind" or "surfaceKind:address" (e.g. "slack:C123"). Empty falls back to the owner profile field contactMe.channel.',
  },
  {
    key: 'checkin.quietHours',
    type: 'string',
    default: '',
    description: 'Proactive check-in quiet hours as "HH:MM-HH:MM" local time; no message is sent during this window. Empty falls back to the owner profile field contactMe.quietHours, and disables quiet hours only when the profile has none.',
  },
  {
    key: 'controlPlane.enabled',
    type: 'boolean',
    default: false,
    description: 'Whether the control plane is served to other machines. Off (default): the daemon listener answers only requests from this machine (loopback or one of its own addresses), whatever controlPlane.hostMode binds, and refuses any other address with CONTROL_PLANE_LOCAL_ONLY naming this setting. On: every address the binding reaches is served (paired devices, the web UI from another device, a reverse proxy). Channel webhooks under /webhook/ are answered either way; each surface\'s own switch decides them. Takes effect on the next request; the outbound relay has its own switch (relay.enabled). goodvibes-daemon webui enable --lan turns it on with the network binding.',
  },
  {
    key: 'controlPlane.gateway',
    type: 'boolean',
    default: true,
    description: 'The shared gateway/control-plane host serving state snapshots, live streams (SSE/WS), and authenticated control APIs to terminal hosts and remote clients. Default on so a stock daemon can stream companion chat; every streaming endpoint stays auth-gated and the default bind stays loopback. Turn off for a request/response-only daemon.',
  },
  {
    key: 'controlPlane.hostMode',
    type: 'enum',
    default: 'local',
    description: 'Network binding mode for the control-plane listener: local (127.0.0.1, default port), network (0.0.0.0, default port), custom (the host and port below). This and host decide what the listener binds; whether another machine is then served is controlPlane.enabled.',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'controlPlane.host',
    type: 'string',
    default: '127.0.0.1',
    description: 'Bind host for the control-plane HTTP server, used when controlPlane.hostMode is custom',
  },
  {
    key: 'controlPlane.port',
    type: 'number',
    default: 3421,
    description: 'Bind port for the control-plane HTTP server',
    ...port(),
  },
  {
    key: 'controlPlane.publicBaseUrl',
    type: 'string',
    default: '',
    description:
      'Override for a genuinely external control-plane address (tunnel or reverse proxy). '
      + 'Leave empty, the everyday base URL is derived from hostMode/host/port/tls.mode, '
      + 'so it cannot drift. Set this only when an off-box address differs from the bind.',
  },
  {
    key: 'controlPlane.streamMode',
    type: 'enum',
    default: 'sse',
    description: 'Which live update stream the daemon listener serves: sse serves GET /api/control-plane/events only, websocket serves the /api/control-plane/ws upgrade only, both serves both. The other one is refused with STREAM_MODE_NOT_SERVED naming this setting. The terminal apps and the web UI read the Server-Sent Events stream, so websocket alone leaves them without live updates. Takes effect on the next request.',
    enumValues: ['sse', 'websocket', 'both'],
  },
  {
    key: 'controlPlane.trustProxy',
    type: 'boolean',
    default: false,
    description: 'Trust proxy forwarding headers such as x-forwarded-for for the control plane',
  },
  {
    key: 'controlPlane.openaiCompatible.enabled',
    type: 'boolean',
    default: true,
    description: 'Expose OpenAI-compatible /v1/models and /v1/chat/completions routes on the authenticated daemon',
  },
  {
    key: 'controlPlane.openaiCompatible.pathPrefix',
    type: 'string',
    default: '/v1',
    description: 'Path prefix for the daemon OpenAI-compatible routes',
    validate: (v) => typeof v === 'string' && /^(\/[A-Za-z0-9._~-]+)+$/.test(v) && !v.includes('..'),
    validationHint: 'a path such as /v1: segments of letters, digits, . _ ~ -, with no trailing slash and not just /',
  },
  {
    key: 'controlPlane.webui.serve',
    type: 'boolean',
    default: false,
    description: 'Serve a built web UI bundle same-origin from the daemon (opt-in; loopback default unchanged). The bundle is public and the app token-authenticates its own API calls.',
  },
  {
    key: 'controlPlane.webui.bundleDir',
    type: 'string',
    default: '',
    description: 'Directory holding the built web UI bundle (index.html + assets) served when controlPlane.webui.serve is true. Takes precedence over web.staticAssetsDir: this key is the specific answer for this daemon, so when it names a directory that is the one served. Empty falls back to web.staticAssetsDir.',
  },
  {
    key: 'controlPlane.cors.enabled',
    type: 'boolean',
    default: false,
    description: 'Answer OPTIONS preflight and emit Access-Control-Allow-* headers for allowlisted origins (opt-in; off by default). Never wildcards; credentials are allowlist-gated.',
  },
  {
    key: 'controlPlane.cors.allowedOrigins',
    type: 'string',
    default: '',
    description: 'Comma-separated explicit allowlist of browser origins permitted to make cross-origin requests when controlPlane.cors.enabled is true (e.g. http://localhost:5173). Empty refuses every cross-origin request. The WebSocket upgrade origin check reads this list on its own, whether or not controlPlane.cors.enabled is true.',
  },
  {
    key: 'controlPlane.tls.mode',
    type: 'enum',
    default: 'off',
    description: 'TLS mode for the control-plane HTTP server',
    enumValues: ['off', 'proxy', 'direct'],
  },
  {
    key: 'controlPlane.tls.certFile',
    type: 'string',
    default: '',
    description: 'Certificate chain PEM path for direct control-plane TLS (empty = certs/fullchain.pem under this surface\'s settings directory, e.g. ~/.goodvibes/tui/certs/fullchain.pem for the terminal app and the daemon)',
  },
  {
    key: 'controlPlane.tls.keyFile',
    type: 'string',
    default: '',
    description: 'Filesystem pathname of the PEM file used for direct control-plane TLS. This setting stores a path, not the private key contents. Empty uses certs/privkey.pem under this surface\'s settings directory (e.g. ~/.goodvibes/tui/certs/privkey.pem for the terminal app and the daemon).',
  },
  {
    key: 'httpListener.hostMode',
    type: 'enum',
    default: 'local',
    description: 'Network binding mode: local (127.0.0.1, default port), network (0.0.0.0, default port), custom (editable host and port)',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'httpListener.host',
    type: 'string',
    default: '127.0.0.1',
    description: 'Bind host for the webhook HTTP listener',
  },
  {
    key: 'httpListener.port',
    type: 'number',
    default: 3422,
    description: 'Bind port for the webhook HTTP listener',
    ...port(),
  },
  {
    key: 'httpListener.trustProxy',
    type: 'boolean',
    default: false,
    description: 'Trust proxy forwarding headers such as x-forwarded-for for the webhook listener',
  },
  {
    key: 'httpListener.trustCloudflare',
    type: 'boolean',
    default: false,
    description: 'Read the real client IP from CF-Connecting-IP, and only when the connecting peer is inside a published Cloudflare range. Requires httpListener.trustProxy: with it off, CF-Connecting-IP is ignored no matter what this says. The range check is the point, without it any peer could send a CF-Connecting-IP header and choose which address the rate limiter and the audit log recorded. Leave off unless this listener genuinely sits behind Cloudflare.',
  },
  {
    key: 'httpListener.tls.mode',
    type: 'enum',
    default: 'off',
    description: 'TLS mode for the webhook HTTP listener',
    enumValues: ['off', 'proxy', 'direct'],
  },
  {
    key: 'httpListener.tls.certFile',
    type: 'string',
    default: '',
    description: 'Certificate chain PEM path for direct webhook-listener TLS (empty = certs/fullchain.pem under this surface\'s settings directory)',
  },
  {
    key: 'httpListener.tls.keyFile',
    type: 'string',
    default: '',
    description: 'Private key PEM path for direct webhook-listener TLS (empty = certs/privkey.pem under this surface\'s settings directory)',
  },
  {
    key: 'web.enabled',
    type: 'boolean',
    default: true,
    description: 'Declare the browser-based operator surface as available (status and links). This does not bind a listener: the bundle is served by the control-plane listener when controlPlane.webui.serve is true, so who can reach it follows controlPlane.hostMode and controlPlane.host.',
  },
  {
    key: 'web.hostMode',
    type: 'enum',
    default: 'local',
    description: 'Declared endpoint mode for the web surface links (local, network or custom). Nothing binds it; exposure of the served bundle follows controlPlane.hostMode.',
    enumValues: ['local', 'network', 'custom'],
  },
  {
    key: 'web.host',
    type: 'string',
    default: '127.0.0.1',
    description: 'Declared host of the web surface endpoint, used for links. Nothing listens on web.host:web.port; the served bundle follows controlPlane.host and controlPlane.port.',
  },
  {
    key: 'web.port',
    type: 'number',
    default: 3423,
    description: 'Declared port of the web surface endpoint, used for links and development servers. The daemon does not bind it; the served bundle uses controlPlane.port.',
    ...port(),
  },
  {
    key: 'web.publicBaseUrl',
    type: 'string',
    default: '',
    description: 'Public base URL for web links and notification deep links, for a web app served somewhere the daemon cannot describe (a tunnel or reverse proxy). Empty (the default) means links are derived: the daemon\'s own reachable address when it serves the web app (controlPlane.webui.serve), otherwise the web endpoint binding; a link only reachable on this machine is left out of messages read on other devices.',
  },
  {
    key: 'web.staticAssetsDir',
    type: 'string',
    default: 'dist/web',
    description: 'Static asset directory for the embedded web surface (index.html + assets), served when controlPlane.webui.serve is true. Used when controlPlane.webui.bundleDir is empty; that more specific key wins when it names a directory.',
  },
];

export const runtimeSecondaryConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'watchers.enabled',
    type: 'boolean',
    default: true,
    description: 'Enable managed watcher/listener services (checkpointing and recovery for long-running external sources). Default on: with no watchers configured the framework idles.',
  },
  {
    key: 'watchers.pollIntervalMs',
    type: 'number',
    default: 60_000,
    description: 'Default polling interval in milliseconds for new watchers registered through the API; existing watchers and other registration paths keep their own interval',
    ...intRange(1_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.heartbeatIntervalMs',
    type: 'number',
    default: 15_000,
    description: 'Heartbeat interval for watcher services in milliseconds',
    ...intRange(1_000, 60 * 60 * 1000),
  },
  {
    key: 'watchers.ciPollIntervalMs',
    type: 'number',
    default: 60_000,
    description: 'Cadence (ms) for the daemon\'s recurring CI-watch poll; the poller enforces a 15s floor to respect the status source\'s rate limits. Read once when the daemon starts: a new value applies after the next restart.',
    ...intRange(1_000, 24 * 60 * 60 * 1000),
  },
  {
    key: 'watchers.recoveryWindowMinutes',
    type: 'number',
    default: 10,
    description: 'Recovery window for watcher restart and missed-event catch-up',
    ...intRange(0, 24 * 60),
  },
  {
    key: 'service.enabled',
    type: 'boolean',
    default: true,
    description: 'Enable service-install and daemon-management features (install/start/stop/status/autostart verbs), including the standalone daemon\'s boot-time self-promotion to a supervised service at its first idle moment. Set false to keep spawned daemons session-only (nothing installed or promoted).',
  },
  {
    key: 'service.autostart',
    type: 'boolean',
    default: false,
    description: 'Whether the daemon\'s service starts on its own at login. Changing it on the terminal app\'s settings screen installs and enables the service (on) or disables it (off); set any other way (a settings file, a command, Agent, the daemon) it is only recorded, and goodvibes status and doctor read it to warn about an installed service with it off. goodvibes-daemon install-service makes the service start at login whatever its value',
  },
  {
    key: 'service.restartOnFailure',
    type: 'boolean',
    default: true,
    description: 'Restart the service automatically after failure',
  },
  {
    key: 'service.platform',
    type: 'enum',
    default: 'auto',
    description: 'Target service manager platform',
    enumValues: ['auto', 'systemd', 'launchd', 'windows', 'manual'],
  },
  {
    key: 'service.serviceName',
    type: 'string',
    default: '',
    description: 'Name of the daemon\'s service unit, used by the installer, the daemon\'s and the terminal apps\' service commands and onboarding alike. Empty (the default) uses goodvibes (goodvibes.service under systemd) on Linux and Windows, and sh.goodvibes.daemon (the launchd label) on macOS.',
  },
  {
    key: 'service.logPath',
    type: 'string',
    default: '',
    description: 'File path for daemon/service logs (empty = platform default under the configured service directory)',
  },
  {
    key: 'network.outboundTls.mode',
    type: 'enum',
    default: 'bundled',
    description: 'Outbound HTTPS trust mode for Bun fetch-based network calls',
    enumValues: ['bundled', 'bundled+custom', 'custom'],
  },
  {
    key: 'network.outboundTls.customCaFile',
    type: 'string',
    default: '',
    description: 'Additional PEM file to trust for outbound HTTPS when using bundled+custom or custom mode',
  },
  {
    key: 'network.outboundTls.customCaDir',
    type: 'string',
    default: '',
    description: 'Directory of PEM/CRT/CER files to trust for outbound HTTPS when using bundled+custom or custom mode',
  },
  {
    key: 'network.outboundTls.allowInsecureLocalhost',
    type: 'boolean',
    default: false,
    description: 'Allow self-signed HTTPS only for localhost/loopback outbound requests',
  },
  {
    key: 'network.remoteFetch.allowPrivateHosts',
    type: 'boolean',
    default: false,
    description: 'Allow explicit admin-approved remote fetches from private, localhost, or metadata hosts for artifacts and ingest flows',
  },
  {
    key: 'network.privateDeliveryHosts',
    type: 'string',
    default: '',
    description:
      'Comma-separated hosts on your own network that deliveries you configured may reach: a watcher\'s target, a notification webhook, the default webhook target (a LAN device 192.168.1.20, a name such as ha.lan, or *.home.lan for every name under it). Such a host may resolve to a private, loopback, link-local, unique-local or shared (CGNAT, Tailscale) address; a cloud metadata address is always refused, and addresses from outside parties never use this list. Your own settings only: a project settings file cannot set it, and adding a host is yours to decide.',
  },
  {
    key: 'relay.enabled',
    type: 'boolean',
    default: true,
    description: 'Connect the daemon OUTBOUND to a zero-knowledge relay for reachability from outside the LAN. Default on, but no connection is ever made without an explicitly configured relay.url, leave the URL empty to keep the daemon LAN-only.',
  },
  {
    key: 'relay.url',
    type: 'string',
    default: '',
    description: 'Relay URL to dial (wss://…); empty disables the outbound relay connection',
  },
  {
    key: 'relay.rendezvousId',
    type: 'string',
    default: '',
    description: 'The rendezvous id the daemon registers under on the relay, derived from the daemon\'s relay identity key and recorded here by the daemon; setting it has no effect',
  },
  {
    key: 'relay.label',
    type: 'string',
    default: '',
    description: 'Human-facing daemon label carried in relay pairing payloads',
  },
  {
    key: 'relay.requireStepUpForMutations',
    type: 'boolean',
    default: false,
    description: 'Require a recent WebAuthn step-up assertion on mutating operator calls arriving via relay (checked against a passkey registered through pairing or the step-up verbs)',
  },
  {
    key: 'runtime.companionChat.closedRetentionDays',
    type: 'number',
    default: 0,
    description:
      'Days after a companion chat is closed before its saved files are deleted. ' +
      '0 (the default) keeps closed chats forever. Read on every cleanup pass, so a change applies without a restart.',
    ...intRange(0, 36_500),
  },
  {
    key: 'runtime.companionChatLimiter.perSessionLimit',
    type: 'number',
    default: 0,
    description:
      'Max companion chat messages per 60-second window per session. ' +
      '0 (the default) means unset: the GOODVIBES_CHAT_LIMITER_THRESHOLD env var (read once at daemon startup) applies, else 10. ' +
      'A positive integer overrides the env var and is read on each check() call.',
    ...intRange(0, 100_000),
  },
  {
    key: 'runtime.eventBus.maxListeners',
    type: 'number',
    default: 100,
    description:
      'Maximum number of listeners per event channel (per-type and per-domain) before a warning is emitted in production ' +
      'or a RangeError is thrown in development mode. Raise this only if you have verified there is no subscriber leak.',
    ...intRange(1, 100_000),
  },
  {
    key: 'runtime.maxParallelToolCalls',
    type: 'number',
    default: 8,
    description:
      'Most tool calls of one model response that run at the same time. Reads run side by side, and so do writes to files that do not overlap; ' +
      'a command, an action the owner decides and a tool with undeclared effects always run alone, in the order the model asked. 1 runs every call one after another. ' +
      'Applies to the main session, sub-agents and companion chat; read once per response.',
    ...intRange(1, 64),
  },
  {
    key: 'telemetry.includeRawPrompts',
    type: 'boolean',
    default: false,
    description:
      'Allow raw telemetry reads from this daemon while enabled. Default false rejects raw reads; safe views always redact content. ' +
      'HTTP raw reads also require read:telemetry and an admin session or read:telemetry-sensitive scope. Active raw streams stop after this opt-in is revoked. ' +
      'Raw prompts may contain private data. Enabling the setting at startup emits a WARN log.',
  },
  {
    key: 'telemetry.decisionOtlpEnabled',
    type: 'boolean',
    default: false,
    description: 'Export permission/policy decision-log records to an OTLP endpoint (export-only, no ingestion). Requires telemetry.decisionOtlpEndpoint',
  },
  {
    key: 'telemetry.decisionOtlpEndpoint',
    type: 'string',
    default: '',
    description: 'OTLP/HTTP JSON endpoint base for decision-log export (empty = disabled). Spans POST to <base>/v1/traces, logs to <base>/v1/logs',
  },
  {
    key: 'telemetry.decisionOtlpSignal',
    type: 'enum',
    default: 'span',
    description: 'Which OTLP record shape each decision is emitted as: span, log, or both',
    enumValues: ['span', 'log', 'both'],
  },
  {
    key: 'batch.mode',
    type: 'enum',
    default: 'off',
    description: 'Daemon provider Batch API mode. off: nothing is queued (the batch job API refuses with BATCH_DISABLED). explicit: the batch job API is open, and a non-streaming OpenAI-compatible chat completion is queued when it sends x-goodvibes-execution: batch. eligible-by-default: every non-streaming OpenAI-compatible chat completion whose provider has a Batch API is queued unless it sends x-goodvibes-execution: live (one whose provider cannot batch runs live as usual; batch.fallback applies only to an explicit batch request); a queued one is answered 202 with the job id and read back at <pathPrefix>/chat/completions/<id>. Streaming requests and terminal, companion and web chat always run live.',
    enumValues: ['off', 'explicit', 'eligible-by-default'],
  },
  {
    key: 'batch.fallback',
    type: 'enum',
    default: 'live',
    description: 'What a batch job does when its provider has no Batch API: live runs the request once, now, as an ordinary request and answers the job already finished; fail refuses the job. A job that asks for a live execution mode is refused either way: the batch API only queues.',
    enumValues: ['live', 'fail'],
  },
  {
    key: 'batch.queueBackend',
    type: 'enum',
    default: 'local',
    description: 'Queue backend for daemon batch signals. local stores jobs under the daemon config directory; cloudflare sends them through the provisioned Worker\'s queue. /cloudflare provision switches this to cloudflare only after the Worker reaches the daemon.',
    enumValues: ['local', 'cloudflare'],
  },
  {
    key: 'batch.tickIntervalMs',
    type: 'number',
    default: 60_000,
    description: 'Daemon-local batch scheduler tick interval in milliseconds. Read once when the scheduler starts: a new value applies after the next restart.',
    ...intRange(5_000, 60 * 60 * 1000),
  },
  {
    key: 'batch.maxDelayMs',
    type: 'number',
    default: 5 * 60 * 1000,
    description: 'Maximum time a queued local batch job should wait before the daemon submits its provider batch',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'batch.maxJobsPerProviderBatch',
    type: 'number',
    default: 100,
    description: 'Maximum platform jobs grouped into a single upstream provider batch submission',
    ...intRange(1, 100_000),
  },
  {
    key: 'batch.maxQueuePayloadBytes',
    type: 'number',
    default: 16 * 1024,
    description: 'Maximum Cloudflare queue message payload size in bytes; a larger cloudflare-queue job is refused (HTTP 413). Queue messages should be signals, not full prompt archives',
    ...intRange(1024, 128 * 1024),
  },
  {
    key: 'batch.maxQueueMessagesPerDay',
    type: 'number',
    default: 1_000,
    description: 'Daily Cloudflare queue message budget, enforced by the provisioned Worker (its Durable Object coordinator counts per UTC day): past it, the Worker answers 429 QUEUE_BUDGET_EXHAUSTED with the use so far and when it resets, and nothing more is queued. 0 means no limit. Takes effect at the next /cloudflare provision.',
    ...intRange(0, 10_000_000),
  },
  {
    key: 'cloudflare.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable optional Cloudflare Worker/Queue integration points. The daemon does not require Cloudflare when this is false.',
  },
  {
    key: 'cloudflare.freeTierMode',
    type: 'boolean',
    default: true,
    description: 'Keep job bodies out of Cloudflare Queues: the provisioned Worker stores each body in R2 and queues only its key, and refuses a job when R2 is not provisioned (409 QUEUE_PAYLOADS_NEED_R2). Off, a body up to batch.maxQueuePayloadBytes travels in the queue message. Takes effect at the next /cloudflare provision.',
  },
  {
    key: 'cloudflare.accountId',
    type: 'string',
    default: '',
    description: 'Cloudflare account id used by platform-owned Worker/Queue provisioning and by the cloudflare-ai-gateway provider (which falls back to CLOUDFLARE_ACCOUNT_ID when this is empty).',
  },
  {
    key: 'cloudflare.aiGatewayId',
    type: 'string',
    default: '',
    description: 'Cloudflare AI Gateway id the cloudflare-ai-gateway provider sends through (with cloudflare.accountId). If empty, the provider falls back to CLOUDFLARE_AI_GATEWAY_ID. A change to either id takes effect at once.',
  },
  {
    key: 'cloudflare.apiTokenRef',
    type: 'string',
    default: '',
    description: 'GoodVibes secret reference for the Cloudflare API token. If empty, the platform falls back to CLOUDFLARE_API_TOKEN.',
  },
  {
    key: 'cloudflare.zoneId',
    type: 'string',
    default: '',
    description: 'Optional Cloudflare zone id selected for platform-managed DNS and Zero Trust Access hostnames',
  },
  {
    key: 'cloudflare.zoneName',
    type: 'string',
    default: '',
    description: 'Optional Cloudflare zone name selected during discovery/onboarding when zone id is not known yet',
  },
  {
    key: 'cloudflare.workerName',
    type: 'string',
    default: 'goodvibes-batch-worker',
    description: 'Cloudflare Worker script name managed by GoodVibes provisioning',
    validate: (v) => typeof v === 'string' && (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(v) || v === ''),
  },
  {
    key: 'cloudflare.workerSubdomain',
    type: 'string',
    default: '',
    description: 'Cloudflare account workers.dev subdomain used to infer cloudflare.workerBaseUrl',
  },
  {
    key: 'cloudflare.workerHostname',
    type: 'string',
    default: '',
    description: 'Optional custom hostname for the GoodVibes Cloudflare Worker when DNS automation is enabled',
  },
  {
    key: 'cloudflare.workerBaseUrl',
    type: 'string',
    default: '',
    description: 'Optional deployed GoodVibes Cloudflare Worker base URL used by clients that proxy batch signals through Workers',
  },
  {
    key: 'cloudflare.daemonBaseUrl',
    type: 'string',
    default: '',
    description: 'Daemon origin URL the Cloudflare Worker or Tunnel uses for Worker-to-daemon batch calls',
  },
  {
    key: 'cloudflare.daemonHostname',
    type: 'string',
    default: '',
    description: 'Optional public daemon hostname managed through Cloudflare DNS, Tunnel, and Access provisioning',
  },
  {
    key: 'cloudflare.workerTokenRef',
    type: 'string',
    default: '',
    description: 'Optional GoodVibes secret reference for the Worker-to-daemon bearer token',
  },
  {
    key: 'cloudflare.workerClientTokenRef',
    type: 'string',
    default: '',
    description: 'Optional GoodVibes secret reference for the bearer token clients use when calling the Cloudflare Worker',
  },
  {
    key: 'cloudflare.workerCron',
    type: 'string',
    default: '*/5 * * * *',
    description: 'Cron trigger installed on the GoodVibes Cloudflare Worker for batch scheduler ticks',
  },
  {
    key: 'cloudflare.queueName',
    type: 'string',
    default: 'goodvibes-batch',
    description: 'Cloudflare Queue binding/name for GoodVibes batch job signals',
  },
  {
    key: 'cloudflare.deadLetterQueueName',
    type: 'string',
    default: 'goodvibes-batch-dlq',
    description: 'Cloudflare dead-letter queue binding/name for failed GoodVibes batch job signals',
  },
  {
    key: 'cloudflare.tunnelName',
    type: 'string',
    default: 'goodvibes-daemon',
    description: 'Zero Trust Tunnel name managed by GoodVibes provisioning when tunnel integration is enabled',
  },
  {
    key: 'cloudflare.tunnelId',
    type: 'string',
    default: '',
    description: 'Cloudflare Zero Trust Tunnel id selected or created by GoodVibes provisioning',
  },
  {
    key: 'cloudflare.tunnelTokenRef',
    type: 'string',
    default: '',
    description: 'GoodVibes secret reference for the cloudflared tunnel token generated by provisioning',
  },
  {
    key: 'cloudflare.accessAppId',
    type: 'string',
    default: '',
    description: 'Cloudflare Zero Trust Access application id protecting the GoodVibes daemon hostname',
  },
  {
    key: 'cloudflare.accessServiceTokenId',
    type: 'string',
    default: '',
    description: 'Id of the Cloudflare Zero Trust Access service token created for GoodVibes daemon access: the public half, sent beside the client secret, which is stored separately under cloudflare.accessServiceTokenRef',
  },
  {
    key: 'cloudflare.accessServiceTokenRef',
    type: 'string',
    default: '',
    description: 'GoodVibes secret reference storing Access service token client id/secret JSON',
  },
  {
    key: 'cloudflare.kvNamespaceName',
    type: 'string',
    default: 'goodvibes-runtime',
    description: 'Cloudflare KV namespace that records each queued job\'s delivery state (queued, delivered with the daemon job id, rejected), served by the Worker at /batch/queue/jobs/<id>, so a redelivered message is acknowledged without a second daemon call.',
  },
  {
    key: 'cloudflare.kvNamespaceId',
    type: 'string',
    default: '',
    description: 'Cloudflare KV namespace id used for the GoodVibes Worker binding',
  },
  {
    key: 'cloudflare.durableObjectNamespaceName',
    type: 'string',
    default: 'GoodVibesCoordinator',
    description: 'Cloudflare Durable Object class whose coordinator counts queue operations and messages per UTC day for the queue budgets; added automatically when a budget is set.',
  },
  {
    key: 'cloudflare.durableObjectNamespaceId',
    type: 'string',
    default: '',
    description: 'Cloudflare Durable Object namespace id, recorded by provisioning after the Worker migration (not an input).',
  },
  {
    key: 'cloudflare.r2BucketName',
    type: 'string',
    default: 'goodvibes-artifacts',
    description: 'Cloudflare R2 bucket that holds queued job bodies so queue messages carry only their key; a body is deleted once the daemon has the job.',
  },
  {
    key: 'cloudflare.secretsStoreName',
    type: 'string',
    default: 'goodvibes',
    description: 'Name of the Cloudflare Secrets Store that optional GoodVibes provisioning creates and manages (the store holds the secrets; this is its name)',
  },
  {
    key: 'cloudflare.secretsStoreId',
    type: 'string',
    default: '',
    description: 'Cloudflare Secrets Store id selected or created by GoodVibes provisioning',
  },
  {
    key: 'cloudflare.maxQueueOpsPerDay',
    type: 'number',
    default: 10_000,
    description: 'Daily Cloudflare queue operation budget, enforced by the provisioned Worker (its Durable Object coordinator counts per UTC day): past it, the Worker answers 429 QUEUE_BUDGET_EXHAUSTED with the use so far and when it resets. 0 means no limit. Takes effect at the next /cloudflare provision.',
    ...intRange(0, 10_000_000),
  },
];
