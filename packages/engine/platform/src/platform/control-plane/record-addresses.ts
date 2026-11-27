/**
 * record-addresses.ts, what each method and capability addresses by id: for every input that names a record (an input
 * named `id`, `...Id` or `...Ids`), the kind of record it names, or why it names none of a project's records. The one
 * check of what a caller may reach (control-plane/caller-reach.ts) reads it, and the catalog does not load while a
 * builtin method or a daemon capability takes an id it does not declare here (as an undeclared folder input stops it,
 * method-catalog-shared.ts `checkFolderInputs`).
 *
 * Read in this order for each input (its path as `workFolders` writes them, `a.b`, `a[]`):
 * 1. the method's own line in METHODS;
 * 2. for an input named like a record kind (KINDED_NAMES), its kind by name, when the name has one;
 * 3. for any other id, the line of the method's family (FAMILIES), which says why that family's ids are none of a
 *    project's records.
 * An input that reaches none of these stops the catalog.
 */
export type RecordKind =
  | 'chat' | 'session' | 'approval' | 'schedule' | 'schedule-run' | 'trigger' | 'rule' | 'memory-record' | 'checkpoint'
  | 'task' | 'artifact' | 'batch-job' | 'route-binding' | 'remote-work' | 'memory-proposal' | 'ci-watch'
  | 'remote-runner' | 'remote-artifact';

/** An input's declaration: the kind of record it names, or why it names none. */
export type Addressed = RecordKind | { readonly not: string };

/** A list or a search a method answers with, filtered to what the caller may reach. */
export interface ListedRecords {
  /** The field of the answer holding the list. */
  readonly at: string;
  readonly kind: RecordKind;
  /** The field of each entry holding its id (default `id`). */
  readonly id?: string | undefined;
  /** Fields that may hold its stored id, the first one present (a trigger's `storedId`, else `id`); over `id`. */
  readonly idFields?: readonly string[] | undefined;
  /**
   * The list is a report of the daemon's own run over every project's records (it names records of many projects in
   * one entry): the owner's alone; a caller that is not the owner in person is answered it empty.
   */
  readonly ownerOnly?: true | undefined;
}

const not = (why: string): Addressed => ({ not: why });

const IN_SESSION = not('a part of the session named beside it, reached only as that session is');
const IN_CHAT = not('a part of the web chat named beside it, reached only as that chat is');
const NEW_ID = not('the id of the record this call makes');

/** The kind of the inputs named like one, when the name says it alone. `id`, `ids`, `jobId` and `runId` say nothing alone. */
const KIND_OF_NAME: Readonly<Record<string, RecordKind | undefined>> = {
  sessionId: 'session', pinnedSessionId: 'session', approvalId: 'approval', scheduleId: 'schedule', checkpointId: 'checkpoint',
  ruleId: 'rule', artifactId: 'artifact', agentId: 'task', taskId: 'task',
  id: undefined, ids: undefined, jobId: undefined, runId: undefined,
};

/** The names that name a record of a kind: each is declared by the method, or by its kind, never by its family. */
const KINDED_NAMES: ReadonlySet<string> = new Set(Object.keys(KIND_OF_NAME));

