import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import { findOperatorContractMethod, operatorContractMethods as contractMethodIndex } from '@goodvibes-jev/engine/terminal-shell/agent-turn/operator-contract-routes';
import type { CommandContext } from '../input/command-registry.ts';
import { captureCatalogData } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-data';
import { type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { EFFECT_ADMISSION_SENTENCE } from '@goodvibes-jev/engine/terminal-shell/agent-turn/effect-admission';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { mcpSchemaRoute } from './agent-harness-personal-ops-routes.ts';
import type { McpSchemaSummary, McpToolRecord, McpToolSchema, OperatorContractMethod, PersonalOpsConnectorSignal, PersonalOpsConnectorTool, PersonalOpsWorkflow, PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn/read-helpers';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 12);
}

/** The contract's methods, from the one memoized index (operator-contract-routes.ts). */
export function operatorContractMethods(): readonly OperatorContractMethod[] {
  return contractMethodIndex();
}

export function isInvokableContractMethod(method: OperatorContractMethod): boolean {
  return method.invokable !== false;
}

/** True when the operator contract publishes this exact method id and a route serves it. */
export function contractHasMethod(methodId: string): boolean {
  const method = findOperatorContractMethod(methodId);
  return method !== null && isInvokableContractMethod(method);
}

export function partitionInvokableMethods(methods: readonly OperatorContractMethod[]): {
  readonly available: readonly string[]; readonly unavailable: readonly string[];
} {
  const ids = (invokable: boolean) => methods.filter(method => isInvokableContractMethod(method) === invokable)
    .map(method => method.id).sort((left, right) => left.localeCompare(right));
  return { available: ids(true), unavailable: ids(false) };
}

export type ContractLane = 'inbox' | 'calendar' | 'tasks' | 'reminders' | 'approvals' | 'automation' | 'schedules';
type ContractLaneMethods = ReturnType<typeof partitionInvokableMethods>;

/**
 * Lane membership is a property of the method id: these prefixes are the whole
 * rule. The operator contract is compiled into the program, so the partition
 * is computed once per process. An entry ending in a dot is a prefix.
 */
const LANE_METHOD_PREFIXES: Readonly<Record<ContractLane, readonly string[]>> = {
  inbox: ['email.', 'channels.inbox.'],
  calendar: ['calendar.'],
  tasks: ['tasks.', 'projectPlanning.workPlan.task'],
  reminders: ['automation.schedules.'],
  approvals: ['approvals.'],
  automation: ['automation.'],
  schedules: ['automation.schedules.'],
};

let laneMethods: ReadonlyMap<ContractLane, ContractLaneMethods> | null = null;

export function contractLaneMethods(lane: ContractLane): ContractLaneMethods {
  if (!laneMethods) {
    const methods = operatorContractMethods();
    const partitioned = new Map<ContractLane, ContractLaneMethods>();
    for (const [name, prefixes] of Object.entries(LANE_METHOD_PREFIXES) as [ContractLane, readonly string[]][]) {
      partitioned.set(name, partitionInvokableMethods(methods.filter(method => prefixes.some(prefix => method.id.startsWith(prefix)))));
    }
    laneMethods = partitioned;
  }
  return laneMethods.get(lane)!;
}

export function contractMethodsForAutonomy(): {
  readonly approvals: ContractLaneMethods; readonly automation: ContractLaneMethods;
  readonly schedules: ContractLaneMethods; readonly tasks: ContractLaneMethods;
} {
  return { approvals: contractLaneMethods('approvals'), automation: contractLaneMethods('automation'),
    schedules: contractLaneMethods('schedules'), tasks: contractLaneMethods('tasks') };
}

/**
 * One honest line naming advertised-but-undispatchable methods, matching the
 * degraded-ad pattern ("unavailable (route not served by this daemon)").
 * Returns null when nothing is degraded.
 */
export function unavailableMethodsNote(unavailableMethodIds: readonly string[]): string | null {
  if (unavailableMethodIds.length === 0) return null;
  return `${unavailableMethodIds.length} advertised method(s) are unavailable (route not served by this daemon) and cannot be dispatched: ${unavailableMethodIds.join(', ')}.`;
}

function mcpApi(context: CommandContext): object | null {
  const api = modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry']);
  if (api === undefined || api === null) return null;
  if (typeof api !== 'object') throw new ToolInputProjectionError('invalid');
  return api;
}

export interface McpServerRecord {
  readonly name: string; readonly connected: boolean; readonly trustMode: string; readonly role: string;
  readonly schemaFreshness: string; readonly allowedHosts: readonly string[];
}

export function mcpServerRecords(context: CommandContext): readonly McpServerRecord[] {
  const api = mcpApi(context);
  if (!api) return [];
  const list = modelReadingServicePath(api, ['listServerSecurity']);
  if (typeof list !== 'function') return [];
  const captured = captureCatalogData(list.call(api) as unknown);
  if (!Array.isArray(captured)) throw new ToolInputProjectionError('invalid');
  return captured.map(value => {
    const server = schemaObject(value);
    if (!server || typeof server.name !== 'string' || typeof server.connected !== 'boolean' || typeof server.trustMode !== 'string'
      || typeof server.role !== 'string' || typeof server.schemaFreshness !== 'string' || !Array.isArray(server.allowedHosts)
      || !server.allowedHosts.every((host: unknown) => typeof host === 'string')) throw new ToolInputProjectionError('invalid');
    return { ...server, name: server.name, connected: server.connected, trustMode: server.trustMode, role: server.role,
      schemaFreshness: server.schemaFreshness, allowedHosts: server.allowedHosts.filter((host: unknown): host is string => typeof host === 'string') };
  });
}

export async function mcpToolRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly McpToolRecord[]> {
  options.signal?.throwIfAborted();
  const api = mcpApi(context);
  if (!api) return [];
  const list = modelReadingServicePath(api, ['listAllTools']);
  if (typeof list !== 'function') return [];
  const tools = captureCatalogData(await list.call(api) as unknown);
  options.signal?.throwIfAborted();
  if (!Array.isArray(tools)) throw new ToolInputProjectionError('invalid');
  return tools.map(value => {
    const tool = schemaObject(value);
    if (!tool || typeof tool.serverName !== 'string' || typeof tool.toolName !== 'string'
      || (tool.description !== undefined && typeof tool.description !== 'string')
      || (tool.qualifiedName !== undefined && typeof tool.qualifiedName !== 'string')) throw new ToolInputProjectionError('invalid');
    return { serverName: tool.serverName, toolName: tool.toolName,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(typeof tool.qualifiedName === 'string' ? { qualifiedName: tool.qualifiedName } : {}),
    };
  });
}

/** One tool's schema from the registry; the MCP client serves it from the catalog it already listed. */
export async function mcpToolSchema(context: CommandContext, qualifiedName: string, options: CatalogRankingOptions = {}): Promise<McpToolSchema | null> {
  const api = mcpApi(context);
  const read = api ? modelReadingServicePath(api, ['getToolSchema']) : undefined;
  if (!api || typeof read !== 'function') return null;
  options.signal?.throwIfAborted();
  const raw: unknown = await read.call(api, qualifiedName);
  options.signal?.throwIfAborted();
  if (raw === null || raw === undefined) return null;
  const schema = schemaObject(captureCatalogData(raw));
  if (!schema) throw new ToolInputProjectionError('invalid');
  return { inputSchema: schema.inputSchema, ...(schema.annotations !== undefined ? { annotations: schema.annotations } : {}) };
}

export async function mcpToolSchemas(context: CommandContext, tools: readonly McpToolRecord[], options: CatalogRankingOptions = {}): Promise<ReadonlyMap<string, McpToolSchema>> {
  const entries = await Promise.all(tools.map(async tool => [qualifiedToolName(tool), await mcpToolSchema(context, qualifiedToolName(tool), options)] as const));
  const schemas = new Map<string, McpToolSchema>();
  for (const [name, schema] of entries) if (schema) schemas.set(name, schema);
  return schemas;
}

export function qualifiedToolName(tool: McpToolRecord): string {
  return tool.qualifiedName ?? `mcp:${tool.serverName}:${tool.toolName}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function schemaObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

export function schemaRequiredFields(schema: Record<string, unknown>): readonly string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string').sort((left, right) => left.localeCompare(right));
}

export function schemaOptionalFields(schema: Record<string, unknown>, requiredFields: readonly string[]): readonly string[] {
  const properties = schemaObject(schema.properties);
  if (!properties) return [];
  const required = new Set(requiredFields);
  return Object.keys(properties).filter((field) => !required.has(field)).sort((left, right) => left.localeCompare(right));
}

/**
 * A sample value for one input field, read from the field's own JSON schema:
 * its default, first example, first enum value or const, else a placeholder of
 * its type (`<iso-date-time>` for a `date-time` string). The sample's type is
 * the schema's type, which is what a supplied value is checked against.
 */
export function schemaFieldSample(field: string, property: unknown, depth = 0): unknown {
  const schema = schemaObject(property);
  if (!schema) return `<${field}>`;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type.find(entry => entry !== 'null') : schema.type;
  switch (type) {
    case 'integer':
    case 'number': return typeof schema.minimum === 'number' && schema.minimum > 0 ? schema.minimum : 10;
    case 'boolean': return false;
    case 'array': return depth < 2 ? [schemaFieldSample(field, schema.items, depth + 1)] : [];
    case 'object': return {};
    default: {
      const format = typeof schema.format === 'string' ? schema.format : '';
      if (format === 'date-time') return '<iso-date-time>';
      if (format === 'date') return '<iso-date>';
      if (format === 'email') return '<email>';
      if (format === 'uri' || format === 'url') return '<url>';
      return `<${field}>`;
    }
  }
}

export function summarizeInputSchema(qualifiedName: string, inputSchema: unknown): McpSchemaSummary | null {
  const schema = schemaObject(inputSchema);
  if (!schema) return null;
  const requiredFields = schemaRequiredFields(schema);
  const optionalFields = schemaOptionalFields(schema, requiredFields);
  const properties = schemaObject(schema.properties) ?? {};
  const fields = [...requiredFields, ...optionalFields.slice(0, Math.max(0, 4 - requiredFields.length))];
  const sampleInput: Record<string, unknown> = {};
  for (const field of fields) sampleInput[field] = schemaFieldSample(field, properties[field]);
  return { schemaRoute: mcpSchemaRoute(qualifiedName), requiredFields, optionalFields, sampleInput };
}

export function toolsByServer(tools: readonly McpToolRecord[]): ReadonlyMap<string, readonly McpToolRecord[]> {
  const grouped = new Map<string, McpToolRecord[]>();
  for (const tool of tools) {
    const entries = grouped.get(tool.serverName) ?? [];
    entries.push(tool);
    grouped.set(tool.serverName, entries);
  }
  return grouped;
}

/** Words of an identifier: `search_gmail_messages`, `listEvents` and `google-calendar` split into lower-case words. */
function identifierWords(value: string): readonly string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const CALENDAR_WORDS = new Set(['calendar', 'calendars', 'event', 'events', 'agenda', 'caldav', 'ical', 'meeting', 'meetings', 'appointment', 'appointments', 'rsvp', 'freebusy']);
const INBOX_WORDS = new Set(['email', 'emails', 'mail', 'mails', 'gmail', 'inbox', 'imap', 'smtp', 'outlook', 'mailbox', 'message', 'messages', 'thread', 'threads', 'draft', 'drafts']);
/** Leading verbs of a tool name that only read. */
const READ_VERBS = new Set(['list', 'get', 'read', 'search', 'find', 'fetch', 'query', 'show', 'view', 'lookup', 'check', 'count', 'describe', 'inspect', 'browse', 'peek']);

function laneOfWords(words: readonly string[]): 'inbox' | 'calendar' | null {
  if (words.some(word => CALENDAR_WORDS.has(word))) return 'calendar';
  if (words.some(word => INBOX_WORDS.has(word))) return 'inbox';
  return null;
}

export interface ConnectorToolClass {
  readonly lane: 'inbox' | 'calendar';
  readonly effect: PersonalOpsConnectorTool['effect'];
}

/**
 * Which Personal Ops lane an MCP tool serves and whether it only reads, decided
 * in code: the lane from the words of the tool name (else the server name), the
 * effect from the server's own `readOnlyHint`/`destructiveHint`, else from the
 * tool name's leading verb. Anything not plainly a read is a confirmed effect,
 * so `personal_ops action:"read"` never runs it.
 */
export function classifyConnectorTool(tool: McpToolRecord, schema: McpToolSchema | null | undefined): ConnectorToolClass | null {
  const toolWords = identifierWords(tool.toolName);
  const lane = laneOfWords(toolWords) ?? laneOfWords(identifierWords(tool.serverName));
  if (!lane) return null;
  const hints = schemaObject(schema?.annotations);
  const effect: PersonalOpsConnectorTool['effect'] = hints?.readOnlyHint === true ? 'read-only'
    : hints?.readOnlyHint === false || hints?.destructiveHint === true ? 'confirmed-effect'
      : READ_VERBS.has(toolWords[0] ?? '') ? 'read-only' : 'confirmed-effect';
  return { lane, effect };
}

export function connectorTool(tool: McpToolRecord, schema: McpToolSchema | null | undefined, toolClass: ConnectorToolClass): PersonalOpsConnectorTool {
  const qualifiedName = qualifiedToolName(tool);
  const summary = summarizeInputSchema(qualifiedName, schema?.inputSchema);
  return { name: tool.toolName, qualifiedName, ...(tool.description ? { description: tool.description } : {}),
    effect: toolClass.effect, capability: `${toolClass.lane}-${toolClass.effect === 'read-only' ? 'read' : 'write'}`,
    ...(summary ?? { schemaRoute: mcpSchemaRoute(qualifiedName) }) };
}

export function connectorServerReady(server: McpServerRecord | undefined): boolean {
  return server !== undefined && server.connected && server.schemaFreshness === 'fresh' && server.trustMode !== 'blocked';
}

/** The registered MCP servers and their tools, read once per call: the input every connector lane is built from. */
export interface ConnectorInventory {
  readonly servers: readonly McpServerRecord[];
  readonly tools: readonly McpToolRecord[];
  readonly schemas: ReadonlyMap<string, McpToolSchema>;
}

export const NO_CONNECTORS: ConnectorInventory = { servers: [], tools: [], schemas: new Map() };

export async function readConnectorInventory(context: CommandContext, options: CatalogRankingOptions = {}): Promise<ConnectorInventory> {
  const servers = mcpServerRecords(context);
  if (servers.length === 0) return NO_CONNECTORS;
  const tools = await mcpToolRecords(context, options);
  return { servers, tools, schemas: await mcpToolSchemas(context, tools, options) };
}

export function connectorSignals(inventory: ConnectorInventory, lane: 'inbox' | 'calendar'): readonly PersonalOpsConnectorSignal[] {
  const signals: PersonalOpsConnectorSignal[] = [];
  for (const [serverName, tools] of toolsByServer(inventory.tools)) {
    const server = inventory.servers.find(entry => entry.name === serverName);
    if (!server) continue;
    const classified: PersonalOpsConnectorTool[] = [];
    for (const tool of tools) {
      const schema = inventory.schemas.get(qualifiedToolName(tool));
      const toolClass = classifyConnectorTool(tool, schema);
      if (toolClass?.lane === lane) classified.push(connectorTool(tool, schema, toolClass));
    }
    if (classified.length === 0) continue;
    const ready = connectorServerReady(server);
    const capabilityTags = [...new Set(classified.map(tool => tool.capability))].sort();
    signals.push({ id: `mcp:${server.name}`, kind: 'mcp-server', label: server.name, status: ready ? 'ready' : 'attention',
      summary: `${server.connected ? 'connected' : 'disconnected'} ${server.trustMode} ${server.schemaFreshness}; ${tools.length} tool(s); ${capabilityTags.join(', ')}`,
      modelRoute: `agent_harness mode:"mcp_server" mcpServerId:"${server.name}"`, toolCount: tools.length, capabilityTags,
      readTools: classified.filter(tool => tool.effect === 'read-only').sort((left, right) => left.name.localeCompare(right.name)),
      writeTools: classified.filter(tool => tool.effect === 'confirmed-effect').sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  return signals.sort((left, right) => left.label.localeCompare(right.label));
}

export function connectorReady(signals: readonly PersonalOpsConnectorSignal[]): boolean {
  return signals.some((signal) => signal.status === 'ready');
}

export function connectorToolCount(signals: readonly PersonalOpsConnectorSignal[], effect: PersonalOpsConnectorTool['effect']): number {
  return signals.reduce((total, signal) => total + (effect === 'read-only' ? signal.readTools?.length ?? 0 : signal.writeTools?.length ?? 0), 0);
}

/** The built-in google tool route for a lane, when a connected Google account serves it. */
export interface GoogleLaneRoute {
  readonly modelRoute: string;
  readonly summary: string;
}

export function workflowStatus(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], google?: GoogleLaneRoute | null): PersonalOpsWorkflowStatus {
  if (google || connectorReady(connectors)) return 'ready';
  if (connectors.length > 0) return 'attention';
  if (methodIds.length > 0) return 'ready';
  return 'needs-setup';
}

export function workflowModelRoute(
  methodQuery: string,
  connectors: readonly PersonalOpsConnectorSignal[],
  google?: GoogleLaneRoute | null,
): string {
  if (google) return google.modelRoute;
  const readyConnector = connectors.find((signal) => signal.status === 'ready') ?? connectors[0];
  if (readyConnector) return readyConnector.modelRoute;
  return `host action:"methods" query:"${methodQuery}"`;
}

export function workflowInspectRoutes(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], fallbackQuery: string, google?: GoogleLaneRoute | null): readonly string[] {
  const googleRoutes = google ? [google.modelRoute] : [];
  const connectorRoutes = connectors.map((signal) => signal.modelRoute);
  const methodRoutes = methodIds.map((methodId) => `host action:"method" methodId:"${methodId}"`);
  const routes = [...googleRoutes, ...connectorRoutes, ...methodRoutes];
  return routes.length > 0 ? routes : [`personal_ops action:"lane" laneId:"${fallbackQuery}"`];
}

export function inboxWorkflows(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], unavailableMethodIds: readonly string[] = [], google: GoogleLaneRoute | null = null): readonly PersonalOpsWorkflow[] {
  const status = workflowStatus(methodIds, connectors, google);
  const inspectRoutes = workflowInspectRoutes(methodIds, connectors, 'inbox', google);
  const modelRoute = workflowModelRoute('email', connectors, google);
  const readToolCount = connectorToolCount(connectors, 'read-only');
  const writeToolCount = connectorToolCount(connectors, 'confirmed-effect');
  const degradedAdNote = unavailableMethodsNote(unavailableMethodIds);
  const setupPrerequisite = status === 'needs-setup'
    ? [
      'Connect a Google account first with /google connect, or take up credentials already on this machine with /google adopt.',
      ...(degradedAdNote ? [degradedAdNote] : []),
    ]
    : status === 'attention'
      ? ['Review connector trust/schema freshness before reading inbox data.']
      : google
        ? [google.summary, `List or read mail with ${google.modelRoute}; sending is google action:"mail.send" under its own admission.`]
      : [
        'Inspect the exact connector or daemon method schema before selecting inbox actions.',
        readToolCount > 0
          ? `${readToolCount} classified read-only inbox tool(s) are available.`
          : 'No classified read-only inbox tools were returned; inspect the connector schema before claiming live inbox access.',
      ];
  return [
    {
      id: 'inbox-triage-briefing',
      label: 'Inbox triage briefing',
      status,
      summary: 'Summarize unread or high-priority inbound messages without sending mail.',
      next: status === 'ready'
        ? 'Inspect the connector/method, list candidate messages, then summarize priorities and risks in the main conversation.'
        : 'Finish email connector setup before attempting inbox triage.',
      modelRoute,
      inspectRoutes,
      prerequisites: setupPrerequisite,
      runBoundary: 'Read/list/search can run only through the reviewed connector or daemon method; sends and mutations require explicit confirmation.',
    },
    {
      id: 'inbox-draft-reply',
      label: 'Draft reply review',
      status,
      summary: 'Draft replies for selected messages while keeping send as a separate confirmed action.',
      next: status === 'ready'
        ? 'Read the selected thread through the connector, draft in chat, then ask for confirmation before any send route.'
        : 'Finish email connector setup before drafting from live threads.',
      modelRoute,
      inspectRoutes,
      prerequisites: [
        ...setupPrerequisite,
        'The user must identify the account, mailbox, or message selection.',
        writeToolCount > 0
          ? `${writeToolCount} write-like inbox tool(s) require explicit confirmation before send, label, archive, delete, or move effects.`
          : 'No write-like inbox tools were classified; keep sending and mailbox mutation out of scope until a connector route is inspected.',
      ],
      runBoundary: 'Drafting is conversation output; sending or labeling stays on the connector/tool route with confirmation.',
    },
  ];
}

export function calendarWorkflows(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], unavailableMethodIds: readonly string[] = [], google: GoogleLaneRoute | null = null): readonly PersonalOpsWorkflow[] {
  const status = workflowStatus(methodIds, connectors, google);
  const inspectRoutes = workflowInspectRoutes(methodIds, connectors, 'calendar', google);
  const modelRoute = workflowModelRoute('calendar', connectors, google);
  const readToolCount = connectorToolCount(connectors, 'read-only');
  const writeToolCount = connectorToolCount(connectors, 'confirmed-effect');
  const degradedAdNote = unavailableMethodsNote(unavailableMethodIds);
  const setupPrerequisite = status === 'needs-setup'
    ? [
      'Connect a Google account first with /google connect, or subscribe to a calendar feed with /calendar subscribe.',
      ...(degradedAdNote ? [degradedAdNote] : []),
    ]
    : status === 'attention'
      ? ['Review connector trust/schema freshness before reading calendar data.']
      : google
        ? [google.summary, `Read the agenda with ${google.modelRoute}; creating an event is google action:"calendar.create" under its own admission.`]
      : [
        'Inspect the exact connector or daemon method schema before selecting agenda actions.',
        readToolCount > 0
          ? `${readToolCount} classified read-only calendar tool(s) are available.`
          : 'No classified read-only calendar tools were returned; inspect the connector schema before claiming live agenda access.',
      ];
  return [
    {
      id: 'calendar-agenda-briefing',
      label: 'Agenda briefing',
      status,
      summary: 'Read upcoming events and prepare a concise day or week briefing.',
      next: status === 'ready'
        ? 'Inspect the connector/method, fetch the requested window, then summarize agenda context and prep items.'
        : 'Finish calendar connector setup before attempting agenda briefing.',
      modelRoute,
      inspectRoutes,
      prerequisites: [...setupPrerequisite, 'The user must provide a date range or accept a bounded default window.'],
      runBoundary: 'Calendar reads can run only through reviewed connector/method routes; event edits require explicit confirmation.',
    },
    {
      id: 'calendar-conflict-scan',
      label: 'Conflict scan',
      status,
      summary: 'Detect overlapping events or prep gaps and offer reminders instead of editing the calendar silently.',
      next: status === 'ready'
        ? 'Inspect the agenda source, scan the requested window, then propose reminders or follow-ups for confirmation.'
        : 'Finish calendar connector setup before scanning conflicts.',
      modelRoute,
      inspectRoutes,
      prerequisites: [
        ...setupPrerequisite,
        'The user must provide a calendar/account scope if more than one exists.',
        writeToolCount > 0
          ? `${writeToolCount} write-like calendar tool(s) require explicit confirmation before event create, edit, delete, RSVP, or reschedule effects.`
          : 'No write-like calendar tools were classified; keep event mutation out of scope until a connector route is inspected.',
      ],
      runBoundary: 'Conflict findings are advisory; reminders use schedule action:"remind" and calendar edits use confirmed connector actions.',
    },
  ];
}

export function taskWorkflows(methodIds: readonly string[]): readonly PersonalOpsWorkflow[] {
  const hostTaskStatus: PersonalOpsWorkflowStatus = methodIds.length > 0 ? 'ready' : 'needs-setup';
  return [
    {
      id: 'visible-work-plan-review',
      label: 'Visible work-plan review',
      status: 'ready',
      summary: 'Track user-facing work items in the Agent-owned work plan before creating background or host work.',
      next: 'Review the plan, add or update one item when useful, and keep status changes visible.',
      modelRoute: 'agent_work_plan action:"list"',
      inspectRoutes: [
        'workspace action:"action" actionId:"work-autonomy-queue"',
        'agent_work_plan action:"create" title:"..."',
        'agent_work_plan action:"set_status" id:"..." status:"..."',
      ],
      prerequisites: ['Use the work plan when the user asks for task tracking, multi-step work, or a visible checkpoint.'],
      runBoundary: 'Agent-owned work-plan edits stay local and visible; deletion/clear-completed routes require explicit confirmation.',
    },
    {
      id: 'connected-host-task-review',
      label: 'Connected-host task review',
      status: hostTaskStatus,
      summary: 'Inspect connected-host task state separately from Agent-owned work-plan state.',
      next: hostTaskStatus === 'ready'
        ? 'List host tasks, inspect one exact task id, then cancel or retry only through confirmed daemon controls when the user asks.'
        : 'Update or connect the GoodVibes host until task inspection methods are present.',
      modelRoute: 'workspace action:"action" actionId:"tasks-filter"',
      inspectRoutes: [
        'workspace action:"action" actionId:"tasks-filter"',
        'workspace action:"action" actionId:"task-show"',
        ...methodIds.map((methodId) => `host action:"method" methodId:"${methodId}"`),
      ],
      prerequisites: hostTaskStatus === 'ready'
        ? [`${methodIds.length} task/work-plan daemon method(s) are discoverable.`]
        : ['Connected-host task methods are not present in the current platform operator contract.'],
      runBoundary: 'Host task cancel/retry/create actions mutate connected-host state and require exact ids, confirmation, and explicit user request.',
    },
  ];
}

export function reminderWorkflows(methodIds: readonly string[], deliveryConfigured: boolean): readonly PersonalOpsWorkflow[] {
  const scheduleStatus: PersonalOpsWorkflowStatus = methodIds.length > 0 ? 'ready' : 'needs-setup';
  const reminderStatus: PersonalOpsWorkflowStatus = methodIds.length === 0 ? 'needs-setup' : deliveryConfigured ? 'ready' : 'attention';
  return [
    {
      id: 'confirmed-reminder-request',
      label: 'Confirmed reminder request',
      status: reminderStatus,
      summary: 'Create one visible reminder only from a direct user request with real timing and optional delivery target.',
      next: reminderStatus === 'ready'
        ? 'Collect the message, timing and delivery scope from the user, then use the reminder route.'
        : reminderStatus === 'attention'
          ? 'Configure or confirm a delivery target before relying on reminder delivery, or create the reminder with explicit scope.'
          : 'Update the connected GoodVibes host until schedule/reminder creation methods are available.',
      modelRoute: 'schedule action:"remind"',
      inspectRoutes: [
        'workspace action:"action" actionId:"schedule-reminder"',
        'channels action:"status"',
        ...methodIds.filter((methodId) => methodId.startsWith('automation.schedules.')).slice(0, 6).map((methodId) => `host action:"method" methodId:"${methodId}"`),
      ],
      prerequisites: [
        'The user must provide the reminder message and a concrete time.',
        deliveryConfigured ? 'At least one delivery target or channel is configured.' : 'No configured delivery target was detected; delivery setup may be needed.',
      ],
      runBoundary: `Reminder creation: ${EFFECT_ADMISSION_SENTENCE} Vague follow-up ideas stay as notes or work-plan items.`,
    },
    {
      id: 'connected-schedule-review',
      label: 'Connected schedule review',
      status: scheduleStatus,
      summary: 'Review existing connected schedules before editing, running, pausing, resuming, or deleting one.',
      next: scheduleStatus === 'ready'
        ? 'List schedules or inspect the autonomy queue, then control only one exact schedule id through confirmed routes.'
        : 'Update the connected GoodVibes host until schedule list/control methods are available.',
      modelRoute: 'autonomy action:"item" queueItemId:"connected-schedules"',
      inspectRoutes: [
        'schedule action:"list"',
        'autonomy action:"item" queueItemId:"connected-schedules"',
        'workspace action:"action" actionId:"schedule-edit"',
      ],
      prerequisites: scheduleStatus === 'ready'
        ? [`${methodIds.length} schedule/reminder daemon method(s) are discoverable.`]
        : ['Connected-host schedule methods are not present in the current platform operator contract.'],
      runBoundary: 'Schedule edit/run/enable/disable/delete actions require exact ids, confirmation, and explicit user request.',
    },
  ];
}
