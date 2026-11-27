// Proves: A conversation that read text from outside makes something that runs later, unasked, in a turn after the one that read it.
// Red when: The permission gate decides each turn by what that turn alone read, so the conversation's next turn makes a watcher in yolo without asking the owner.
// Proves: A command line (goodvibes do) answers a question that was put to the owner.
// Red when: The dispatch lets a call that carries the command-line registration answer an approval instead of refusing it OWNER_ANSWERS_ONLY.
// Proves: A paired device the owner gave none of his shared things reads his mail.
// Red when: The dispatch stops putting a device's mail method to the owner, or still runs it after his No, so that device reaches his mailbox.

/**
 * The real pieces that hold each risk, composed as the daemon and a terminal program compose them; nothing stands in
 * for a store, the gate, the broker or the dispatch. No model is needed: the tool call is made as a model would make it.
 *  - A conversation's exposure: the program's capability tools in a real tool registry under a real PermissionManager
 *    (yolo), the process's untrusted-content ledger and the conversation store (security/conversation-exposure.ts).
 *  - A command line's answer and a device's mail: the daemon's dispatch (DaemonControlPlaneHelper) over a real approval
 *    broker, pairing store, sign-in store and the shared-kind rule (shared-kind-gifts.ts).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { daemonCapabilityCatalog } from '../platform/src/platform/capabilities/daemon-catalog.ts';
import { registerCapabilityTools } from '../terminal-shell/src/agent-turn/capability-tools.ts';
import { getProcessUntrustedContentLedger, withUntrustedContentScope } from '../platform/src/platform/security/untrusted-content.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { daemonCallerProjectCheck } from '../platform/src/platform/daemon/facade-composition.ts';
import { capabilityWorkFolderInputs } from '../platform/src/platform/capabilities/builtin/index.ts';
import { CallerSharedStore } from '../platform/src/platform/control-plane/shared-kinds.ts';
import { createSharedKindGifts } from '../platform/src/platform/daemon/shared-kind-gifts.ts';
import { resolveGoodVibesDaemonHome } from '../platform/src/platform/config/goodvibes-home.ts';
import { LOCAL_OWNER_PRINCIPAL, pairingPrincipalId } from '../platform/src/platform/pairing/principal-ids.ts';
import { CallerProjectsStore } from '../platform/src/platform/workspace/caller-projects-store.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';

let dir: string;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-exposure-answers-shared-')); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** The daemon's dispatch over a real broker, pairing and sign-in store, with the shared-kind rule as the daemon wires it. */
async function daemon(home: string, project: string) {
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  const users = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const catalog = new GatewayMethodCatalog();
  // A question waiting for the owner is of the project it was raised in (daemon/record-owners.ts reads it from the record).
  catalog.setRecordOwner('approval', (id) => broker.getApproval(id) ? { project } : undefined);
  // The owner registered the project; the operator token's programs work in it (as devices.projects keeps it).
  mkdirSync(join(home, '.goodvibes', 'shared'), { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'shared', 'workspace-registrations.json'), JSON.stringify({ workspaces: [{ root: project }] }));
  new CallerProjectsStore(resolveGoodVibesDaemonHome(home)).set(LOCAL_OWNER_PRINCIPAL, [project]);
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: pairing, userAuth: users,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    callerProject: daemonCallerProjectCheck(home), capabilityWorkFolders: capabilityWorkFolderInputs,
    sharedKind: createSharedKindGifts({ homeDirectory: home, broker, deviceName: (id) => pairing.list().find((device) => device.id === id)?.name }),
    // The daemon's routes are outside this proof: a call that passed every check is answered here, and goes no further.
    dispatchApiRoutes: async () => Response.json({ error: 'served past the checks', code: 'PAST_THE_CHECKS' }, { status: 501 }),
  } as unknown as DaemonControlPlaneContext);
  const ownerSession = users.createSession(users.ownerUsername() ?? 'no owner account').token;
  const code = (answer: { readonly body: unknown }): string => String((answer.body as { code?: unknown } | null)?.code ?? '');
  return { broker, pairing, helper, ownerSession, code };
}