/** Each method's own declarations (and the lists it answers with). */
const METHODS: Readonly<Record<string, { readonly inputs?: Readonly<Record<string, Addressed>>; readonly lists?: readonly ListedRecords[] }>> = {
  // Web chats: their project's and their maker's.
  'companion.chat.sessions.list': { lists: [{ at: 'sessions', kind: 'chat' }] },
  'companion.chat.messages.search': { lists: [{ at: 'items', kind: 'chat', id: 'sessionId' }] },
  'companion.chat.sessions.get': { inputs: { sessionId: 'chat' } },
  'companion.chat.sessions.update': { inputs: { sessionId: 'chat' } },
  'companion.chat.sessions.close': { inputs: { sessionId: 'chat' } },
  'companion.chat.sessions.reopen': { inputs: { sessionId: 'chat' } },
  'companion.chat.sessions.delete': { inputs: { sessionId: 'chat' } },
  'companion.chat.messages.create': { inputs: { sessionId: 'chat', 'attachments[].artifactId': 'artifact' } },
  'companion.chat.messages.list': { inputs: { sessionId: 'chat' } },
  'companion.chat.messages.retry': { inputs: { sessionId: 'chat' } },
  'companion.chat.messages.edit': { inputs: { sessionId: 'chat', 'attachments[].artifactId': 'artifact' } },
  'companion.chat.branches.switch': { inputs: { sessionId: 'chat' } },
  'companion.chat.messages.steer': { inputs: { sessionId: 'chat', 'attachments[].artifactId': 'artifact' } },
  'companion.chat.turns.cancel': { inputs: { sessionId: 'chat' } },
  'companion.chat.queuedMessages.list': { inputs: { sessionId: 'chat' } },
  'companion.chat.queuedMessages.edit': { inputs: { sessionId: 'chat' } },
  'companion.chat.queuedMessages.delete': { inputs: { sessionId: 'chat' } },
  'companion.chat.attachments.remove': { inputs: { sessionId: 'chat', artifactId: IN_CHAT } },
  'companion.chat.events.stream': { inputs: { sessionId: 'chat' } },
  // Shared and hosted sessions.
  'sessions.list': { lists: [{ at: 'sessions', kind: 'session' }] },
  'sessions.search': { lists: [{ at: 'sessions', kind: 'session' }, { at: 'results', kind: 'session', id: 'sessionId' }] },
  'sessions.hosted.list': { lists: [{ at: 'sessions', kind: 'session' }] },
  'sessions.register': { inputs: { sessionId: not('the id of the session the caller registers: its own conversation') } },
  // Questions waiting for the owner.
  'approvals.list': { lists: [{ at: 'approvals', kind: 'approval' }] },
  'approvals.cancel': { inputs: { holdId: not('the raiser\'s hold on the question named beside it') } },
  'approvals.raise': { inputs: { 'request.attribution.agentId': not('who raised it, written into the question as data') } },
  // Schedules, their runs, and triggers.
  // A paged listing repeats its page under `items` (daemon-api listingEnvelope): both are the caller's.
  'automation.jobs.list': { lists: [{ at: 'jobs', kind: 'schedule' }, { at: 'items', kind: 'schedule' }] },
  'automation.schedules.list': { lists: [{ at: 'jobs', kind: 'schedule' }, { at: 'items', kind: 'schedule' }] },
  'automation.runs.list': { lists: [{ at: 'runs', kind: 'schedule-run' }, { at: 'items', kind: 'schedule-run' }] },
  'automation.jobs.create': { inputs: { id: NEW_ID } },
  'automation.jobs.update': { inputs: { jobId: 'schedule' } },
  'automation.jobs.delete': { inputs: { jobId: 'schedule' } },
  'automation.jobs.enable': { inputs: { jobId: 'schedule' } },
  'automation.jobs.disable': { inputs: { jobId: 'schedule' } },
  'automation.jobs.run': { inputs: { jobId: 'schedule' } },
  'automation.runs.get': { inputs: { runId: 'schedule-run' } },
  'automation.runs.cancel': { inputs: { runId: 'schedule-run' } },
  'automation.runs.retry': { inputs: { runId: 'schedule-run' } },
  'routes.bindings.create': { inputs: { id: NEW_ID, jobId: 'schedule', runId: 'schedule-run' } },
  'routes.bindings.update': { inputs: { bindingId: 'route-binding', jobId: 'schedule', runId: 'schedule-run' } },
  'routes.bindings.delete': { inputs: { bindingId: 'route-binding' } },
  // A binding is of the session, schedule and run it names (runtime/integration/helpers.ts, daemon-api system-routes.ts
  // filter these lists by every record a binding names, before they are answered).
  'routes.bindings.list': {},
  'routes.snapshot': {},
  // A row's `id` is the name its project chose; `storedId`, when present, is how it is kept.
  'watchers.triggers.list': { lists: [{ at: 'triggers', kind: 'trigger', idFields: ['storedId', 'id'] }] },
  'watchers.triggers.history': { inputs: { id: 'trigger' } },
  'watchers.triggers.cancel': { inputs: { id: 'trigger' } },
  'watchers.triggers.reset': { inputs: { id: 'trigger' } },
  'watchers.triggers.grant.register': { inputs: { id: not('the name of a command the owner lets triggers run (the owner\'s one list of commands, no project\'s)') } },
  'watchers.create': { inputs: { id: NEW_ID } },
  // Rules.
  'permissions.rules.list': { lists: [{ at: 'rules', kind: 'rule' }] },
  // Memory records.
  'memory.records.add': { inputs: { id: NEW_ID } },
  'memory.records.get': { inputs: { id: 'memory-record' } },
  'memory.records.update': { inputs: { id: 'memory-record' } },
  'memory.records.update-review': { inputs: { id: 'memory-record' } },
  'memory.records.delete': { inputs: { id: 'memory-record' } },
  'memory.records.links.list': { inputs: { id: 'memory-record' } },
  'memory.records.links.add': { inputs: { id: 'memory-record', toId: 'memory-record' } },
  'memory.records.import': { inputs: { 'bundle.records[].id': not('the ids of the records a bundle makes'), 'bundle.links[].fromId': not('a link inside the bundle it loads'), 'bundle.links[].toId': not('a link inside the bundle it loads') } },
  // A consolidation proposal is of the memory records it names: decided only by a caller that reaches every one; the
  // receipts of the daemon's own passes over every project's records are the owner's.
  'memory.consolidation.decide': { inputs: { proposalId: 'memory-proposal' } },
  'memory.consolidation.receipts': { lists: [{ at: 'pendingProposals', kind: 'memory-proposal' }, { at: 'receipts', kind: 'memory-proposal', ownerOnly: true }] },
  'memory.projections.get': { inputs: { id: not('a rendered view of the memory store, kept for the person, no record of a project') } },
  // Checkpoints.
  'checkpoints.list': { lists: [{ at: 'checkpoints', kind: 'checkpoint' }] },
  'checkpoints.restore': { inputs: { id: 'checkpoint' } },
  'checkpoints.restorePreview': { inputs: { id: 'checkpoint' } },
  // Named `a` and `b`, not like an id: declared here all the same (the two checkpoints compared).
  'checkpoints.diff': { inputs: { a: 'checkpoint', b: 'checkpoint' } },
  'checkpoints.create': { inputs: { agentId: not('the agent run a new checkpoint is stamped with') } },
  'sessions.checkpoints.changed': { inputs: { checkpointId: not('a checkpoint the posting program made in its own store, told to the daemon') } },
  // Agent tasks.
  'tasks.list': { lists: [{ at: 'tasks', kind: 'task' }] },
  // A task sent into a session: by its id (`sessionId`, its kind by name), or by the channel route bound to one.
  'tasks.create': { inputs: { routeId: 'route-binding' } },
  'fleet.archive': { inputs: { id: 'task' } },
  'fleet.unarchive': { inputs: { id: 'task' } },
  'fleet.observed.steer': { inputs: { id: 'task' } },
  'fleet.stop': { inputs: { id: 'task' } },
  'fleet.interrupt': { inputs: { id: 'task' } },
  'fleet.resume': { inputs: { id: 'task' } },
  'acp.sessions.create': { inputs: { agentId: not('the outside agent program to start, by its configured name') } },
  'media.collect': { inputs: { taskId: not('a provider\'s media generation job') } },
  // Files.
  'artifacts.list': { lists: [{ at: 'artifacts', kind: 'artifact' }] },
  // A capture of the owner's phone is the owner's alone (only the owner, or their own turn, asks for one: method-risk.ts `owner-act`): read
  // and deleted only by the owner (refused flat for anyone else), and listed to no one else.
  'devices.artifacts.list': { lists: [{ at: 'artifacts', kind: 'artifact', ownerOnly: true }] },
  'devices.artifacts.read': { inputs: { artifactId: not('a capture of the owner\'s phone, the owner\'s alone: read only by the owner in person') } },
  'devices.artifacts.delete': { inputs: { artifactId: not('a capture of the owner\'s phone, the owner\'s alone: deleted only by the owner in person') } },
  'media.analyze': { inputs: { 'artifact.id': 'artifact' } },
  'media.transform': { inputs: { 'artifact.id': 'artifact' } },
  'multimodal.packet': { inputs: { 'analysis.id': not('an analysis result passed back as data'), 'analysis.artifact.id': 'artifact' } },
  'multimodal.writeback': { inputs: { 'analysis.id': not('an analysis result passed back as data'), 'analysis.artifact.id': 'artifact' } },
  // Not a conversation, though named like one.
  'local_auth.sessions.delete': { inputs: { sessionId: not('a sign-in session of the daemon\'s users') } },
  'stepup.challenge.mint': { inputs: { sessionId: not('the sign-in session a step-up challenge is for') } },
  'capabilities.run': { inputs: {
    id: not('the capability to run (its inputs are declared with the capability)'),
    sessionId: not('the caller\'s own conversation: what it makes keeps only a session the caller registered'),
    approvalId: not('a call put to the owner, read back only by the credential that made it (routes/capabilities.ts readHeldCall)'),
  } },
  'hooks.trace.post': { inputs: { 'runs[].sessionId': not('the sessions a program\'s own hooks ran in, written as data of its posting'), 'runs[].id': not('a hook run the program posts') } },
  'projectPlanning.workPlan.task.create': { inputs: { 'task.agentId': not('a field of the task it makes'), 'task.taskId': NEW_ID } },
  'batch.jobs.create': { inputs: { 'source.id': not('where a batch request came from, written as data') } },
  // A provider batch job is the queued model requests of the caller that made it (`createdBy`, kept by the route).
  'batch.jobs.list': { lists: [{ at: 'jobs', kind: 'batch-job' }] },
  'batch.jobs.get': { inputs: { jobId: 'batch-job' } },
  'batch.jobs.cancel': { inputs: { jobId: 'batch-job' } },
  'knowledge.job.get': { inputs: { jobId: not('a job of the owner\'s knowledge store') } },
  'knowledge.job-runs.list': { inputs: { jobId: not('a job of the owner\'s knowledge store') } },
  'knowledge.schedule.save': { inputs: { jobId: not('a job of the owner\'s knowledge store'), id: not('a schedule of the owner\'s knowledge store') } },
  'knowledge.job.run': { inputs: { jobId: not('a job of the owner\'s knowledge store') } },
  'knowledge.job-run.cancel': { inputs: { runId: not('a run of the owner\'s knowledge store') } },
  'remote.peers.invoke': { inputs: { automationRunId: 'schedule-run', automationJobId: 'schedule' } },
  // A conversation host offers one session's conversation: listed as that session.
  'rewind.conversation.hosts.list': { lists: [{ at: 'hosts', kind: 'session', id: 'sessionId' }] },
  // A CI watch is its project's (routes/ci.ts registers its owner and filters the list before answering).
  'ci.watches.delete': { inputs: { watchId: 'ci-watch' } },
  'ci.watches.run': { inputs: { watchId: 'ci-watch' } },
  // Remote work is of the session, schedule, run and question it names (daemon-api remote-routes.ts filters the list).
  'remote.work.cancel': { inputs: { workId: 'remote-work' } },
  'channels.policies.update': { inputs: { 'groupPolicies[].id': not('a group policy of the owner\'s channel settings') } },
};

