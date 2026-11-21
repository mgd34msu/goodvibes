import type { DecisionRouterSettings } from './decision-router-settings.js';
/**
 * Shared config schema types for goodvibes-platform.
 */
// The categories declared beside their defaults and rows. Imported here, never
// merged in by `declare module`, so GoodVibesConfig is one declaration that
// every consumer, published types included, sees whole.
import type { CheckpointsConfig } from './schema-domain-checkpoints.js';
import type { ClusterConfig } from './schema-domain-cluster.js';
import type { CalendarConnectorConfig, GoogleConnectorConfig } from './schema-types-connectors.js';
import type { ConversationGateSettings } from './schema-domain-conversation-gate.js';
import type { DeviceConfig } from './schema-domain-device.js';
import type { AgentsConfig, FetchConfig, IntegrationsConfig, PolicyConfig, SecurityConfig, WebSearchConfig } from './schema-domain-features.js';
import type { FleetConfig } from './schema-domain-fleet.js';
import type { HostedSessionsSettings } from './schema-domain-hosted-sessions.js';
import type { LearningConfig } from './schema-domain-learning.js';
import type { MemoryConfig } from './schema-domain-memory.js';
import type { OccasionsConfig } from './schema-types-occasions.js';
import type { OwnerProfileConfig } from './schema-types-owner-profile.js';
import type { PowerConfig } from './schema-domain-power.js';
import type { BrowserConfig } from './schema-domain-browser.js';
import type { PushConfig } from './schema-domain-push.js';
import type { CheckinConfig, WorktreeConfig } from './schema-domain-runtime.js';
import type { UpdateConfig } from './schema-domain-update.js';
import type { VoiceLocalConfig } from './schema-domain-voice-local.js';
import type { VoiceWakeConfig } from './schema-domain-voice-wake.js';


export * from "./schema-types-surfaces.js";
import type { InboundEmailCapabilityPolicy, InboundEmailMode, InboundEmailNoticeMode, InboundEmailSource, SurfacesConfig } from "./schema-types-surfaces.js";

export * from "./schema-types-network.js";
import type {
  ControlPlaneConfig,
  HttpListenerRuntimeConfig,
  NetworkConfig,
  RelayConfig,
  WebConfig,
} from "./schema-types-network.js";

export * from "./schema-types-platform.js";
import type {
  AtRestConfig,
  BatchConfig,
  BatchFallbackMode,
  BatchMode,
  BatchQueueBackend,
  CloudflareConfig,
  TelemetryConfig,
} from "./schema-types-platform.js";

export * from "./schema-types-permissions.js";
import type { LineNumberMode, PermissionAction, PermissionMode, PermissionsToolConfig } from "./schema-types-permissions.js";
export * from "./schema-types-payments.js";
import type { PaymentsConfig } from "./schema-types-payments.js";
import type { ContractSettings } from "./schema-types-contract.js";
import type { JudgmentSettings } from "./schema-types-judgment.js";

export * from "./schema-types-daemon.js";
import type {
  AutomationConfig,
  NotificationsConfig,
  RuntimeConfig,
  ServiceConfig,
  TtsConfig,
  WatchersConfig,
  DaemonProcessConfig,
} from "./schema-types-daemon.js";


