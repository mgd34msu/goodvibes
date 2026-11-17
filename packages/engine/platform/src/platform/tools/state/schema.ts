/**
 * JSON Schema and TypeScript types for the `state` tool.
 */
export const STATE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['get', 'set', 'list', 'clear', 'budget', 'context', 'memory', 'telemetry', 'hooks', 'mode', 'analytics'],
      description:
        'Operation mode: get/set/list/clear manipulate KVState; budget reports the session\'s measured token usage and turns; context reports the context window (last request size, window size, compaction);'
        + ' memory reads and writes project memories by key (the records prompts retrieve);'
        + ' telemetry returns this tool\'s call counts;'
        + ' hooks manages registered hooks (list/enable/disable/add/remove);'
        + ' mode reads or sets how much the terminal app prints (quiet/balanced/operator; get/set/list);'
        + ' analytics reads the tool calls this process ran (query/summary/export/dashboard).',
    },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: '(mode: get) Keys to retrieve from KVState.',
    },
    values: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: set) Key-value pairs to write into KVState.',
    },
    prefix: {
      type: 'string',
      description: '(mode: list) Optional prefix filter. Returns only keys starting with this string.',
    },
    view: {
      type: 'string',
      enum: ['summary', 'full'],
      description: '(modes: list, memory, hooks, mode, analytics) Output detail level. Default: summary, except mode=mode modeAction=list and mode=memory memoryAction=get, which default to full.',
    },
    clearKeys: {
      type: 'array',
      items: { type: 'string' },
      description: '(mode: clear) Keys to remove from KVState.',
    },
    memoryAction: {
      type: 'string',
      enum: ['get', 'set', 'list', 'delete'],
      description: '(mode: memory) Sub-action: get reads a key, set saves a key (replacing its value), list shows all keys, delete removes a key.',
    },
    memoryKey: {
      type: 'string',
      description: '(mode: memory, action: get/set/delete) The memory key: letters, digits, hyphens and underscores.',
    },
    memoryValue: {
      type: 'string',
      description: '(mode: memory, action: set) JSON string or plain text to save. It is embedded for retrieval, so a value holding a credential is refused.',
    },
    hookAction: {
      type: 'string',
      enum: ['list', 'enable', 'disable', 'add', 'remove'],
      description: '(mode: hooks) Sub-action: list all hooks; enable/disable by name; add a new hook; remove by name.',
    },
    hookName: {
      type: 'string',
      description: '(mode: hooks, action: enable/disable/remove) Name of the hook to target.',
    },
    hookDefinition: {
      type: 'object',
      description: '(mode: hooks, action: add) Hook definition object with eventPattern and hook fields. name is required and must be unused; the hook for its type (command, url or path) is required. The hook lasts for this session only.',
      properties: {
        eventPattern: { type: 'string', description: 'Event path pattern (e.g. Pre:tool:*)' },
        name: { type: 'string', description: 'Required. Unique name for the hook; enable, disable and remove address it by this name.' },
        type: { type: 'string', enum: ['command', 'http', 'ts'], description: 'Hook type.' },
        match: { type: 'string', description: 'Event path to match.' },
        command: { type: 'string', description: '(type: command) Shell command to run.' },
        url: { type: 'string', description: '(type: http) URL to POST to.' },
        path: { type: 'string', description: '(type: ts) Path to TypeScript file.' },
        description: { type: 'string', description: 'Human-readable description.' },
      },
      additionalProperties: true,
    },
    modeAction: {
      type: 'string',
      enum: ['get', 'set', 'list'],
      description: '(mode: mode) Sub-action: get returns the current print level; set saves a new one; list returns the levels.',
    },
    modeName: {
      type: 'string',
      description: '(mode: mode, action: set) The print level: quiet (only warnings and errors toast), balanced (the default) or operator (everything toasts).',
    },
    analyticsAction: {
      type: 'string',
      enum: ['query', 'summary', 'export', 'dashboard'],
      description: '(mode: analytics) Sub-action: query recorded calls by filter; summary aggregation; export as JSON/CSV; dashboard top-level view. Calls are kept in memory for this process, the newest 10,000.',
    },
    analyticsFilter: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: analytics, action: query) Filter object: { tool?, status? (ok, error or cancelled), since?, until?, limit? }',
    },
    analyticsFormat: {
      type: 'string',
      enum: ['json', 'csv'],
      description: '(mode: analytics, action: export) Export format.',
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

/** All valid operation modes for the state tool. */
export type StateMode =
  | 'get'
  | 'set'
  | 'list'
  | 'clear'
  | 'budget'
  | 'context'
  | 'memory'
  | 'telemetry'
  | 'hooks'
  | 'mode'
  | 'analytics';

/** Memory sub-action. */
export type MemoryAction = 'get' | 'set' | 'list' | 'delete';

/** Hooks sub-action. */
export type HookAction = 'list' | 'enable' | 'disable' | 'add' | 'remove';

/** Mode sub-action. */
export type ModeAction = 'get' | 'set' | 'list';

/** Analytics sub-action. */
export type AnalyticsAction = 'query' | 'summary' | 'export' | 'dashboard';

/** Full input shape for the state tool. */
export interface StateInput {
  mode: StateMode;

  // mode: get
  keys?: string[] | undefined;

  // mode: set
  values?: Record<string, unknown> | undefined;

  // mode: list
  prefix?: string | undefined;
  view?: 'summary' | 'full' | undefined;

  // mode: clear
  clearKeys?: string[] | undefined;

  // mode: memory
  memoryAction?: MemoryAction | undefined;
  memoryKey?: string | undefined;
  memoryValue?: string | undefined;

  // mode: hooks
  hookAction?: HookAction | undefined;
  hookName?: string | undefined;
  hookDefinition?: {
    eventPattern: string;
    name?: string | undefined;
    type: 'command' | 'http' | 'ts';
    match: string;
    command?: string | undefined;
    url?: string | undefined;
    path?: string | undefined;
    description?: string | undefined;
    [key: string]: unknown;
  };

  // mode: mode
  modeAction?: ModeAction | undefined;
  modeName?: string | undefined;

  // mode: analytics
  analyticsAction?: AnalyticsAction | undefined;
  analyticsFilter?: Record<string, unknown> | undefined;
  analyticsFormat?: 'json' | 'csv' | undefined;
}