/**
 * Families whose ids (other than the kinded names) are none of a project's records, each with why. A kinded name
 * (`sessionId`, `id`, ...) in one of these is declared by its method or its kind, never here.
 */
const FAMILIES: readonly (readonly [string, string])[] = [
  ['sessions.', 'a part of the session named beside it (a message, an input, a turn, a tool call, a surface or route) or a model route'],
  ['tasks.', 'a part of the agent task named beside it, or a route or model it runs on'],
  ['approvals.', 'a part of the question named beside it, or who raised it'],
  ['companion.chat.', 'a part of the web chat named beside it (a message, a turn), or a key that makes a send safe to repeat'],
  ['automation.', 'a channel route a schedule\'s answer is delivered to (the owner\'s channels), no project\'s record'],
  // A binding by id is `route-binding` (METHODS); its lists are filtered by the session, schedule and run it names.
  ['routes.bindings.', 'a part of a channel route binding (a surface, a thread, a channel of the owner\'s accounts)'],
  ['checkpoints.', 'a part of the checkpoint or session named beside it'],
  ['workLedger.', 'Work is routed to the project its call names (project-routing.ts), which the project check holds'],
  ['inbound.telegram.', 'a delegated Telegram source of the owner\'s channels'],
  // Telemetry's records name a session and an agent: its lists, snapshot and stream keep only what the caller may reach
  // (runtime/telemetry/api.ts, by the same rule); its ids are filters (a trace, a turn, a cursor).
  ['telemetry.', 'a filter of telemetry (a trace, a turn, a cursor); the records themselves are kept by the session and agent they name'],
  ['fleet.', 'a part of the daemon\'s agent fleet named beside it'],
  ['contracts.', 'a contract is shown only to the principal that started it (its own check)'],
  // Read in the store: accounts, policies, allowlists, drafts and inbox messages are of the owner's accounts; a
  // channel's project says where its conversations work (their sessions are `session` records), not whose they are.
  ['channels.', 'the owner\'s channel accounts and what arrives on them: no record keeps a project, a session or a caller'],
  ['homeassistant.', 'the owner\'s home, no project\'s'],
  // Read in the store: a source keeps the session it was ingested from as provenance (as a memory record does), never
  // as its owner; no source, node, job or schedule keeps a project or a caller.
  ['knowledge.', 'the owner\'s one knowledge library: a source keeps where it came from, never a project or caller as its owner'],
  ['projectPlanning.', 'a project\'s planning store, reached through the project its call names'],
  ['browser.', 'the daemon\'s own browser and its pages'],
  // Read in the store: cards, standing permissions and purchases are the owner's money whatever turn asked; a
  // checkout's `sessionId` is its browser page's session, no conversation.
  ['payments.', 'the owner\'s money: no card, purchase or checkout keeps a project, a conversation or a caller'],
  ['calendar.', 'the owner\'s calendar'],
  ['email.', 'the owner\'s mail'],
  ['occasions.', 'the owner\'s dates'],
  ['profile.', 'the owner\'s profile'],
  ['pairing.', 'the daemon\'s paired devices'],
  ['stepup.', 'the daemon\'s step-up credentials'],
  ['cloudflare.', 'the owner\'s Cloudflare account'],
  ['voice.', 'a voice provider and model'],
  ['web_search.', 'a search provider'],
  ['media.', 'a media provider and model'],
  ['multimodal.', 'a media provider and model'],
  ['providers.', 'a model provider'],
  ['models.', 'a model provider'],
  ['memory.embeddings.', 'an embedding provider'],
  // A proposal by id is `memory-proposal` (METHODS): of the records it names.
  ['memory.consolidation.', 'a part of a consolidation proposal named beside it'],
  ['push.', 'a push subscription of a device'],
  ['devices.', 'a paired device node and its grants'],
  ['judgment.', 'a judgment battery run of the daemon\'s'],
  // A job by id is `batch-job` (METHODS), its maker's.
  ['batch.', 'a provider\'s batch (its own id), or where a request came from, written as data'],
  ['relay.', 'a relay code of the daemon\'s'],
  ['rewind.', 'a part of the session named beside it, or a host of its conversation'],
  // A delivery is its schedule run's: deliveries.get and the list keep only runs the caller may reach
  // (daemon-api integration-routes.ts, runtime/integration/helpers.ts).
  ['deliveries.', 'a delivery attempt, read as its schedule run is'],
  ['principals.', 'a principal of the daemon\'s'],
  ['local_auth.', 'a sign-in user or session of the daemon\'s'],
  // Read in the store: a failed notification keeps its channel, event and metadata-only words, no project or session.
  ['notifications.', 'a notification of the daemon\'s to the owner\'s webhooks: none keeps a project, a session or a caller'],
  ['control.', 'a method or a status of the daemon\'s'],
  ['capabilities.', 'a capability of the daemon\'s'],
  ['hooks.', 'a hook of a program\'s'],
  ['permissions.audit.', 'a call a program\'s gate decided, posted as data'],
  ['panels.', 'a panel of a screen'],
  // The inbox list keeps, for a caller that is not the owner in person, only questions of projects it may reach
  // (owner-inbox.ts listPageNow); every other item is the owner's own. Answering is the owner's alone (OWNER_ANSWERS_ONLY).
  ['inbox.', 'an item of the owner\'s inbox, waiting for the owner (a question of a project is read as that question)'],
  // Read in the store: a watcher (feed, file, webhook watch) keeps no project or session; triggers are `trigger`.
  ['watchers.', 'a watcher of the daemon\'s: none keeps a project, a session or a caller'],
  // A watch by id is `ci-watch` (METHODS), its project's.
  ['ci.', 'a part of a CI watch named beside it, or a repository'],
  // Work by id is `remote-work` (METHODS); peers, runners and pools are the daemon's.
  ['remote.', 'a remote peer, runner, pool or backend of the daemon\'s'],
  ['acp.', 'an outside agent program'],
  ['config.', 'a setting of the daemon\'s'],
  ['homeGraph.', 'the owner\'s home'],
  ['artifacts.', 'a file of the daemon\'s store'],
  ['skills.', 'a skill of the daemon\'s'],
  ['mcp.', 'a tool server of the daemon\'s'],
  ['memory.', 'a part of the memory record named beside it'],
];

