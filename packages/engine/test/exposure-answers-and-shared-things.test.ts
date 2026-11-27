// Proves: A conversation that read text from outside makes something that runs later, in a turn after the one that read it, decided without that read.
// Red when: The permission gate decides each turn by what that turn alone read, so the conversation's next turn makes a watcher in jev-decides on the decision model's word instead of putting it to the owner.
// Proves: A command line (goodvibes do) answers a question that was put to the owner.
// Red when: The dispatch lets a call that carries the command-line registration answer an approval instead of refusing it OWNER_ANSWERS_ONLY.
// Proves: A paired device's first use of the owner's mail is decided outside the owner's permission mode.
// Red when: The dispatch lets the decision model give a device the owner's mail in jev-decides instead of putting the first use to the owner, gives it when the owner said no, or puts it to the owner in yolo.

/**
 * The real pieces that hold each risk, composed as the daemon and a terminal program compose them; nothing stands in
 * for a store, the gate, the broker or the dispatch. No conversation model is needed: the tool call is made as a model
 * would make it. The decision model is a scripted port at the judgment wire.
 *  - A conversation's exposure: the program's capability tools in a real tool registry under a real PermissionManager
 *    (jev-decides), the process's untrusted-content ledger and the conversation store (security/conversation-exposure.ts).
 *  - A command line's answer and a device's mail: the daemon's dispatch (DaemonControlPlaneHelper) over a real approval
 *    broker, pairing store, sign-in store, the shared-kind rule (shared-kind-gifts.ts) and the daemon's one permission
 *    manager (capability-owner-gate.ts) deciding a first use under the owner's mode.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes/judgment';
import { choiceAnswer, fakePort } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { gateReadingsPort } from './_helpers/gate-readings.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
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
import { createCapabilityOwnerGate } from '../platform/src/platform/daemon/capability-owner-gate.ts';
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

/** The settings of one program or daemon in `mode`, with a decision model set up to answer (its port is scripted). */
function settings(home: string, workspace: string, surface: 'tui' | 'daemon', mode: string): ConfigManager {
  const config = new ConfigManager({ surfaceRoot: surface, workingDir: workspace, homeDir: home, configDir: join(home, '.goodvibes', surface), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: mode },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], localOwnerActor()).ok).toBe(true);
  return config;
}

/** The decision model at the judgment wire: the gate's readings benign, each disposition answered `answer`, its state kept. */
function scriptedJev(answer: 'act' | 'reject'): { readonly told: string[] } {
  const told: string[] = [];
  const readings = gateReadingsPort([]);
  const jev = fakePort((name, question, state) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    told.push(JSON.stringify(state));
    return choiceAnswer(question, answer, 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'fixture-model',
    ask: (request) => request.context?.site === 'engine.gate.autonomous-tool' ? jev.port.ask(request) : readings.port.ask(request) };
  const restore = installJudgmentPort(withDecisionLog(port, log));
  cleanups.push(() => { installJudgmentPort(restore); log[Symbol.dispose](); });
  return { told };
}

/** The daemon's dispatch over a real broker, pairing and sign-in store, with the shared-kind rule as the daemon wires it. */
async function daemon(home: string, project: string, mode = 'ask-me') {
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
  // The daemon's one permission manager under the owner's mode (its first-use decision is what the shared-kind rule asks).
  createCapabilityOwnerGate({ approvalBroker: broker, configManager: settings(home, project, 'daemon', mode), policyRuntimeState: new PolicyRuntimeState(),
    hookDispatcher: null, featureFlags: null, userPermissionRuleStore: null, secretsManager: null, pairingTokens: pairing } as unknown as Parameters<typeof createCapabilityOwnerGate>[0]);
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: pairing, userAuth: users,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    callerProject: daemonCallerProjectCheck(home), capabilityWorkFolders: capabilityWorkFolderInputs,
    sharedKind: createSharedKindGifts({ homeDirectory: home, deviceName: (id) => pairing.list().find((device) => device.id === id)?.name }),
    // The daemon's routes are outside this proof: a call that passed every check is answered here, and goes no further.
    dispatchApiRoutes: async () => Response.json({ error: 'served past the checks', code: 'PAST_THE_CHECKS' }, { status: 501 }),
  } as unknown as DaemonControlPlaneContext);
  const ownerSession = users.createSession(users.ownerUsername() ?? 'no owner account').token;
  const code = (answer: { readonly body: unknown }): string => String((answer.body as { code?: unknown } | null)?.code ?? '');
  return { broker, pairing, helper, ownerSession, code };
}