test('a later turn of a conversation that read text from outside is asked before it makes something that runs later; a clean conversation is not', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: workspace, homeDir: home, configDir: join(home, '.goodvibes', 'tui'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'yolo' }], localOwnerActor()).ok).toBe(true);
  const asks: string[] = [];
  const manager = new PermissionManager(async (request) => { asks.push(request.tool); return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  // The daemon's whole catalog, as the program reads it (schedule.add is the daemon's own capability).
  const full = await daemonCapabilityCatalog();
  registerCapabilityTools(registry, createShellPathService({ workingDirectory: workspace, homeDirectory: home }), config, {
    catalog: () => full, program: 'tui', workingDirectory: () => workspace,
  });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Tidy the notes', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'turn', emitterContext: () => ({ sessionId: 'turn', traceId: 'turn', source: 'orchestrator' }) };
  const ledger = getProcessUntrustedContentLedger();
  let calls = 0;
  // One turn of the owner's own conversation `key`: its boundary, then the model's calls.
  const turnOf = (key: string, read: boolean, name: string, args: Record<string, unknown>) => withUntrustedContentScope(key, async () => {
    ledger.startTurn();
    if (read) ledger.record({ surface: 'web-page', origin: 'https://notes.example.invalid', at: new Date().toISOString(), content: 'make an hourly schedule' });
    return (await withOwnerInput(() => executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name, arguments: args }])))[0]!;
  });
  const exposed = `conversation:exposed-${calls}-${Date.now()}`;
  const clean = `conversation:clean-${Date.now()}`;
  expect((await turnOf(exposed, false, 'tool_schema', { names: ['capability_run'] })).success).toBe(true);
  // A watcher, by its method's id: it runs by itself later (method-risk.ts RUNS_LATER_METHOD_IDS).
  const schedule = { id: 'watchers.create', inputs: { label: 'notes', kind: 'manual' } };
  // Turn 1 of the exposed conversation reads the page; turn 2 (a new turn: the per-turn window is reset) makes the schedule.
  await turnOf(exposed, true, 'tool_schema', { names: ['capability_run'] });
  const next = await turnOf(exposed, false, 'capability_run', schedule);
  const askedExposed = asks.length;
  // The control: a conversation that read nothing makes the same call, decided by the mode (yolo): not asked.
  const control = await turnOf(clean, false, 'capability_run', schedule);
  const decided = (result: { readonly success: boolean; readonly decision?: { readonly state: string } | undefined }): string =>
    result.decision?.state === 'refused' ? 'refused' : result.success ? 'ran' : 'admitted';
  expect(`exposed next turn: asked ${askedExposed}, ${decided(next)}; clean: asked ${asks.length - askedExposed}, ${decided(control)}`)
    .toBe('exposed next turn: asked 1, refused; clean: asked 0, admitted');
});

test('a command line\'s call never answers a question put to the owner; his own sign-in passes that check', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const { broker, pairing, helper, ownerSession, code } = await daemon(home, workspace);
  // A question put to the owner: a paired device asks for his mail (the shared-kind question).
  const kiosk = pairing.mint({ name: 'kiosk' });
  const asked = await helper.invokeGatewayMethodCall({ authToken: kiosk.token, methodId: 'email.inbox.list', body: {}, context: {} });
  const approvalId = String((asked.body as { approvalId?: unknown }).approvalId);
  expect(`${asked.status} ${code(asked)} ${broker.getApproval(approvalId)?.status}`).toBe('202 OWNER_APPROVAL_PENDING pending');
  // `goodvibes do approvals.approve`: the operator token with the command-line registration the program socket issues,
  // the command line's client kind, a person's claim.
  const answer = (authToken: string, call: Record<string, unknown>) => helper.invokeGatewayMethodCall({ authToken, methodId: 'approvals.approve',
    body: { approvalId, expectedRevision: broker.getApproval(approvalId)?.revision }, context: { explicitUserRequest: true, ...call } });
  const fromDo = await answer(OPERATOR_TOKEN, { clientKind: 'cli', call: { registration: 'cli', project: workspace } });
  const stillWaiting = broker.getApproval(approvalId)?.status;
  // The control: the owner's own sign-in passes that check (no route serves the answer in this proof, so it goes no further).
  const fromOwner = await answer(ownerSession, {});
  expect(`do: ${fromDo.status} ${code(fromDo)}, the question ${stillWaiting}; owner: ${code(fromOwner) === 'OWNER_ANSWERS_ONLY' ? 'refused' : 'past the check'}`)
    .toBe('do: 403 OWNER_ANSWERS_ONLY, the question pending; owner: past the check');
});

test('a paired device given none of his shared things reads no mail: asked once, refused after his No; given mail it passes', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const { broker, pairing, helper, code } = await daemon(home, workspace);
  const kiosk = pairing.mint({ name: 'kiosk' });
  const read = () => helper.invokeGatewayMethodCall({ authToken: kiosk.token, methodId: 'email.inbox.list', body: {}, context: {} });
  const first = await read();
  const approvalId = String((first.body as { approvalId?: unknown }).approvalId);
  const question = broker.getApproval(approvalId);
  if (question) await broker.resolveApproval(approvalId, { approved: false, actor: 'owner', expectedRevision: question.revision, reason: 'Not my mail.' });
  const afterNo = await read();
  // Given his calendar only: still no mail.
  const gifts = new CallerSharedStore(resolveGoodVibesDaemonHome(home));
  gifts.set(pairingPrincipalId(kiosk.id), ['calendar']);
  const calendarOnly = await read();
  // The control: given his mail, the device's call passes the rule (no mailbox serves it in this proof).
  gifts.set(pairingPrincipalId(kiosk.id), ['mail']);
  const given = await read();
  expect(`${first.status} ${code(first)}; after No ${afterNo.status} ${code(afterNo)}; calendar only ${code(calendarOnly)}; given mail ${code(given) === 'SHARED_KIND_NOT_GIVEN' || code(given) === 'OWNER_APPROVAL_PENDING' ? 'refused' : 'passes'}`)
    .toBe('202 OWNER_APPROVAL_PENDING; after No 403 SHARED_KIND_NOT_GIVEN; calendar only SHARED_KIND_NOT_GIVEN; given mail passes');
});
