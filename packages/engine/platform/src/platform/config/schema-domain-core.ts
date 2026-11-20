import type { ConfigSetting } from './schema-types.js';
import { DEFAULT_DECISION_ROUTER_SETTINGS, validDecisionRouterSettings } from './decision-router-settings.js';
import { type ConfigSettingDefinition, intRange, numRange, optionalWorkLimit, reasoningEffortSetting } from './schema-shared.js';
import { parseDaemonOrigin } from './control-plane-base-url.js';

export const coreConfigDefaults = {
  display: {
    stream: true,
    lineNumbers: 'off',
    collapseThreshold: 30,
    theme: 'goodvibes',
    themeMode: 'auto',
    treeGlyphs: 'rounded',
    showThinking: false,
    showReasoningSummary: false,
    showTokenSpeed: false,
    showToolPreview: false,
  },
  provider: {
    decisionRouter: DEFAULT_DECISION_ROUTER_SETTINGS,
    reasoningEffort: 'medium',
    model: 'openrouter:openrouter/free',
    embeddingProvider: 'hashed-local',
    systemPromptFile: '',
    optimizerMode: 'off',
    optimizerPinnedModel: '',
    visionFallbackModel: '',
    fallbackModels: [] as string[],
    localContextIngestion: true,
  },
  behavior: {
    autoApprove: false,
    autoCompactThreshold: 80,
    compactionStrategy: 'structured',
    staleContextWarnings: true,
    saveHistory: true,
    notifyOnComplete: true,
    hitlMode: 'balanced',
    toolResultReconciliation: 'reconcile',
    returnContextMode: 'off',
    guidanceMode: 'minimal',
  },
  storage: {
    secretPolicy: 'preferred_secure',
    artifacts: {
      maxBytes: 512 * 1024 * 1024,
    },
    secretProviders: {
      onePasswordCli: '',
      bitwardenCli: '',
      bitwardenAppDataDir: '',
      bitwardenSessionEnv: '',
      bwsCli: '',
      bwsAccessTokenEnv: '',
      bwsConfigFile: '',
      bwsServerUrl: '',
    },
  },
  permissions: {
    mode: 'jev-decides',
    engine: 'baseline',
    simulation: true,
    divergenceDashboard: true,
    commandParser: 'ast',
    divergenceThreshold: 0.05,
    maxDivergenceRecords: 500,
    tools: {
      read: 'allow',
      write: 'prompt',
      edit: 'prompt',
      exec: 'prompt',
      find: 'allow',
      fetch: 'prompt',
      analyze: 'allow',
      inspect: 'allow',
      agent: 'prompt',
      state: 'allow',
      workflow: 'prompt',
      registry: 'allow',
      delegate: 'prompt',
      mcp: 'prompt',
    },
  },
  diagnostics: {
    postEdit: 'on',
  },
  orchestration: {
    recursionEnabled: false,
    maxDepth: 0,
  },
  planner: {
    decomposition: 'agent',
    maxTurns: 0,
    tokenCeiling: 0,
    wallTimeoutMs: 0,
    adaptive: false,
  },
  sandbox: {
    enabled: true,
    judgment: 'annotate',
    egressAllowlist: [] as string[],
    workspaceWritable: [] as string[],
    mcpIsolation: 'disabled',
  },
  ui: {
    voiceEnabled: false,
    systemMessages: 'panel',
    operationalMessages: 'panel',
    contractMessages: 'both',
  },
  tts: {
    provider: 'elevenlabs',
    voice: '',
    llmProvider: '',
    llmModel: '',
    speed: 1.0,
  },
  daemon: {
    enabled: true,
    timezone: '',
    connectedHost: {
      enabled: true,
      url: '',
    },
  },
  danger: {
    httpListener: false,
  },
  tools: {
    llmEnabled: false,
    llmProvider: '',
    llmModel: '',
    autoHeal: false,
    defaultTokenBudget: 0,
    hooksFile: 'hooks.json',
    overflowSpillBackend: 'file',
    outputSchemaFingerprints: false,
    validators: {
      typecheck: '',
      lint: '',
      test: '',
      build: '',
    },
  },
  cache: {
    enabled: true,
    stableTtl: '1h',
    monitorHitRate: true,
    hitRateWarningThreshold: 0.3,
  },
  helper: {
    enabled: false,
    globalProvider: '',
    globalModel: '',
  },
  notifications: {
    webhookUrls: [],
    adaptiveSuppression: true,
    burstThreshold: 3,
    pushApproval: true,
    pushNeedsInput: true,
    pushCompletion: true,
    blockedEscalationGraceMs: 5 * 60 * 1000,
    blockedEscalationFollowUpMs: 5 * 60 * 1000,
    blockedEscalationMaxFollowUps: 2,
  },
};