test('a later turn of a conversation that read text from outside makes something that runs later only on the owner\'s answer; a conversation that read nothing has it decided by the decision model', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const config = settings(home, workspace, 'tui', 'jev-decides');
  const { told } = scriptedJev('act');
  const asks: string[] = [];
  const manager = new PermissionManager(async (request) => { asks.push(request.tool); return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  // The daemon's whole catalog, as the program reads it.
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
  const exposed = `conversation:exposed-${Date.now()}`;
  const clean = `conversation:clean-${Date.now()}`;
  // A watcher, by its method's id: it runs by itself later (method-risk.ts RUNS_LATER_METHOD_IDS).
  const schedule = { id: 'watchers.create', inputs: { label: 'notes', kind: 'manual' } };
  // Turn 1 of the exposed conversation reads the page; turn 2 (a new turn: the per-turn window is reset) makes the watcher.
  await turnOf(exposed, true, 'tool_schema', { names: ['capability_run'] });
  await turnOf(exposed, false, 'capability_run', schedule);
  const toldExposed = told.splice(0);
  const askedExposed = asks.splice(0).length;
  // The control: a conversation that read nothing makes the same call: a change like any other, the decision model's
  // to decide in jev-decides (as 3.5.0 decided a model's watcher), not told of any read.
  await turnOf(clean, false, 'capability_run', schedule);
  const toldClean = told.splice(0);
  const askedClean = asks.splice(0).length;
  const readOutside = (states: readonly string[]): string => states.length === 0 ? 'not asked' : states.some((state) => /"readOutside":/.test(state)) ? 'told of the read' : 'told nothing read';
  expect(`exposed next turn: the owner asked ${askedExposed}, Jev ${readOutside(toldExposed)}; clean: the owner asked ${askedClean}, Jev ${readOutside(toldClean)}`)
    .toBe('exposed next turn: the owner asked 1, Jev not asked; clean: the owner asked 0, Jev told nothing read');
});

test('a command line\'s call never answers a question put to the owner; the owner\'s own sign-in passes that check', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const { broker, helper, ownerSession, code } = await daemon(home, workspace);
  // A question put to the owner (raised in process, as Ask me raises one).
  const question = { callId: 'question', tool: 'read', args: { path: 'README.md' }, category: 'read',
    analysis: { riskLevel: 'low', reasons: [], classification: 'read', summary: 'Read README.md?' } } as unknown as PermissionPromptRequest;
  const raised = await broker.raiseApproval({ request: question, metadata: {} });
  raised.decision.catch(() => undefined);
  const approvalId = raised.approval.id;
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

test('a paired device\'s first use of the owner\'s mail is decided under the owner\'s mode as access granted: put to the owner in jev-decides (the owner says no), given in yolo', async () => {
  const rows: string[] = [];
  for (const [mode, answer] of [['jev-decides', 'act'], ['yolo', 'act']] as const) {
    const home = join(dir, `home-${mode}`);
    const workspace = join(dir, `workspace-${mode}`);
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const { told } = scriptedJev(answer);
    const { broker, pairing, helper, code } = await daemon(home, workspace, mode);
    const kiosk = pairing.mint({ name: 'kiosk' });
    // The owner answers each card raised while the device waits: No, as they would to a device they did not expect.
    const stop = broker.subscribe((record) => {
      if (record.status !== 'pending') return;
      void broker.resolveApproval(record.id, { approved: false, actor: 'owner', expectedRevision: record.revision, reason: 'Not now.' }).catch(() => undefined);
    });
    cleanups.push(stop);
    const read = () => helper.invokeGatewayMethodCall({ authToken: kiosk.token, methodId: 'email.inbox.list', body: {}, context: {} });
    // The approvals kept from an earlier mode's broker (one store file) are not this mode's.
    const approvalsBefore = broker.listApprovals(100).length;
    const first = await read();
    const gifts = new CallerSharedStore(resolveGoodVibesDaemonHome(home));
    const kept = gifts.has(pairingPrincipalId(kiosk.id), 'mail');
    rows.push(`${mode}: ${first.status} ${code(first) === 'PAST_THE_CHECKS' ? 'passes' : code(first)}, mail kept ${kept}, Jev ${told.length > 0 ? 'decided' : 'not asked'}, approvals ${broker.listApprovals(100).length - approvalsBefore}`);
  }
  expect(rows).toEqual([
    'jev-decides: 403 SHARED_KIND_NOT_GIVEN, mail kept false, Jev not asked, approvals 1',
    'yolo: 501 passes, mail kept true, Jev not asked, approvals 0',
  ]);
});