export interface GoodVibesConfig {
  display: {
    stream: boolean;            // default: true
    lineNumbers: LineNumberMode; // default: 'off'
    collapseThreshold: number;  // default: 30
    theme: string;              // default: 'goodvibes'
    themeMode: 'auto' | 'dark' | 'light'; // default: 'auto'
    treeGlyphs: 'rounded' | 'square' | 'ascii'; // default: 'rounded'
    showThinking: boolean;      // default: false
    showReasoningSummary: boolean; // default: false
    showTokenSpeed: boolean;    // default: false
    showToolPreview: boolean;   // default: false
  };
  provider: {
    decisionRouter?: DecisionRouterSettings;
    reasoningEffort: string;    // default: 'medium'. Per-model levels, see providers/reasoning-effort.ts
    model: string;              // default: 'openrouter:openrouter/free'
    embeddingProvider: string;  // default: 'hashed-local'
    systemPromptFile: string;   // default: ''
    optimizerMode: 'off' | 'manual' | 'auto' | 'pinned'; // default: 'off'. Provider routing optimizer ('off' = optimizer inactive)
    optimizerPinnedModel: string; // default: ''. Provider-qualified model id applied when optimizerMode is 'pinned'
    visionFallbackModel: string; // default: ''. Model that reads an attached image when the session's model cannot
    fallbackModels: string[];   // default: []. The person's fallback order: models a failed turn moves to, in order
    localContextIngestion: boolean; // default: true. Ingest max_context_length from local/custom provider /v1/models
  };
  behavior: {
    autoApprove: boolean;       // default: false
    autoCompactThreshold: number; // default: 80
    compactionStrategy: 'off' | 'structured' | 'distiller'; // default: 'structured'. 'off' runs sessions uncompacted
    staleContextWarnings: boolean; // default: true
    saveHistory: boolean;       // default: true
    notifyOnComplete: boolean;  // default: true
    hitlMode: 'off' | 'quiet' | 'balanced' | 'operator'; // default: 'balanced'. 'off' keeps the baseline notification policy
    toolResultReconciliation: 'reconcile' | 'warn-only'; // default: 'reconcile'. Inject synthetic results for dangling tool calls at turn end
    returnContextMode: 'off' | 'local' | 'assisted'; // default: 'off'
    guidanceMode: 'off' | 'minimal' | 'guided'; // default: 'minimal'
  };
  storage: {
    secretPolicy: 'plaintext_allowed' | 'preferred_secure' | 'require_secure'; // default: 'preferred_secure'
    artifacts: {
      maxBytes: number;          // default: 512 MiB
    };
    /** How this machine runs each password manager a secret reference names; never set by a reference itself. */
    secretProviders: {
      onePasswordCli: string;
      bitwardenCli: string;
      bitwardenAppDataDir: string;
      bitwardenSessionEnv: string;
      bwsCli: string;
      bwsAccessTokenEnv: string;
      bwsConfigFile: string;
      bwsServerUrl: string;
    };
  };
  permissions: {
    mode: PermissionMode;       // default: 'prompt'
    tools: PermissionsToolConfig;
    engine: 'baseline' | 'policy-engine'; // default: 'baseline'. Layered tool/path policy evaluator (restart to apply)
    simulation: boolean;        // default: true. Dual-evaluator shadow pipeline recording divergence (restart to apply)
    divergenceDashboard: boolean; // default: true. Divergence aggregation + enforce-mode gate
    commandParser: 'ast' | 'flat'; // default: 'ast'. ast refuses a command with an empty segment before it runs; flat skips that parse
    divergenceThreshold: number; // default: 0.05. Divergence-gate max divergence rate
    maxDivergenceRecords: number; // default: 500. Retained divergence records for the simulation dashboard
  };
  diagnostics: {
    postEdit: 'on' | 'off';     // default: 'on'. Cheap in-process post-edit syntax diagnostics
  };
  orchestration: {
    recursionEnabled: boolean;  // default: false. Allow recursive agent spawning under bounded policy
    maxDepth: number;           // default: 0. No depth limit; recursionEnabled still controls delegation
  };
  planner: {
    decomposition: 'agent' | 'heuristic';  // default: 'agent'. 'heuristic' forces the old single-item path
    maxTurns: number;                       // default: 0 (unlimited). Optional planner turn ceiling
    tokenCeiling: number;                   // default: 0 (unlimited). Optional planner token budget
    wallTimeoutMs: number;                  // default: 0 (unlimited). Optional planner wall-clock timeout
    adaptive: boolean;                      // default: false. Score single/cohort/background/remote strategies each turn
  };
  sandbox: {
    // Per-command exec sandbox (bubblewrap). enabled is the operator switch
    // (default true; honestly unavailable where bubblewrap is absent).
    // egressAllowlist and workspaceWritable are arrays (accessed via
    // getCategory('sandbox')), not scalar ConfigKeys.
    enabled: boolean;
    // Model-judgment pass on the residual sandbox ask-tail: off, annotate
    // (default, annotates the human ask, never decides), or auto-approve
    // (additionally auto-approves looks-safe verdicts; explicit opt-in).
    judgment: 'off' | 'annotate' | 'auto-approve';
    egressAllowlist: string[];
    workspaceWritable: string[];
    mcpIsolation: 'disabled' | 'contained';
  };
  ui: {
    voiceEnabled: boolean;
    systemMessages: 'panel' | 'conversation' | 'both';
    operationalMessages: 'panel' | 'conversation' | 'both';
    contractMessages: 'panel' | 'conversation' | 'both';
  };
  tts: TtsConfig;
  automation: AutomationConfig;
  controlPlane: ControlPlaneConfig;
  httpListener: HttpListenerRuntimeConfig;
  web: WebConfig;
  surfaces: SurfacesConfig;
  watchers: WatchersConfig;
  service: ServiceConfig;
  network: NetworkConfig;
  relay: RelayConfig;
  daemon: { enabled: boolean; timezone: string; connectedHost: { enabled: boolean; url: string } };
  payments: PaymentsConfig;
  contract: ContractSettings;
  judgment: JudgmentSettings;
    // default: enabled true, run the local session daemon (loopback only); timezone '', IANA name the daemon reckons calendar days in, empty means UTC
  danger: {
    httpListener: boolean;          // default: false. Enable HTTP webhook listener
  };
  tools: {
    llmEnabled: boolean;            // default: false. Enable dedicated tool LLM for internal operations
    llmProvider: string;            // default: ''. Provider for tool LLM calls (empty = use current)
    llmModel: string;               // default: ''. Model for tool LLM calls (empty = fastest available)
    autoHeal: boolean;              // default: false. Repair a write/edit that fails validation: project formatter, linter fix, then model
    defaultTokenBudget: number;     // default: 0. No automatic token budget for read operations
    hooksFile: string;              // default: 'hooks.json'. Hook configuration file name
    overflowSpillBackend: 'file' | 'ledger' | 'diagnostics'; // default: 'file'. Where overflow content spills
    outputSchemaFingerprints: boolean; // default: false. Append _meta schema fingerprints to find/analyze/inspect results
    /** Commands write/edit validate runs for a project that declares none of its own; '' = none. */
    validators: {
      typecheck: string;
      lint: string;
      test: string;
      build: string;
    };
  };
  cache: {
    enabled: boolean;                    // default: true
    stableTtl: '5m' | '1h';          // default: '1h' (for stable content like system+tools)
    monitorHitRate: boolean;             // default: true
    hitRateWarningThreshold: number;     // default: 0.3
  };
  helper: {
    enabled: boolean;                    // default: false
    globalProvider: string;              // default: ''
    globalModel: string;                 // default: ''
    // Per-provider overrides accessed via configManager.getCategory('helper').providers
  };
  notifications: NotificationsConfig;
  runtime: RuntimeConfig;
  telemetry: TelemetryConfig;
  atRest: AtRestConfig;
  batch: BatchConfig;
  cloudflare: CloudflareConfig;
  pricing: PricingConfig;
  checkpoints: CheckpointsConfig;
  cluster: ClusterConfig;
  calendar: CalendarConnectorConfig;
  google: GoogleConnectorConfig;
  conversationGate: ConversationGateSettings;
  device: DeviceConfig;
  fetch: FetchConfig;
  webSearch: WebSearchConfig;
  security: SecurityConfig;
  integrations: IntegrationsConfig;
  policy: PolicyConfig;
  agents: AgentsConfig;
  fleet: FleetConfig;
  hostedSessions: HostedSessionsSettings;
  learning: LearningConfig;
  memory: MemoryConfig;
  occasions: OccasionsConfig;
  profile: OwnerProfileConfig;
  power: PowerConfig;
  browser: BrowserConfig;
  push: PushConfig;
  worktree: WorktreeConfig;
  checkin: CheckinConfig;
  update: UpdateConfig;
  voice: VoiceLocalConfig & VoiceWakeConfig;
}

