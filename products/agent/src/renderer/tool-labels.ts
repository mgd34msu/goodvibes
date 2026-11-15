/**
 * Friendly tool labels, turn internal tool names into the phrase a person
 * would say. Shown on tool-call lines in the conversation; the raw tool name
 * is still discoverable in the Agent workspace tool catalog.
 */

const TOOL_LABELS: Record<string, string> = {
  // platform file/shell/web tools
  read: 'Reading files',
  write: 'Writing a file',
  edit: 'Editing a file',
  exec: 'Running a command',
  fetch: 'Fetching a web page',
  web_search: 'Searching the web',
  find: 'Searching files',
  analyze: 'Analyzing code',
  inspect: 'Inspecting files',

  // Agent first-class tools
  personal_ops: 'Checking your inbox & calendar',
  research: 'Researching',
  agent_research_runs: 'Researching',
  agent_research_sources: 'Reviewing sources',
  agent_research_report: 'Writing a research report',
  schedule: 'Checking schedules',
  agent_schedule_edit: 'Updating a schedule',
  agent_autonomy_schedule: 'Scheduling background work',
  agent_reminder_schedule: 'Setting a reminder',
  autonomy: 'Checking background work',
  channels: 'Checking message channels',
  agent_channel_send: 'Sending a message',
  notify: 'Sending a notification',
  memory: 'Recalling memory',
  agent_knowledge: 'Searching knowledge',
  agent_knowledge_ingest: 'Saving to knowledge',
  agent_learning_consolidation: 'Consolidating what I learned',
  agent_local_registry: 'Checking notes & routines',
  models: 'Checking models',
  agent_model_compare: 'Comparing models',
  settings: 'Adjusting settings',
  import_goodvibes_settings: 'Importing settings',
  setup: 'Checking setup',
  security: 'Reviewing safety',
  sessions: 'Looking at past conversations',
  browser: 'Using the browser',
  computer: 'Checking browser and desktop setup',
  device: 'Checking this device',
  host: 'Checking the assistant service',
  execution: 'Managing background work',
  terminal_process: 'Watching a process',
  support: 'Preparing a support bundle',
  vibe: 'Reading your VIBE profile',
  workspace: 'Driving the workspace',
  agent_harness: 'Checking app internals',
  route: 'Choosing the best route',
  delegation: 'Handing work off',
  audit: 'Reviewing evidence',
  context: 'Reading project context',
  agent_documents: 'Working on a document',
  agent_artifacts: 'Managing saved files',
  agent_media_generate: 'Generating media',
  agent_operator_method: 'Calling the assistant service',
  agent_operator_briefing: 'Preparing a briefing',
  agent_operator_action: 'Running an approved action',
  agent_work_plan: 'Organizing work',
  agent_review_packet_presets: 'Preparing a review packet',
  agent_review_packet_share: 'Sharing a review packet',
  propose_skill_drafts: 'Proposing skill drafts',
};

/**
 * Exported catalog of all registered tool IDs and their human phrases.
 * Tests import this to enumerate the full set of tool IDs for coverage checks.
 */
export const TOOL_LABELS_CATALOG: Readonly<Record<string, string>> = TOOL_LABELS;

function humanize(name: string): string {
  const short = name.includes('__') ? name.split('__').pop()! : name;
  return (short
    .replace(/^agent[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim())
    .replace(/^./, (c) => c.toUpperCase());
}

/** What a call's `action` argument does, for tools whose actions both read and write. */
type VerbClass = 'read' | 'change' | 'run' | 'send' | 'delete';

const ACTION_CLASS: Readonly<Record<string, VerbClass>> = {
  list: 'read', search: 'read', get: 'read', show: 'read', status: 'read', inspect: 'read', read: 'read',
  review: 'read', stale: 'read', preview_import: 'read', provider: 'read', curator: 'read', candidate: 'read',
  channel: 'read', deliveries: 'read', triage: 'read', refinement: 'read',
  create: 'change', update: 'change', set: 'change', reset: 'change', edit: 'change', enable: 'change',
  disable: 'change', import: 'change', pause: 'change', resume: 'change', clear_active: 'change', setup: 'change',
  autonomous: 'change', remind: 'change', reminder: 'change',
  run: 'run', start: 'run', use: 'run', run_refinement: 'run',
  send: 'send', notify: 'send', post: 'send', reply: 'send', share: 'send',
  delete: 'delete', remove: 'delete', forget: 'delete', clear: 'delete',
};

/** The phrase per verb class for multi-action tools; a class not listed keeps the tool's own phrase. */
const ACTION_PHRASES: Readonly<Record<string, Partial<Record<VerbClass, string>>>> = {
  agent_local_registry: { change: 'Updating notes & routines', run: 'Using notes & routines', delete: 'Deleting from notes & routines' },
  memory: { change: 'Saving to memory', run: 'Refining memory', delete: 'Forgetting a memory' },
  settings: { read: 'Checking settings' },
  schedule: { change: 'Updating a schedule', run: 'Running a scheduled job', delete: 'Deleting a schedule' },
  channels: { change: 'Setting up a message channel' },
};

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  // Own keys only: a name like an Object.prototype member must not resolve to a function.
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Return the human phrase for a tool call. A multi-action tool is named by
 * what its `action` argument does (reading, changing, running, sending,
 * deleting); otherwise the tool's own phrase, or a humanized version of the
 * raw name for unknown tools (including MCP tools).
 */
export function friendlyToolLabel(toolName: string, args?: Readonly<Record<string, unknown>>): string {
  const short = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  const action = args?.action;
  const verb = typeof action === 'string' ? own(ACTION_CLASS, action) : undefined;
  const byAction = verb ? (own(ACTION_PHRASES, short) ?? own(ACTION_PHRASES, toolName))?.[verb] : undefined;
  return byAction ?? own(TOOL_LABELS, short) ?? own(TOOL_LABELS, toolName) ?? humanize(toolName);
}