/** A kinded name that means something else in one family (a browser's own session, a work plan's task). */
const NAMES_IN_FAMILIES: readonly (readonly [string, string, Addressed])[] = [
  ['browser.', 'sessionId', not('a session of the daemon\'s own browser, no conversation')],
  ['inbound.telegram.', 'sessionId', not('a delegated Telegram source\'s reference')],
  ['projectPlanning.', 'taskId', not('a task of the project\'s work plan, reached through the project its call names')],
];

/**
 * The families that hold none of a project's records at all (the owner's own areas, the daemon's facilities): an `id`
 * (or `ids`) of theirs is their family's, whatever the method.
 */
const FAMILIES_WITHOUT_PROJECT_RECORDS: readonly string[] = [
  'knowledge.', 'homeassistant.', 'payments.', 'email.', 'relay.', 'pairing.', 'panels.', 'capabilities.', 'control.',
  'notifications.', 'channels.', 'projectPlanning.',
];

/** The id of a method's input, as `workFolders` writes paths, read from its name. */
const ID_NAME = /^(id|ids)$|Id$|Ids$/;

/** The declaration of one input, or undefined when none is made. */
function declaredAt(methodId: string, path: string): Addressed | undefined {
  const own = METHODS[methodId]?.inputs?.[path];
  if (own !== undefined) return own;
  const name = path.split('.').pop()!.replace(/\[\]$/, '');
  const inFamily = NAMES_IN_FAMILIES.find(([prefix, named]) => methodId.startsWith(prefix) && named === name);
  if (inFamily) return inFamily[2];
  if (KINDED_NAMES.has(name)) {
    const kind = KIND_OF_NAME[name];
    if (kind === undefined) {
      // `id` in a family that holds no project's records at all is that family's.
      const holding = FAMILIES_WITHOUT_PROJECT_RECORDS.find((prefix) => methodId.startsWith(prefix));
      const family = holding ? FAMILIES.find(([prefix]) => prefix === holding) : undefined;
      return family ? not(family[1]) : undefined;
    }
    // A web chat's own session id is a chat; every other is a session.
    return kind === 'session' && methodId.startsWith('companion.chat.') ? 'chat' : kind;
  }
  const family = FAMILIES.find(([prefix]) => methodId.startsWith(prefix));
  return family ? not(family[1]) : undefined;
}