/** One user-set manual model price, USD per 1M tokens. */
export interface ManualModelPriceConfig {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

/** Pricing domain, manual model prices keyed `provider:model`. */
export interface PricingConfig {
  modelPrices: Record<string, ManualModelPriceConfig>;
}

/**
 * When a change to a setting takes effect, stated only where the code that
 * reads it was checked: `now` (the next screen or event reads it), `next-answer`
 * (read when a turn starts), `next-session` (read when a session starts),
 * `restart` (read once when the program starts).
 */
export type SettingAppliesWhen = 'now' | 'next-answer' | 'next-session' | 'restart';

export interface ConfigSetting {
  key: ConfigKey;
  /**
   * The setting's name in the words a person would use ("Show the model's
   * thinking"): the primary text of every settings row. The key is shown only
   * as small secondary text.
   */
  label: string;
  /** When a change takes effect; absent where that was not verified in the reader. */
  appliesWhen?: SettingAppliesWhen | undefined;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'object';
  default: unknown;
  description: string;
  /** Retained for saved-config compatibility, excluded from current settings controls. */
  deprecated?: boolean;
  enumValues?: string[] | undefined;
  validate?: ((value: unknown) => boolean) | undefined;
  /** Hint appended to the validation-failure message when `validate` returns false, e.g. `'finite number in [0.25, 4.0]'`. */
  validationHint?: string | undefined;
  /**
   * What kind of quantity a numeric key holds, when knowing that changes how a
   * value is read or shown.
   *
   * `'money'` marks a key holding an amount of `payments.currency`, written the
   * way a person says it (`100`, `19.99`). Consumers ask the SCHEMA for this
   * mark rather than pattern-matching the key's NAME: the previous scheme
   * encoded the unit in a name suffix, which tied every surface that touched
   * one of these keys to that spelling. See ./money-value.ts.
   */
  unit?: 'money' | undefined;
  /** What a port number addresses: a port this machine binds, or a remote server's (schema-shared.ts `port()` / `remotePort()`). */
  role?: 'listen-port' | 'remote-port' | undefined;
  /**
   * True when `validate` accepts only values whose every part this setting
   * describes: no field, key or element of a kind it does not know. A value
   * that validates is then covered by this setting's declaration down to its
   * leaves. Without it the leaves of an object or list value are classified on
   * their own (for example when redacting a support bundle).
   */
  closedShape?: true | undefined;
}

/**
 * Settings whose value is one object, read and written whole, rather than a
 * section of further keys. Every other object in GoodVibesConfig is a section.
 */
type ObjectValuedConfigKey = 'provider.decisionRouter' | 'judgment.volumeMonitor' | 'judgment.backend';

/**
 * The dot paths of every leaf of `T`: a scalar, a list (or a value that may be
 * one, like a worktree setup list or its `{ mode }`), a map keyed by any
 * string, or an object-valued setting. Optional fields are keys like the rest.
 */
type ConfigLeafPaths<T, Prefix extends string> = {
  [Name in keyof T & string]-?: `${Prefix}${Name}` extends ObjectValuedConfigKey
    ? `${Prefix}${Name}`
    : [Extract<Exclude<T[Name], undefined>, readonly unknown[]>] extends [never]
      ? Exclude<T[Name], undefined> extends object
        ? string extends keyof Exclude<T[Name], undefined>
          ? `${Prefix}${Name}`
          : ConfigLeafPaths<Exclude<T[Name], undefined>, `${Prefix}${Name}.`>
        : `${Prefix}${Name}`
      : `${Prefix}${Name}`;
}[keyof T & string];

/**
 * Dot-path config keys for all settings, derived from GoodVibesConfig: the
 * interfaces are the one declaration of which settings exist and what each
 * holds, so adding a field there adds its key, and a key that names no field
 * is a compile error wherever it is used.
 */
export type ConfigKey = Extract<ConfigLeafPaths<GoodVibesConfig, ''>, string>;

export * from "./schema-types-values.js";

/**
 * One default per setting: each row's default is read from the defaults object
 * (the owner) by the row's key path. A row whose key has no value there is a
 * programming error and fails at module load, so every setting has exactly one
 * default and nothing restates it.
 */
/** A settings row as a domain writes it: everything but its default, which its defaults object owns. */
export type ConfigSettingRow = Omit<ConfigSetting, 'default'>;

export function defineSettingsDomain<D extends object>(defaults: D, rows: readonly ConfigSettingRow[]): ConfigSetting[] {
  return rows.map((row) => {
    let value: unknown = defaults;
    for (const part of row.key.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
        throw new Error(`Setting ${row.key} has no default in its defaults object; add it there (one default per setting).`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    return { ...row, default: value } as ConfigSetting;
  });
}