export const coreHeadConfigSettings: (ConfigSettingDefinition | ConfigSetting)[] = [
  {
    key: 'display.stream',
    type: 'boolean',
    description: 'Stream LLM tokens as they arrive',
  },
  {
    key: 'display.lineNumbers',
    type: 'enum',
    description: 'Show line numbers for all assistant output, code blocks only, or not at all',
    enumValues: ['all', 'code', 'off'],
  },
  {
    key: 'display.collapseThreshold',
    type: 'number',
    description: 'Line count threshold for collapsing tool output',
    ...numRange(1, 1000),
  },
  {
    key: 'display.theme',
    type: 'enum',
    description: 'Color theme name, the color palette (e.g. goodvibes-neon). Independent of display.themeMode, which controls light/dark appearance.',
    // Literal on purpose: no registry access at module scope in compiled bundles.
    // Functional tests pin these choices to the runtime catalog plus its two special names.
    enumValues: ['goodvibes', 'goodvibes-neon', 'catppuccin', 'tokyonight', 'dracula', 'nord', 'gruvbox',
      'one-dark', 'rosepine', 'solarized', 'github', 'system'],
  },
  {
    key: 'display.themeMode',
    type: 'enum',
    description: 'Light/dark appearance: auto probes the terminal background colour (OSC 11) once at startup and picks light or dark; dark/light force a fixed appearance regardless of terminal background. Independent of display.theme, which picks the color palette.',
    enumValues: ['auto', 'dark', 'light'],
  },
  {
    key: 'display.treeGlyphs',
    type: 'enum',
    description: 'Work tree connector style: rounded, square or ASCII. Terminals without Unicode support always use ASCII.',
    enumValues: ['rounded', 'square', 'ascii'],
  },
  {
    key: 'display.showThinking',
    type: 'boolean',
    description: 'Show reasoning/thinking content in a dimmed block above assistant responses',
  },
  {
    key: 'display.showReasoningSummary',
    type: 'boolean',
    description: 'Show reasoning summary (Mercury-2) in a dimmed block above assistant responses',
  },
  {
    key: 'display.showTokenSpeed',
    type: 'boolean',
    description: 'Show streaming tokens/sec counter during generation',
  },
  {
    key: 'display.showToolPreview',
    type: 'boolean',
    description: 'Show partial tool call preview while streaming',
  },
  {
    key: 'provider.decisionRouter',
    type: 'object',
    description: 'Decision Router category descriptions and answer provider/model/effort targets. Used only when decision-router:auto is selected. Empty categories use the required General target. Contains no credentials.',
    validate: validDecisionRouterSettings,
    closedShape: true,
  },
  {
    key: 'provider.reasoningEffort',
    type: 'string',
    description: 'Reasoning effort level for models that support it',
    ...reasoningEffortSetting(),
  },
  {
    key: 'provider.model',
    type: 'string',
    description: 'Default provider-qualified LLM model registry key',
    validate: (v) => {
      if (typeof v !== 'string') return false;
      const separator = v.trim().indexOf(':');
      return separator > 0 && separator < v.trim().length - 1;
    },
  },
  {
    key: 'provider.embeddingProvider',
    type: 'string',
    description: 'Default memory embedding provider',
  },
  {
    key: 'provider.systemPromptFile',
    type: 'string',
    description: 'Path to a file containing the system prompt (empty = none)',
  },
  {
    key: 'provider.optimizerMode',
    type: 'enum',
    description:
      'Provider routing optimizer: off (optimizer inactive, default), manual (optimizer active but never auto-routes), auto (selects the best capable provider per request via capability contracts), or pinned (force one model, see provider.optimizerPinnedModel). Applies at once from any settings path; /provider-opt commands write this setting.',
    enumValues: ['off', 'manual', 'auto', 'pinned'],
  },
  {
    key: 'provider.optimizerPinnedModel',
    type: 'string',
    description:
      'Provider-qualified model id (e.g. anthropic:claude-sonnet-4) the provider optimizer routes to while provider.optimizerMode is "pinned"; a change applies at once. Empty leaves the optimizer unpinned (falls back to manual).',
  },
  {
    key: 'provider.visionFallbackModel',
    type: 'string',
    description:
      'Model (provider-qualified, e.g. openai:gpt-4o, or a unique bare id) that reads an image you attach when the current model cannot accept images. Empty (default): such an image is refused and sent nowhere, and the refusal names the models that can read it. Setting this sends those images to the named model\'s provider.',
  },
  {
    key: 'behavior.autoApprove',
    deprecated: true,
    type: 'boolean',
    description: 'Auto-approve all tool permission requests (--no-worries-just-vibes)',
  },
  {
    key: 'behavior.autoCompactThreshold',
    type: 'number',
    description: 'Compact conversation when context usage exceeds this percentage',
    ...numRange(10, 100),
  },
  {
    key: 'behavior.compactionStrategy',
    type: 'enum',
    description: 'Session compaction: off (sessions run uncompacted), structured (in-place summarization with semantic chunking and relevance scoring, default), or distiller (fresh model call producing a continuation brief; falls back to structured below the quality floor and the receipt names any fallback). behavior.autoCompactThreshold sets when compaction triggers.',
    enumValues: ['off', 'structured', 'distiller'],
  },
  {
    key: 'behavior.staleContextWarnings',
    type: 'boolean',
    description: 'Emit proactive context-pressure warnings before compaction is required',
  },
  {
    key: 'behavior.saveHistory',
    type: 'boolean',
    description: 'Persist conversation history to disk',
  },
  {
    key: 'behavior.notifyOnComplete',
    type: 'boolean',
    description: 'Emit terminal bell and desktop notification when a long turn completes',
  },
  {
    key: 'behavior.returnContextMode',
    type: 'enum',
    description: 'Resume summary mode: off, local deterministic summary, or helper-assisted summary',
    enumValues: ['off', 'local', 'assisted'],
  },
  {
    key: 'behavior.guidanceMode',
    type: 'enum',
    description: 'Operational guidance mode: off, minimal, or guided',
    enumValues: ['off', 'minimal', 'guided'],
  },
  {
    key: 'storage.secretPolicy',
    type: 'enum',
    description: 'Secret persistence policy: plaintext allowed, preferred secure, or require secure',
    enumValues: ['plaintext_allowed', 'preferred_secure', 'require_secure'],
  },
  {
    key: 'storage.artifacts.maxBytes',
    type: 'number',
    description: 'Maximum stored artifact size for file, URL, multipart, and raw upload ingest in bytes',
    ...intRange(1 * 1024 * 1024, 10 * 1024 * 1024 * 1024),
  },
  {
    key: 'storage.secretProviders.onePasswordCli',
    type: 'string',
    description: 'The 1Password CLI program to run for op:// and 1password references. Empty runs `op` from your PATH.',
  },
  {
    key: 'storage.secretProviders.bitwardenCli',
    type: 'string',
    description: 'The Bitwarden CLI program to run for bitwarden and vaultwarden references. Empty runs `bw` from your PATH.',
  },
  {
    key: 'storage.secretProviders.bitwardenAppDataDir',
    type: 'string',
    description: "The Bitwarden CLI data directory (BITWARDENCLI_APPDATA_DIR) for bitwarden and vaultwarden references, for example a separate login for GoodVibes. Empty uses the CLI's own.",
  },
  {
    key: 'storage.secretProviders.bitwardenSessionEnv',
    type: 'string',
    description: 'The environment variable holding your unlocked Bitwarden session, passed to the CLI as BW_SESSION. Empty passes BW_SESSION through as it is.',
  },
  {
    key: 'storage.secretProviders.bwsCli',
    type: 'string',
    description: 'The Bitwarden Secrets Manager CLI program to run for bws references. Empty runs `bws` from your PATH.',
  },
  {
    key: 'storage.secretProviders.bwsAccessTokenEnv',
    type: 'string',
    description: 'The environment variable holding your Bitwarden Secrets Manager access token, passed to the CLI as BWS_ACCESS_TOKEN. Empty passes BWS_ACCESS_TOKEN through as it is.',
  },
  {
    key: 'storage.secretProviders.bwsConfigFile',
    type: 'string',
    description: "The Bitwarden Secrets Manager CLI config file. Empty uses the CLI's own.",
  },
  {
    key: 'storage.secretProviders.bwsServerUrl',
    type: 'string',
    description: "The Bitwarden Secrets Manager server the CLI talks to, for a self-hosted server. Empty uses the CLI's own.",
  },
  {
    key: 'permissions.mode',
    type: 'enum',
    description: 'Who decides what ordinary work does not settle. ask-me: you are asked about dangerous actions and owner-only decisions. '
      + 'jev-decides (default): Jev, the decision model, decides judgment calls and you are asked only owner-only decisions; '
      + 'with no working decision model it behaves as ask-me, and while it is only the default (not chosen) it also does until a calibration run has measured Jev\'s decisions on the configured decision model. just-vibes: does as much as it can without interrupting you; '
      + 'Jev decides judgment calls when a decision model works, and anything that needs you is held and listed at the end. '
      + 'yolo: runs every action without safety denials (containment, secret storage and payment limits still apply). '
      + 'plan is a separate read-only planning posture.',
    enumValues: ['ask-me', 'jev-decides', 'just-vibes', 'yolo', 'plan'],
  },
  {
    key: 'permissions.divergenceThreshold',
    type: 'number',
    description:
      'Maximum permission-evaluator divergence rate (0.0–1.0) the permission-divergence-dashboard enforce gate tolerates before blocking a transition from simulation to enforce mode. Default 0.05 = 5%. A per-simulator divergenceThreshold override still wins.',
    ...numRange(0, 1),
  },
  {
    key: 'permissions.maxDivergenceRecords',
    type: 'number',
    description:
      'Maximum divergence records the permissions simulator retains for the divergence dashboard/trend history. A per-simulator maxDivergenceRecords override still wins.',
    ...intRange(1, 1_000_000),
  },
  {
    key: 'diagnostics.postEdit',
    type: 'enum',
    description:
      'Post-edit diagnostics: after a successful file write/edit, append cheap, '
      + 'in-process syntax diagnostics (errors only) for the touched file to the tool '
      + 'result so the model sees a broken edit immediately. on (default): run the '
      + 'tree-sitter syntax provider when a TS/JS project context is detectable (no '
      + 'process spawn, no type checking). off: never append diagnostics.',
    enumValues: ['on', 'off'],
  },
  {
    key: 'permissions.tools.read',
    type: 'enum',
    description: 'Permission for the read tool only; find and analyze have their own settings below. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.write',
    type: 'enum',
    description: 'Permission for file write operations, and for changing settings through the goodvibes_settings tool. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.edit',
    type: 'enum',
    description: 'Permission for file edit/patch operations. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.exec',
    type: 'enum',
    description: 'Permission for shell command execution. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.find',
    type: 'enum',
    description: 'Permission for file/directory search operations. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.fetch',
    type: 'enum',
    description: 'Permission for outbound network fetch requests. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.analyze',
    type: 'enum',
    description: 'Permission for code/project analysis operations. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.inspect',
    type: 'enum',
    description: 'Permission for inspecting runtime state and objects. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.agent',
    type: 'enum',
    description: 'Permission for spawning subagents or delegating tasks. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.state',
    type: 'enum',
    description: 'Permission for reading runtime/session state. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.workflow',
    type: 'enum',
    description: 'Permission for executing multi-step workflow automation. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.registry',
    type: 'enum',
    description: 'Permission for querying the tool/skill registry. deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.mcp',
    type: 'enum',
    description: 'Permission for MCP tool calls (external server tools). deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.delegate',
    type: 'enum',
    description: 'Permission for unknown or unregistered tools (safe default: prompt). deny refuses this tool in every mode but yolo. prompt sets no rule of its own: the execution mode decides each call, and ask-me runs a read, or a change to files inside the workspace that can be undone, without asking. allow also runs this tool without asking when no decision model works, except an owner-only decision.',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'orchestration.recursionEnabled',
    type: 'boolean',
    description: 'Allow recursive agent orchestration under bounded policy controls',
  },
  {
    key: 'orchestration.maxDepth',
    type: 'number',
    description: 'Optional recursive orchestration depth limit; 0 is unlimited. recursionEnabled controls whether recursion is allowed.',
    ...optionalWorkLimit(),
  },
  {
    key: 'planner.decomposition',
    type: 'enum',
    description: "How /workstream decomposes a goal into work items: 'agent' spawns a read-only planning agent (with automatic fallback to the heuristic path on any failure); 'heuristic' forces the deterministic single-item path and never spawns an agent",
    enumValues: ['agent', 'heuristic'],
  },
  {
    key: 'planner.maxTurns',
    type: 'number',
    description: 'Optional planner turn limit; 0 runs until completion or cancellation.',
    ...optionalWorkLimit(),
  },
  {
    key: 'planner.tokenCeiling',
    type: 'number',
    description: 'Optional total planner token limit; 0 imposes no work budget.',
    ...optionalWorkLimit(),
  },
  {
    key: 'planner.wallTimeoutMs',
    type: 'number',
    description: 'Optional planner wall-clock limit in milliseconds; 0 runs until completion or cancellation.',
    ...optionalWorkLimit(),
  },
  {
    key: 'sandbox.enabled',
    type: 'boolean',
    description:
      'Master switch for the per-command exec sandbox (bubblewrap on Linux): the workspace is writable, the rest of the filesystem is read-only, /tmp is isolated, and network is disabled unless a command is on sandbox.egressAllowlist. Default ON where the host probe passes; honestly reported unavailable when bubblewrap is not present, leaving the exec path unchanged. Turning it on takes effect at the next start (the host is probed then); sandbox.egressAllowlist and sandbox.workspaceWritable apply from the next command.',
  },
  {
    key: 'sandbox.judgment',
    type: 'enum',
    description: 'Model-judgment pass on sandbox escalation asks: off (plain asks), annotate (default, a proposed verdict with stated reasons annotates the ask, the human still decides), or auto-approve (additionally auto-approves looks-safe verdicts; explicit opt-in). Never auto-denies and never touches the frozen catastrophic block; every judgment leaves a receipt.',
    enumValues: ['off', 'annotate', 'auto-approve'],
  },
  {
    key: 'sandbox.mcpIsolation',
    type: 'enum',
    description: 'How stdio MCP servers start: disabled runs each as a host process; contained runs each inside its own bubblewrap boundary (workspace and sandbox.workspaceWritable writable, system files and the server\'s own install read-only, $HOME and /tmp private, host network shared). On a host without bubblewrap a contained server is not started and its status says why. Applies when a server next connects.',
    enumValues: ['disabled', 'contained'],
  },
  {
    key: 'ui.voiceEnabled',
    type: 'boolean',
    description: 'Enable the optional local-first voice control surface',
  },
  {
    key: 'ui.systemMessages',
    type: 'enum',
    description: 'Where operational system messages render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
  {
    key: 'tts.provider',
    type: 'string',
    description: 'Default TTS provider used by spoken-output clients when no provider is supplied on the request',
  },
  {
    key: 'tts.voice',
    type: 'string',
    description: 'Default TTS voice id used by spoken-output clients when no voice is supplied on the request',
  },
  {
    key: 'tts.llmProvider',
    type: 'string',
    description: 'Optional LLM provider override for spoken-output turns; empty means use the active chat provider',
  },
  {
    key: 'tts.llmModel',
    type: 'string',
    description: 'Optional LLM model override for spoken-output turns; empty means use the active chat model',
  },
  {
    key: 'tts.speed',
    type: 'number',
    description: 'Playback speed multiplier for TTS synthesis (0.25–4.0); 1.0 is normal speed',
    ...numRange(0.25, 4.0),
  },
  {
    key: 'ui.operationalMessages',
    type: 'enum',
    description: 'Where tool, agent, MCP, plugin, and other operational activity messages render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
  {
    key: 'ui.contractMessages',
    type: 'enum',
    description: 'Where contract lifecycle updates (status, checks, corrections, owner questions, the outcome) render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
];

export const coreTailConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'daemon.enabled',
    type: 'boolean',
    description:
      'Whether THIS surface ADOPTS a session daemon of its own, the background service hosting the shared session broker and companion chat, bound to loopback (127.0.0.1). On (the default), the surface looks for one and adopts it. Off, it makes no adoption attempt and probes no port. It does not control the daemon process itself: a daemon started on its own runs regardless of this setting, which is a per-surface choice about adopting one. It is also NOT the switch for talking to a daemon this surface is already connected to, that is daemon.connectedHost.enabled, and the two were one key until they were split apart.',
  },
  {
    key: 'daemon.connectedHost.enabled',
    type: 'boolean',
    description:
      'Whether this surface may DIAL the daemon it is connected to. On (the default), the features that reach a connected host work: the session-inputs poll that delivers inbound messages, conversation rewind registration, the live approvals stream, daemon-routed conversation turns, and the operator verbs. Off, each of those refuses plainly rather than failing at a connection. This is separate from daemon.enabled on purpose: adopting a daemon of your own and talking to one that is already there are different decisions, and while they shared a single key, turning adoption off silently stopped the inputs poll, the approvals stream and rewind registration on machines whose connected host was live and answering, the session and memory spines kept dialing the same host perfectly well, which is how the split showed itself.',
  },
  {
    key: 'daemon.connectedHost.url',
    type: 'string',
    description:
      'Where the terminal (goodvibes) dials its daemon, as an origin such as http://10.0.0.7:3421. Empty (the default) means the daemon on this machine, at the address derived from controlPlane.hostMode, controlPlane.host and controlPlane.port; those settings describe only how a local daemon listens. Setup\'s "Connect to an existing daemon" writes this, so finishing setup or changing the local bind does not move the terminal off the daemon it connected to. Clear it to go back to the daemon on this machine.',
    validate: (value: unknown): boolean => typeof value === 'string' && (value.trim().length === 0 || parseDaemonOrigin(value) !== null),
    validationHint: 'empty, or an http(s) origin with no path, user name or password, e.g. http://10.0.0.7:3421',
  },
  {
    key: 'danger.httpListener',
    type: 'boolean',
    description: 'Enable HTTP webhook listener for receiving external events',
  },
  {
    key: 'tools.llmEnabled',
    type: 'boolean',
    description: 'Enable dedicated tool LLM for internal operations (off = tools use the main conversation model only when needed)',
  },
  {
    key: 'tools.llmProvider',
    type: 'string',
    description: 'Provider for tool LLM calls (empty = use currently selected provider)',
  },
  {
    key: 'tools.llmModel',
    type: 'string',
    description: 'Model for tool LLM calls (empty = fastest available for the provider)',
  },
  {
    key: 'tools.autoHeal',
    type: 'boolean',
    description: 'When a write or edit fails validation, try the project\'s own formatter, then its linter fix, then a model repair, each from the content as written; a repair is kept only when it fixes the errors and changes nothing else',
  },
  {
    key: 'tools.defaultTokenBudget',
    type: 'number',
    description: 'Optional token budget for precision read operations; 0 includes the complete result',
    ...optionalWorkLimit(),
  },
  {
    key: 'tools.hooksFile',
    type: 'string',
    description: 'Hook configuration file name, relative to the project working directory (so the default is <project>/hooks.json, not a file under .goodvibes)',
  },
  {
    key: 'tools.validators.typecheck',
    type: 'string',
    description: 'Command the write and edit tools run for validate "typecheck" in a project that declares no typecheck command of its own (no package.json script, Cargo or Go toolchain, Makefile target or pyproject tool), e.g. "pnpm -r typecheck" for a monorepo whose scripts live in its packages. Split like a shell command line, without pipes or substitution, and run through the exec tool\'s own path. Your own settings only: a project settings file cannot set a command. Empty: the validator is refused with what the project does declare.',
  },
  {
    key: 'tools.validators.lint',
    type: 'string',
    description: 'Command the write and edit tools run for validate "lint" in a project that declares no lint command of its own (no package.json script, Cargo or Go toolchain, Makefile target or pyproject tool), e.g. "pnpm -r lint" for a monorepo whose scripts live in its packages. Split like a shell command line, without pipes or substitution, and run through the exec tool\'s own path. Your own settings only: a project settings file cannot set a command. Empty: the validator is refused with what the project does declare.',
  },
  {
    key: 'tools.validators.test',
    type: 'string',
    description: 'Command the write and edit tools run for validate "test" in a project that declares no test command of its own (no package.json script, Cargo or Go toolchain, Makefile target or pyproject tool), e.g. "pnpm -r test" for a monorepo whose scripts live in its packages. Split like a shell command line, without pipes or substitution, and run through the exec tool\'s own path. Your own settings only: a project settings file cannot set a command. Empty: the validator is refused with what the project does declare.',
  },
  {
    key: 'tools.validators.build',
    type: 'string',
    description: 'Command the write and edit tools run for validate "build" in a project that declares no build command of its own (no package.json script, Cargo or Go toolchain, Makefile target or pyproject tool), e.g. "pnpm -r build" for a monorepo whose scripts live in its packages. Split like a shell command line, without pipes or substitution, and run through the exec tool\'s own path. Your own settings only: a project settings file cannot set a command. Empty: the validator is refused with what the project does declare.',
  },
  {
    key: 'tools.overflowSpillBackend',
    type: 'enum',
    description:
      'Where large tool-output overflow content spills: file (on-disk .overflow, default), ledger (execution ledger), or diagnostics. An injected custom backend still takes precedence.',
    enumValues: ['file', 'ledger', 'diagnostics'],
  },
  {
    key: 'cache.enabled',
    type: 'boolean',
    description: 'Enable prompt caching for eligible providers (Anthropic)',
  },
  {
    key: 'cache.stableTtl',
    type: 'enum',
    description: 'Cache TTL for stable content (system prompt + tools): 5m or 1h. On Anthropic a 1h write is billed at '
      + '2x the input rate (5m: 1.25x) and session cost prices it that way; 1h pays off when a session pauses more than five minutes between requests.',
    enumValues: ['5m', '1h'],
  },
  {
    key: 'cache.monitorHitRate',
    type: 'boolean',
    description: 'Monitor cache hit rate and warn when below threshold',
  },
  {
    key: 'cache.hitRateWarningThreshold',
    type: 'number',
    description: 'Warn when cache hit rate falls below this fraction (0.0–1.0)',
    ...numRange(0, 1),
  },
  {
    key: 'helper.enabled',
    type: 'boolean',
    description: 'Send supporting work (compaction and resume summaries, session titles) to the helper route below; off, it stays on the main model (titles on the tool LLM)',
  },
  {
    key: 'helper.globalProvider',
    type: 'string',
    description: 'Provider for the global helper model (empty = the tool LLM when enabled, else the main model)',
  },
  {
    key: 'helper.globalModel',
    type: 'string',
    description: 'Model ID for the global helper model (empty = the tool LLM when enabled, else the main model)',
  },
  {
    key: 'behavior.hitlMode',
    type: 'enum',
    description: 'Notification verbosity mode applied to the notification router at startup and on change: off (baseline delivery policy, mode changes rejected), quiet (minimal verbosity, long batch windows), balanced (default), or operator (verbose, short batch windows)',
    enumValues: ['off', 'quiet', 'balanced', 'operator'],
  },
];