/** Every path of an input named like an id in an input schema. */
function idInputPaths(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, at: string, seen: ReadonlySet<unknown>): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    const next = new Set(seen).add(node);
    const shape = node as Record<string, unknown>;
    const properties = shape['properties'];
    if (properties !== null && typeof properties === 'object') {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        const path = at ? `${at}.${name}` : name;
        if (ID_NAME.test(name)) found.add(path);
        walk(child, path, next);
      }
    }
    if (shape['items'] !== null && typeof shape['items'] === 'object') walk(shape['items'], `${at}[]`, next);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const alternatives = shape[key];
      if (Array.isArray(alternatives)) for (const alternative of alternatives) walk(alternative, at, next);
    }
  };
  walk(schema, '', new Set());
  return [...found];
}

/** The inputs of a method that name a record of a project, by kind (the one check reads these). */
export function methodAddressesOf(methodId: string): Readonly<Record<string, RecordKind>> {
  const cached = addressCache.get(methodId);
  if (cached) return cached;
  return {};
}

/** The lists a method answers with that are filtered to what the caller may reach. */
export function methodListsOf(methodId: string): readonly ListedRecords[] {
  return METHODS[methodId]?.lists ?? [];
}

const addressCache = new Map<string, Readonly<Record<string, RecordKind>>>();

