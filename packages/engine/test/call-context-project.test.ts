// Proves: A daemon capability acts in another project than the one its call names, in the daemon's own folder when the call names none, or in a project its caller may not name, also through another input than its project that names a folder a process works in; or a refusing rule is escaped by naming another project.
// Red when: The daemon stops reading a program's project header into the call's context, capabilities.run stops taking the project from that context or lets it outrank the body's folder, a per-project service takes the daemon's working folder in place of a missing project instead of refusing, the daemon's dispatch runs a paired device's call in the root, the home folder, the daemon home or a project the owner did not give it, or lets its outside coding agent's cwd name such a project, or a deny rule kept in one project stops applying when the call names another.
// Proves: A member the owner removed keeps the projects the owner gave them, so a user made later with the same name may act in them.
// Red when: Removing a member who has no sign-in open no longer tells the daemon, so the projects given to that member stay kept under their name.
// Proves: A caller the owner gave some projects reaches by id another project's web chat, memory record, question waiting for the owner, checkpoint or saved artifact, or a refusal tells it that such a record exists.
// Red when: The dispatch stops running its one check of what a caller may reach before a method's handler or route, a kind's owner lookup stops giving the record's project or maker, a capability input naming several records by id is not declared or not read one id at a time, or the refusal's words for another project's record differ from those for no record.
// Proves: A device the owner gave one project, following the daemon's event stream, receives another project's events (its questions, its chats' turns) while the owner works there.
// Red when: The gateway stops asking each stream's reach before it sends a frame, or an event's question or session no longer resolves to the project it belongs to, so the device given yellow is sent zinc's question or zinc's chat turn.
// Proves: A route the daemon serves outside its method catalog, or a route reached by its path over the daemon's socket, runs for a caller without the checks of its project and of what it may reach.
// Red when: The router stops reading an uncatalogued route's declaration in its folder and reach checks, or the socket's method-and-path call goes straight to its route, so the kiosk given yellow follows zinc's chat or starts a task in zinc.
// Proves: A paired device holding the default scopes is refused starting a session in a project the owner gave it, or starts one in a project the owner did not give it.
// Red when: sessions.create is held at an admin again (its effect sessions.administer, or write:sessions dropped from the default list), so the default credential is refused in yellow, or the dispatch stops checking the project its body names both by its one project check and by its work-folder check, so it names zinc.
/**
 * One daemon, its own working folder and two projects. The calls go through the
 * daemon's real pieces: the header reader of its HTTP routes (daemon-api
 * `readCallContext`), its dispatch (authentication, admission), `capabilities.run`
 * and the capability services over the MCP config files. Nothing stands in for
 * the product: the method a capability might run is not reached here.
 *
 * A terminal program sends its project once per request as a header; the web UI
 * and an outside caller name it in the body. Either way the call acts there, the
 * body's folder first, and a subfolder of a repository is that repository's
 * project; with no project only the files for every project are read (never the
 * daemon folder's), and the daemon's own folder is used only when a caller names it.
 * A paired device names only a registered project the owner gave it, checked by the
 * daemon's one check of a caller's project before anything runs; and a rule that
 * refuses a capability, kept in one project, is among the rules of every project.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCallContext } from '../daemon-api/src/control-routes.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerCapabilityGatewayMethods } from '../platform/src/platform/control-plane/routes/capabilities.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { createHookDispatcher } from '../platform/src/platform/hooks/index.ts';
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { CapabilityCatalog, createDaemonCapabilityServices, movedCapabilityEntries } from '../platform/src/platform/capabilities/index.ts';
import { CALL_PROJECT_HEADER } from '../platform/src/platform/runtime/client/call-context.ts';
import { daemonCallerProjectCheck, daemonCallerProjectsForget } from '../platform/src/platform/daemon/facade-composition.ts';
import { CallerProjectsStore } from '../platform/src/platform/workspace/caller-projects-store.ts';
import { resolveGoodVibesDaemonHome } from '../platform/src/platform/config/goodvibes-home.ts';
import { pairingPrincipalId } from '../platform/src/platform/pairing/principal-ids.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { execFileSync } from 'node:child_process';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { registerRecordOwners } from '../platform/src/platform/daemon/record-owners.ts';
import { registerCheckpointGatewayMethods } from '../platform/src/platform/control-plane/routes/checkpoints.ts';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.ts';
import { memoryProjectOf } from '../platform/src/platform/state/memory-project.ts';
import { emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.ts';
import { RUNTIME_EVENT_DOMAINS } from '../platform/src/platform/runtime/events/index.ts';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';
import { createCapabilityOwnerGate } from '../platform/src/platform/daemon/capability-owner-gate.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { DEFAULT_PAIRED_SCOPES } from '../platform/src/platform/control-plane/routes/pairing.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';
let dir: string;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('a capability acts in the project its call names, from its subfolder too, by header or body; with none only the files for every project; the daemon\'s folder only when named; a device only in a project given to it; a refusing rule in every project', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-call-context-'));
  const home = join(dir, 'home');
  const daemonFolder = join(dir, 'daemon-own');
  const yellow = join(dir, 'projects', 'yellow');
  const zinc = join(dir, 'projects', 'zinc');
  // yellow is a repository with a subfolder: a program opened in the subfolder is in yellow (project-identity.ts).
  for (const folder of [home, daemonFolder, yellow, zinc, join(yellow, '.git'), join(yellow, 'sub')]) mkdirSync(folder, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: daemonFolder, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  const secrets = new SecretsManager({ projectRoot: daemonFolder, globalHome: home, surfaceRoot: 'daemon', daemonHome: join(home, '.goodvibes', 'daemon') });
  const memoryStore = new MemoryStore(join(dir, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(dir, 'memory-config') }) }) });
  cleanups.push(() => memoryStore.close());
  await memoryStore.init();
  const hookDispatcher = createHookDispatcher();
  const catalog = new GatewayMethodCatalog();
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  // The owner's questions and rules, and `capabilities.run` with the owner's gate under ask-me, as the daemon composes them
  // (capability-wiring.ts): a call another caller makes that changes something is put to the owner and waits.
  const approvals = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await approvals.start();
  const rules = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
  cleanups.push(() => rules.close());
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], localOwnerActor()).ok).toBe(true);
  registerCapabilityGatewayMethods(catalog, {
    catalog: async () => new CapabilityCatalog(movedCapabilityEntries()),
    services: createDaemonCapabilityServices({ configManager: config, hookDispatcher, homeDirectory: home,
      secretsManager: secrets, memoryRegistry }),
    invokeMethod: async (methodId) => { throw new Error(`no method ${methodId} is reached in this proof`); },
    ...createCapabilityOwnerGate({ approvalBroker: approvals, configManager: config, policyRuntimeState: new PolicyRuntimeState(), hookDispatcher,
      featureFlags: null, userPermissionRuleStore: rules, secretsManager: secrets, pairingTokens: pairing,
    } as unknown as Parameters<typeof createCapabilityOwnerGate>[0]),
  });
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const bus = new RuntimeEventBus();
  const gateway = new ControlPlaneGateway({ runtimeBus: bus });
  // What a caller follows is held to the same rule as what it reaches (control-plane/event-reach.ts), as the daemon sets it.
  gateway.setEventReachRules(() => catalog.reachRules());
  const helperContext = {
    gatewayMethods: catalog, pairingTokens: pairing, userAuth,
    controlPlaneGateway: gateway,
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    // The daemon's one check of a caller's project, and what it forgets for a caller that is gone, as the daemon
    // composes them (facade-composition.ts).
    callerProject: daemonCallerProjectCheck(home),
    forgetCallerProjects: daemonCallerProjectsForget(home),
  };
  const helper = new DaemonControlPlaneHelper(helperContext as unknown as DaemonControlPlaneContext);
  helper.watchRevocations();
  cleanups.push(() => helper.dispose());

  // The owner in person, on their own signed-in session (the account made at first start): who names any project. The
  // operator token alone is a script, and a paired device, the owner's own included, is never the owner in person
  // (daemon/method-owner-decision.ts `ownerHimself`): each names only what the owner gave it.
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  const ownersSession = userAuth.createSession(ownerName).token;
  // The project folder of the MCP files a read of them names, or the refusal: where the call acted.
  const actedIn = async (headers: Record<string, string>, body: Record<string, unknown>, id = 'mcp.files', token = ownersSession): Promise<string> => {
    const call = readCallContext(new Request('http://daemon.local/api/control-plane/methods/capabilities.run/invoke', { method: 'POST', headers }));
    const answer = await helper.invokeGatewayMethodCall({ authToken: token, methodId: 'capabilities.run',
      // As the HTTP route sends it: the context carries the credential's own admin flag (a context never widens it).
      body: { id, inputs: {}, ...body }, context: { clientKind: 'tui', admin: true, ...(call ? { call } : {}) } });
    if (!answer.ok) return `refused ${answer.status} ${String((answer.body as { code?: unknown }).code)}`;
    const locations = ((answer.body as { data?: { locations?: Array<{ kind?: string; path?: string }> } }).data?.locations ?? []);
    const project = locations.find((location) => location.kind === 'project-goodvibes')?.path;
    return project ?? `no project file, ${locations.filter((location) => location.kind === 'global-xdg').length} for every project`;
  };
  const header = { [CALL_PROJECT_HEADER]: encodeURIComponent(yellow) };

  // Two paired devices: yellow and zinc are registered workspaces, and the owner gave the kiosk yellow only. The root is
  // registered too (after the rows above) and given whole to the other device: the root, the home folder and the daemon
  // home stay no project whatever was registered or given.
  const register = (roots: readonly string[]): string => {
    mkdirSync(join(home, '.goodvibes', 'shared'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'shared', 'workspace-registrations.json'), JSON.stringify({ workspaces: roots.map((root) => ({ root })) }));
    return '';
  };
  const kiosk = pairing.mint({ name: 'kiosk' });
  const everywhere = pairing.mint({ name: 'given the root' });
  const given = new CallerProjectsStore(resolveGoodVibesDaemonHome(home));
  given.set(pairingPrincipalId(kiosk.id), [yellow]);
  given.set(pairingPrincipalId(everywhere.id), ['/']);
  const asDevice = (token: string, folder: string): Promise<string> => actedIn({}, { workingDirectory: folder }, 'mcp.files', token);
  // A member the owner gave yellow, then removed while signed out: a user made later with that member's name gets nothing of theirs.
  userAuth.addUser('member1', ['correct', 'horse', 'battery', 'member'].join('-'), ['admin']);
  given.set('member1', [yellow]);
  const removedMember = (): string => {
    const before = given.projectsOf('member1').length;
    userAuth.deleteUser('member1');
    return `member given ${before} project, removed while signed out, keeps ${given.projectsOf('member1').length}`;
  };
  // A folder a process will work in named by another input than the project (an outside coding agent's cwd): the code
  // the dispatch answered, or that it got past the project check (no agent is installed here, so nothing starts).
  const agentIn = async (token: string, cwd: string): Promise<string> => {
    const answer = await helper.invokeGatewayMethodCall({ authToken: token, methodId: 'acp.sessions.create', body: { agentId: 'no-such-agent', cwd }, context: { clientKind: 'tui' } });
    const code = String((answer.body as { code?: unknown }).code);
    return code === 'PROJECT_NOT_ALLOWED' ? `refused ${answer.status} ${code}` : 'past the project check';
  };

  // A rule that refuses a capability, kept in yellow, and one that allows another there: the refusal is among zinc's rules.
  for (const [id, effect, capability] of [['refuses-in-yellow', 'deny', 'mcp.files'], ['allows-in-yellow', 'allow', 'memory.list']] as const) {
    await rules.add({ rule: { id, type: 'arg-shape', toolPattern: 'capability_run', argMatchers: { id: capability }, effect, origin: 'user' }, createdAt: Date.now(), tier: 'tool', tool: 'capability_run', project: yellow });
  }

  // What the daemon keeps in zinc and in yellow, in its real stores, each kind's owner looked up as the daemon composes it
  // (daemon/record-owners.ts, routes/checkpoints.ts): the owner's web chat in zinc and the kiosk's own in yellow, a "this
  // project" memory record and a question waiting for the owner in each, and a checkpoint of zinc's store. A device the
  // owner gave zinc is the control that a checkpoint of zinc is reached by a caller zinc was given.
  const chats = new CompanionChatManager({ provider: { async *chatStream() { yield { type: 'done' as const }; } }, eventPublisher: { publishEvent: () => {} }, sessionsDir: join(dir, 'chats'), persist: false, rateLimiter: false });
  await chats.init();
  cleanups.push(() => { void chats.close(); });
  registerRecordOwners(catalog, { chats, approvals, memory: memoryRegistry });
  execFileSync('git', ['init', '-q', '-b', 'main', zinc]);
  execFileSync('git', ['-c', 'user.email=owner@example.invalid', '-c', 'user.name=Owner', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: zinc });
  const zincCheckpoints = new WorkspaceCheckpointManager({ workspaceRoot: zinc, autoRetention: false });
  cleanups.push(() => { zincCheckpoints.dispose(); });
  registerCheckpointGatewayMethods(catalog, zincCheckpoints);
  const zincDevice = pairing.mint({ name: 'given zinc' });
  given.set(pairingPrincipalId(zincDevice.id), [zinc]);
  const zincChat = chats.createSession({ project: zinc }).id;
  const kioskChat = chats.createSession({ project: yellow, createdBy: pairingPrincipalId(kiosk.id) }).id;
  // The device given yellow and the device given zinc follow the event stream, each as the daemon opens it for its
  // credential; the questions below are published to it, and a turn of zinc's chat and of the kiosk's own is emitted.
  approvals.setPublisher(gateway);
  // yellow and zinc are registered projects before anything is followed (a project not registered is no one's to name).
  // The root is registered only from the device rows on: registered before, it would be the project of every folder below it.
  register([yellow, zinc]);
  // A socket client of the gateway, as the daemon opens one for a credential: every frame it is sent, as sent.
  const follow = (token: string): { readonly done: () => Promise<string> } => {
    const principal = helper.describeRequestPrincipal(token, true)!;
    const frames: string[] = [];
    const opened = gateway.openWebSocketClient({
      transport: 'ws', domains: [...RUNTIME_EVENT_DOMAINS], principalId: principal.principalId, scopes: principal.scopes, admin: principal.admin,
      reachContext: { credentialKind: principal.credentialKind, principalId: principal.principalId, actor: principal.actor },
    }, (event, payload) => { frames.push(`${event} ${JSON.stringify(payload)}`); });
    cleanups.push(() => gateway.closeWebSocketClient(opened.clientId));
    // The bus hands a runtime event to its listeners in a microtask queued at emit (runtime/events): read after it ran.
    return { done: async () => { await Promise.resolve(); return frames.join('\n'); } };
  };
  const kioskFollows = follow(kiosk.token);
  const zincDeviceFollows = follow(zincDevice.token);
  const remembered = async (folder: string): Promise<string> => (await memoryRegistry.add({ scope: 'project', project: memoryProjectOf(folder)!, cls: 'fact', summary: `a fact of ${folder}`, tags: [], provenance: [] })).id;
  const zincRecord = await remembered(zinc);
  const yellowRecord = await remembered(yellow);
  const question = async (folder: string): Promise<string> => (await approvals.raiseApproval({ request: { callId: `call-${folder}`, tool: 'exec', args: { command: 'bun test' }, category: 'execute', workingDirectory: folder,
    analysis: { classification: 'command', riskLevel: 'medium', summary: 'Run bun test', reasons: [] } } })).approval.id;
  const zincQuestion = await question(zinc);
  const yellowQuestion = await question(yellow);
  for (const [sessionId, turnId] of [[zincChat, 'zinc-turn'], [kioskChat, 'kiosk-turn']] as const) {
    emitTurnSubmitted(bus, { sessionId, source: 'call-context-project' }, { turnId, prompt: `words of ${turnId}` });
  }
  const kioskSaw = await kioskFollows.done();
  const zincDeviceSaw = await zincDeviceFollows.done();
  writeFileSync(join(zinc, 'notes.txt'), 'zinc\n');
  const zincCheckpoint = (await zincCheckpoints.create({ kind: 'manual', label: 'zinc' }))?.id ?? '';
  // By id, as the kiosk (given yellow) or the device given zinc, each an admin pairing as a paired device is: refused
  // before any handler, or past the check (to the handler, or to a route this proof serves none of).
  const byId = async (token: string, methodId: string, body: Record<string, unknown>): Promise<string> => {
    try {
      const answer = await helper.invokeGatewayMethodCall({ authToken: token, methodId, body, context: { clientKind: 'tui', admin: true } });
      const code = String((answer.body as { code?: unknown }).code);
      return code === 'RECORD_NOT_YOURS' ? `refused ${answer.status} ${code}` : 'past the check';
    } catch { return 'past the check'; }
  };
  // The words of a refusal for a record of another project, and for no record at all: the same but for the id.
  const wordsFor = async (sessionId: string): Promise<string> => {
    try {
      const answer = await helper.invokeGatewayMethodCall({ authToken: kiosk.token, methodId: 'companion.chat.messages.list', body: { sessionId }, context: { clientKind: 'tui', admin: true } });
      return String((answer.body as { error?: unknown }).error).replace(sessionId, '<id>');
    } catch { return `past the check for ${sessionId}`; }
  };

  // The daemon's HTTP router over the same catalog and the same authentication, as the daemon builds it, and the socket's
  // method-and-path call sent to it (the dispatch's `dispatchApiRoutes`). A route outside the catalog (a session's event
  // stream, an effect row of daemon/http/route-manifest.ts) and a route reached by its path over the socket pass the
  // same checks a method does before they run: refused, or past the check (to a route this proof serves none of).
  const bearerOf = (req: Request): string => /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const router = new DaemonHttpRouter({
    configManager: config, gatewayMethods: catalog, runtimeBus: bus, userAuth, authToken: () => OPERATOR_TOKEN,
    authenticateRequest: (req: Request) => { const principal = helper.describeRequestPrincipal(bearerOf(req), true); return principal ? { principal } : null; },
    extractAuthToken: bearerOf, artifactStore: { getMaxBytes: () => 1 }, channelPlugins: { getByPath: () => undefined },
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);
  cleanups.push(() => { void router.dispose(); });
  Object.assign(helperContext, { dispatchApiRoutes: (req: Request) => router.dispatchApiRoutes(req) });
  const routeAnswer = (status: number, body: unknown): string => {
    const code = String((body as { code?: unknown } | null)?.code);
    return status === 403 && (code === 'RECORD_NOT_YOURS' || code === 'PROJECT_NOT_ALLOWED') ? `refused ${status} ${code}` : 'past the check';
  };
  const streamOf = async (token: string, sessionId: string): Promise<string> => {
    const response = await router.handleRequest(new Request(`http://127.0.0.1/api/sessions/${sessionId}/events`, { headers: { authorization: `Bearer ${token}` } }));
    const body: unknown = await response.json().catch(() => null);
    return routeAnswer(response.status, body);
  };
  const socketTask = async (token: string, folder: string): Promise<string> => {
    const principal = helper.describeRequestPrincipal(token, true)!;
    const answer = await helper.invokeWebSocketControlPlaneCall({ authToken: token, method: 'POST', path: '/task', body: { task: 'a task', workingDirectory: folder }, principal,
      context: { principalKind: principal.principalKind, admin: principal.admin, scopes: principal.scopes, actor: principal.actor } });
    return routeAnswer(answer.status, answer.body);
  };
  // A credential the owner made naming no scopes (the default list, routes/pairing.ts `DEFAULT_PAIRED_SCOPES`: a paired
  // device below an admin) given yellow: starting a session is a project act it may make there (effect-authority.ts
  // `sessions.write`), and never in a project it was not given (the method's `workingDirectory`, checked by the dispatch).
  // Any refusal is shown by its code; past the checks the call reaches a route this proof serves none of.
  const defaultDevice = pairing.mint({ name: 'default device', scopes: [...DEFAULT_PAIRED_SCOPES] });
  given.set(pairingPrincipalId(defaultDevice.id), [yellow]);
  const defaultSession = async (folder: string): Promise<string> => {
    try {
      const answer = await helper.invokeGatewayMethodCall({ authToken: defaultDevice.token, methodId: 'sessions.create', body: { title: 'from the default device', workingDirectory: folder }, context: { clientKind: 'tui', admin: false } });
      const code = String((answer.body as { code?: unknown }).code);
      return answer.status === 401 || answer.status === 403 ? `refused ${answer.status} ${code}` : 'past the check';
    } catch { return 'past the check'; }
  };
  // Under Ask me a call that got past these checks waits on the owner's one answer; the owner answers No to each question raised
  // from here on, so a row reads only how far its call got (a refusal of the project or record, or past the check).
  const known = new Set(approvals.listApprovals(Number.MAX_SAFE_INTEGER).map((record) => record.id));
  const stopAnswering = approvals.subscribe((record) => {
    if (known.has(record.id) || record.status !== 'pending') return;
    known.add(record.id);
    void approvals.resolveApproval(record.id, { approved: false, actor: 'owner', expectedRevision: record.revision, reason: 'Not now.' }).catch(() => undefined);
  });
  const rows = [
    `header ${await actedIn(header, {})}`,
    `subfolder ${await actedIn({ [CALL_PROJECT_HEADER]: encodeURIComponent(join(yellow, 'sub')) }, {})}`,
    `body over header ${await actedIn(header, { workingDirectory: zinc })}`,
    `none ${await actedIn({}, {})}`,
    `daemon's folder named ${await actedIn({}, { workingDirectory: daemonFolder })}`,
    `${register(['/', yellow, zinc])}device in the root ${await asDevice(everywhere.token, '/')}`,
    `device in the home folder ${await asDevice(everywhere.token, home)}`,
    `device in the daemon home ${await asDevice(everywhere.token, resolveGoodVibesDaemonHome(home))}`,
    `device in a project not given to it ${await asDevice(kiosk.token, zinc)}`,
    `device in the project given to it ${await asDevice(kiosk.token, yellow)}`,
    `device's outside agent in a project not given to it ${await agentIn(kiosk.token, zinc)}`,
    `device's outside agent in the project given to it ${await agentIn(kiosk.token, yellow)}`,
    `rules kept in yellow that apply in zinc ${rules.rules(zinc).map((rule) => rule.id).join(',')}`,
    `device by id: zinc's web chat ${await byId(kiosk.token, 'companion.chat.messages.list', { sessionId: zincChat })}`,
    `device by id: its own web chat in yellow ${await byId(kiosk.token, 'companion.chat.messages.list', { sessionId: kioskChat })}`,
    `device by id: zinc's memory record ${await byId(kiosk.token, 'capabilities.run', { id: 'memory.show', inputs: { record: zincRecord }, workingDirectory: yellow })}`,
    `device by id: yellow's memory record ${await byId(kiosk.token, 'capabilities.run', { id: 'memory.show', inputs: { record: yellowRecord }, workingDirectory: yellow })}`,
    `device by id: zinc's question ${await byId(kiosk.token, 'approvals.claim', { approvalId: zincQuestion, expectedRevision: 1 })}`,
    `device by id: yellow's question ${await byId(kiosk.token, 'approvals.claim', { approvalId: yellowQuestion, expectedRevision: 1 })}`,
    `device by id: zinc's checkpoint ${await byId(kiosk.token, 'checkpoints.restorePreview', { id: zincCheckpoint })}`,
    `device given zinc by id: zinc's checkpoint ${await byId(zincDevice.token, 'checkpoints.restorePreview', { id: zincCheckpoint })}`,
    // Saved artifacts named among several, separated by commas (artifacts.package): each one is checked (this proof's
    // daemon keeps no artifact owner lookup, so none of them is the device's to reach).
    `device by id: artifacts among several ${await byId(kiosk.token, 'capabilities.run', { id: 'artifacts.package', inputs: { artifacts: 'artifact-zinc-1, artifact-zinc-2', path: 'pkg' }, workingDirectory: yellow })}`,
    `the words for zinc's chat are those for no chat ${await wordsFor(zincChat) === await wordsFor('no-such-chat')}`,
    `device following: zinc's question ${kioskSaw.includes(zincQuestion)}, zinc's chat turn ${kioskSaw.includes('zinc-turn')}`,
    `device following: yellow's question ${kioskSaw.includes(yellowQuestion)}, its own chat's turn ${kioskSaw.includes('kiosk-turn')}`,
    `device given zinc following: zinc's question ${zincDeviceSaw.includes(zincQuestion)}, yellow's question ${zincDeviceSaw.includes(yellowQuestion)}`,
    `route outside the catalog: the kiosk opens zinc's chat's event stream ${await streamOf(kiosk.token, zincChat)}`,
    `route outside the catalog: the kiosk opens its own chat's event stream ${await streamOf(kiosk.token, kioskChat)}`,
    `socket path call: the kiosk starts a task in zinc ${await socketTask(kiosk.token, zinc)}`,
    `socket path call: the kiosk starts a task in yellow ${await socketTask(kiosk.token, yellow)}`,
    `default credential starts a session in yellow ${await defaultSession(yellow)}`,
    `default credential starts a session in zinc ${await defaultSession(zinc)}`,
    removedMember(),
  ];
  stopAnswering();
  expect(rows).toEqual([
    `header ${join(yellow, '.goodvibes', 'mcp.json')}`,
    `subfolder ${join(yellow, '.goodvibes', 'mcp.json')}`,
    `body over header ${join(zinc, '.goodvibes', 'mcp.json')}`,
    'none no project file, 1 for every project',
    `daemon's folder named ${join(daemonFolder, '.goodvibes', 'mcp.json')}`,
    'device in the root refused 403 PROJECT_NOT_ALLOWED',
    'device in the home folder refused 403 PROJECT_NOT_ALLOWED',
    'device in the daemon home refused 403 PROJECT_NOT_ALLOWED',
    'device in a project not given to it refused 403 PROJECT_NOT_ALLOWED',
    `device in the project given to it ${join(yellow, '.goodvibes', 'mcp.json')}`,
    'device\'s outside agent in a project not given to it refused 403 PROJECT_NOT_ALLOWED',
    'device\'s outside agent in the project given to it past the project check',
    'rules kept in yellow that apply in zinc refuses-in-yellow',
    'device by id: zinc\'s web chat refused 403 RECORD_NOT_YOURS',
    'device by id: its own web chat in yellow past the check',
    'device by id: zinc\'s memory record refused 403 RECORD_NOT_YOURS',
    'device by id: yellow\'s memory record past the check',
    'device by id: zinc\'s question refused 403 RECORD_NOT_YOURS',
    'device by id: yellow\'s question past the check',
    'device by id: zinc\'s checkpoint refused 403 RECORD_NOT_YOURS',
    'device given zinc by id: zinc\'s checkpoint past the check',
    'device by id: artifacts among several refused 403 RECORD_NOT_YOURS',
    'the words for zinc\'s chat are those for no chat true',
    'device following: zinc\'s question false, zinc\'s chat turn false',
    'device following: yellow\'s question true, its own chat\'s turn true',
    'device given zinc following: zinc\'s question true, yellow\'s question false',
    'route outside the catalog: the kiosk opens zinc\'s chat\'s event stream refused 403 RECORD_NOT_YOURS',
    'route outside the catalog: the kiosk opens its own chat\'s event stream past the check',
    'socket path call: the kiosk starts a task in zinc refused 403 PROJECT_NOT_ALLOWED',
    'socket path call: the kiosk starts a task in yellow past the check',
    'default credential starts a session in yellow past the check',
    'default credential starts a session in zinc refused 403 PROJECT_NOT_ALLOWED',
    'member given 1 project, removed while signed out, keeps 0',
  ]);
});