/**
 * A route the catalog does not bind (daemon/http/route-manifest.ts, an effect row), declared as a method's inputs are:
 * its inputs' kinds are kept for the one reach check under the route's id, and each path parameter named like an id
 * that it does not declare is answered (the router is then not built).
 */
export function declareRouteAddresses(routeId: string, pathParams: readonly string[], inputs: Readonly<Record<string, Addressed>>): string[] {
  const undeclared = pathParams.filter((name) => ID_NAME.test(name) && inputs[name] === undefined);
  const kinds: Record<string, RecordKind> = {};
  for (const [path, declared] of Object.entries(inputs)) if (typeof declared === 'string') kinds[path] = declared;
  addressCache.set(routeId, Object.freeze(kinds));
  return undeclared;
}

/**
 * Reads every builtin method's id inputs and their route's id parameters against the declarations: each is a kind of
 * record or says why it is none, or this throws naming them (the catalog does not load). Called once with the builtin
 * methods (method-catalog.ts).
 */
export function assertMethodAddressesDeclared(methods: readonly { readonly id: string; readonly inputSchema?: unknown; readonly http?: { readonly path: string } | undefined }[]): void {
  const undeclared: string[] = [];
  for (const method of methods) {
    const paths = new Set(idInputPaths(method.inputSchema));
    for (const param of method.http?.path.match(/\{([^}]+)\}/g) ?? []) {
      const name = param.slice(1, -1);
      if (ID_NAME.test(name)) paths.add(name);
    }
    const kinds: Record<string, RecordKind> = {};
    for (const path of paths) {
      const declared = declaredAt(method.id, path);
      if (declared === undefined) undeclared.push(`${method.id} ${path}`);
      else if (typeof declared === 'string') kinds[path] = declared;
    }
    // A method's own line may name an input under another path than its schema writes (a route parameter): kept.
    for (const [path, declared] of Object.entries(METHODS[method.id]?.inputs ?? {})) if (typeof declared === 'string') kinds[path] = declared;
    addressCache.set(method.id, Object.freeze(kinds));
  }
  if (undeclared.length > 0) {
    throw new Error(`Gateway methods take an id without declaring what it addresses (control-plane/record-addresses.ts: a kind of record, or why it is none): ${undeclared.join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The capability inputs that name a record by id and are not handed to a method (a method capability's fields reach
 * its method, whose own inputs are declared above): by capability, each input's kind or why it names none.
 */
const CAPABILITIES: Readonly<Record<string, Readonly<Record<string, Addressed>>>> = {
  'memory.show': { record: 'memory-record' },
  'memory.edit': { record: 'memory-record' },
  'memory.review': { record: 'memory-record' },
  'memory.promote': { record: 'memory-record' },
  'memory.remove': { record: 'memory-record' },
  'memory.link': { from: 'memory-record', to: 'memory-record' },
  'memory.add': { session: not('the conversation it came from: kept only when the caller registered it'), task: not('a task named as where it came from, written as data') },
  'memory.explain': { task: not('the task it explains, read as words') },
  'permissions.place': { rule: 'rule' },
  'permissions.revoke': { rule: 'rule' },
  'checkpoint.restore': { checkpoint: 'checkpoint' },
  'artifacts.show': { artifact: 'artifact' },
  'artifacts.export': { artifact: 'artifact' },
  // Several artifact ids, separated by commas: each one is looked up (caller-reach.ts `namedRecords`).
  'artifacts.package': { artifacts: 'artifact' },
  'knowledge.ingest-artifact': { artifact: 'artifact' },
  'documents.insert-artifact': { artifact: 'artifact' },
  'documents.attach-artifact': { artifact: 'artifact' },
  // A review packet preset gathers saved files by id (each one looked up; `related` holds several, separated by
  // commas): a draft is its project's, and so is every file put with it.
  'documents.save-preset': { export: 'artifact', comparison: 'artifact', judgment: 'artifact', revealed: 'artifact', decision: 'artifact',
    handoff: 'artifact', archive: 'artifact', related: 'artifact' },
  'documents.refresh-preset': { preset: 'artifact' },
  'documents.share-packet': { archive: 'artifact', to: not('who a packet is shared with') },
  'hosted.end': { session: 'session' },
  'hosted.attach': { session: 'session' },
  'agents.handed-off': { session: 'session' },
  'telegram.approve': { record: not('how long the review record is kept, a duration') },
  'mail.draft': { to: not('a mail address') },
  'mail.send': { to: not('a mail address') },
  'mail.setup': { from: not('a mail address') },
  'artifacts.list': { from: not('a time the list starts from') },
  // A remote runner's contract and what it handed back belong to the project of the work that made them (the
  // contract's `workspaceRoot`): `remote-runner` by the runner's id, `remote-artifact` by the result's.
  'remote.review': { artifact: 'remote-artifact' },
  'remote.artifact-export': { artifact: 'remote-artifact' },
  'remote.rerun-local': { artifact: 'remote-artifact' },
  'remote.show': { connection: 'remote-runner' },
  'remote.stop': { connection: 'remote-runner' },
  'remote.contract': { runner: 'remote-runner' },
  'remote.supervisor': { runner: 'remote-runner' },
  'remote.capabilities': { runner: 'remote-runner' },
  'remote.recover': { runner: 'remote-runner' },
  'remote.assign': { runner: 'remote-runner' },
  'remote.unassign': { runner: 'remote-runner' },
  'remote.export': { runner: 'remote-runner' },
  'telegram.configure': { chat: not('a Telegram chat of the owner\'s channels') },
  'telegram.release': { chat: not('a Telegram chat of the owner\'s channels') },
  'local-auth.sign-out': { session: not('a sign-in session of the daemon\'s users') },
  'chats.project': { chat: 'chat' },
  // `work`: a piece of Work, routed to the project its call names (control-plane/project-routing.ts), which the
  // project check holds; it names nothing of another project's.
  ...Object.fromEntries(['work.start', 'work.status', 'work.cancel', 'work.resume', 'work.answer', 'work.retry', 'work.go-on-without',
    'work.budget', 'work.plan-redo', 'work.step-edit', 'work.step-drop', 'work.step-move', 'work.approve', 'work.plan-discard',
    'work.branch-merge', 'work.branch-discard']
    .map((id) => [id, { work: not('a piece of Work, routed to the project the call names (project-routing.ts), held by the project check') }])),
  // `worktree`: a worktree folder of the caller's project, handed to its method as `path`, a work folder the folder
  // check holds (caller-paths.ts).
  'worktree.setup': { worktree: not('a worktree folder of the caller\'s project: its method\'s `path`, held by the folder check') },
  'worktree.discard': { worktree: not('a worktree folder of the caller\'s project: its method\'s `path`, held by the folder check') },
  // `task`: what to do, in words (no record's id).
  'knowledge.packet': { task: not('what the packet is for, in words') },
  'remote.dispatch': { task: not('the work to send, in words') },
  'remote.dispatch-pool': { task: not('the work to send, in words') },
  'media.collect': { task: not('a provider\'s media generation job, the provider\'s id') },
  'work.daemon-task-add': { task: not('what the agent does, in words') },
  'agents.hand-off': { task: not('the work handed on, in words') },
  'compare.run': { task: not('a tag of the comparison, in words') },
  'compare.analytics': { task: not('a tag of the comparisons, in words') },
};

/** Capability input ids that name a record by id: each is declared above, or handed to its method, or the catalog stops. */
const CAPABILITY_RECORD_INPUT = /^(record|session|approval|schedule|trigger|rule|checkpoint|chat|artifact|artifacts|from|to|work|task|worktree|runner|connection)$/;

/** A daemon capability's inputs that name a record of a project, by kind. */
export function capabilityAddressesOf(capabilityId: string): Readonly<Record<string, RecordKind>> {
  const declared = CAPABILITIES[capabilityId] ?? {};
  return Object.fromEntries(Object.entries(declared).filter((entry): entry is [string, RecordKind] => typeof entry[1] === 'string'));
}

/**
 * Reads the daemon's capabilities against the declarations: an input that names a record of a run-by-the-daemon
 * capability (not handed to a method, whose inputs are declared above) is declared, or this throws naming them.
 */
export function assertCapabilityAddressesDeclared(definitions: readonly { readonly capability: { readonly id: string; readonly home?: string }; readonly inputs: readonly { readonly id: string }[]; readonly method?: unknown }[]): void {
  const undeclared = definitions.flatMap((definition) => definition.method !== undefined || definition.capability.home === 'session' ? []
    : definition.inputs.filter((input) => CAPABILITY_RECORD_INPUT.test(input.id) && CAPABILITIES[definition.capability.id]?.[input.id] === undefined)
      .map((input) => `${definition.capability.id} ${input.id}`));
  if (undeclared.length > 0) {
    throw new Error(`Capabilities take a record by id without declaring what it addresses (control-plane/record-addresses.ts): ${undeclared.join(', ')}.`);
  }
}
