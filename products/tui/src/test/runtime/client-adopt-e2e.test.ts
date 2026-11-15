/**
 * client-adopt-e2e.test.ts, this app's client seams against a REAL daemon.
 *
 * ── Why a real daemon and not a mock ──────────────────────────────────────
 *
 * Every other test in this repository can now only prove that this process
 * does NOT answer a verb. That is the correct claim for a client, and it is
 * also a claim that would keep passing if the wire calls this app makes were
 * wrong in every detail, wrong verb id, wrong parameter names, wrong shape
 * read back off the response. A mock gateway that answers whatever it is asked
 * proves the same nothing.
 *
 * So this suite boots the platform's fully composed daemon in this process
 * (`bootDaemon`, the same composition the daemon product runs) and drives this
 * app's client seams against it over real sockets:
 * session registration, an approval raised and decided, a config write, a task
 * listing, and the honest refusal path when a verb is not available.
 *
 * ── Isolation, which is not optional ──────────────────────────────────────
 *
 * The daemon under test gets its own home directory, its own working
 * directory, and an OS-assigned ephemeral port. It never touches `~/.goodvibes`,
 * the owner's live daemon, or port 3421. The token it mints lives in the throwaway
 * home and is read from there, which is also the loopback file-token bootstrap
 * this app uses in production, so the auth path is exercised rather than
 * bypassed.
 *
 * ── It never skips ───────────────────────────────────────────────────────
 *
 * The daemon runs in this process, so there is no binary to be missing and no
 * environment variable to set: a green run means the wire contracts held.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { startDaemonFixture, type DaemonFixture } from '@goodvibes-jev/daemon/testing';
import { getOrCreateCompanionToken } from '@goodvibes-jev/engine/platform/platform/pairing';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createDaemonVerbCaller, type DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import {
  createClientPhoneTool,
  createConversationRewindHost,
  createDaemonConfigClient,
  createDaemonCredentialsClient,
  createDevicesClient,
  createTasksClient,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { createFleetUnionReadModel } from '../../runtime/client/fleet-union.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createHostedSessionsClient, terminalHostedClientId } from '../../runtime/client/hosted-sessions.ts';
import { watchHostedSession } from '../../runtime/client/hosted-session-stream.ts';
import { createTerminalApprovalUpdateSubscriber } from '../../runtime/client/approval-updates.ts';
import { HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import { leaveHostedSessionOnExit } from '../../runtime/client/hosted-exit.ts';

const STUB_PROVIDER_NAME = 'adopt-e2e-stub';
const STUB_MODEL_NAME = 'adopt-e2e-model';
const BOOT_TIMEOUT_MS = 45_000;

/** What the stub answers with next; each test sets the sentence it wants back. */
let stubNextReply: { readonly content: string } = { content: 'a hosted answer' };
let stubCalls = 0;

/**
 * A minimal OpenAI-compatible server: the models listing plus one completion.
 *
 * It answers as a STREAM when asked to, which is not a nicety, a hosted turn
 * runs the ordinary orchestrator, which streams, and a provider that answers a
 * streaming request with a plain JSON body errors the turn and gets dropped from
 * the daemon's routable models. (Observed exactly that way while writing this:
 * a non-streaming stub made every later `sessions.hosted.create` refuse with
 * "not in this daemon's model registry".)
 */
function startStubModelServer(): { stop: () => void; port: number } {
  const chunk = (delta: unknown, finishReason: string | null): string => `data: ${JSON.stringify({
    id: `chatcmpl-${stubCalls}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL_NAME,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } } : {}),
  })}\n\n`;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith('/models')) {
        return Response.json({ data: [{ id: STUB_MODEL_NAME }] });
      }
      stubCalls += 1;
      const body = await request.json().catch(() => ({})) as { stream?: boolean };
      const finalDelta = { role: 'assistant', content: stubNextReply.content };

      if (body.stream) {
        return new Response(
          chunk(finalDelta, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        id: `chatcmpl-${stubCalls}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: STUB_MODEL_NAME,
        choices: [{
          index: 0,
          message: finalDelta,
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      });
    },
  });
  return { stop: () => server.stop(true), port: server.port ?? 0 };
}

/** Poll a condition rather than sleeping a guessed interval. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Find the conversation half of a rewind plan, wherever the plan nests it.
 *
 * Searched by SHAPE rather than by a fixed path: the assertion that matters is
 * "the numbers this surface answered with came back", and pinning the plan's
 * internal layout here would make this test fail for a reorganisation that
 * broke nothing. A record carrying both message counts is the conversation part.
 */
function findConversationPart(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if ('messagesToDrop' in record && 'messagesRemaining' in record) return record;
  for (const nested of Object.values(record)) {
    const found = findConversationPart(nested);
    if (found) return found;
  }
  return null;
}

/**
 * Read a list off a response that may be the array itself or a one-key wrapper.
 *
 * Both shapes are real in this contract, `sessions.list` answers bare, the
 * approval action verbs wrap, and a caller that assumes one gets an empty list
 * from the other with no error at all. Naming the key here means a shape change
 * shows up as a failing assertion rather than as silence.
 */
function readList<T>(payload: unknown, key: string): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as readonly T[];
  }
  return [];
}

interface BootedDaemon {
  readonly fixture: DaemonFixture;
  readonly home: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Scoped offline readings for a hosted text turn: the daemon's own orchestrator
 * asks the judgment layer how to shape the turn, and an unanswered question is
 * an error, so every battery a plain or tool-calling turn reaches is answered.
 */
function installHostedTurnReadings(): () => void {
  const core = fakePort((name, question) => {
    if (name === 'intent') return choiceAnswer(question, 'chat', 0.97);
    if (name === 'needs_plan') return noulAnswer(0.03);
    if (name === 'risk') return scoreAnswer(question, 0, 0.97);
    if (name === 'completion_required') return noulAnswer(0.99);
    throw new Error(`Unexpected core reading: ${name}`);
  });
  const intake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'converse', 0.97);
    throw new Error(`Unexpected intake reading: ${name}`);
  });
  const completion = fakePort(() => noulAnswer(0.01));
  const port: JudgmentPort = {
    model: core.port.model,
    ask(request) {
      const battery = request.context?.battery;
      if (battery === 'engine.core.turn-shape' || battery === 'engine.core.completion-applicability') return core.port.ask(request);
      if (battery === 'contract.request-route') return intake.port.ask(request);
      if (['engine.core.response-completion', 'engine.core.execution-assurance', 'engine.core.delegation-consolidation']
        .includes(String(battery))) return completion.port.ask(request);
      return Promise.reject(new Error(`Unexpected reading battery: ${battery ?? '(unnamed)'}`));
    },
  };
  const previous = installJudgmentPort(port);
  return () => { installJudgmentPort(previous); };
}

async function bootIsolatedDaemon(stubPort: number): Promise<BootedDaemon> {
  const root = makeProjectTempDir('gv-adopt-e2e');
  const home = join(root, 'home');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(daemonHome, { recursive: true });
  mkdirSync(join(home, 'work'), { recursive: true });
  writeFileSync(join(home, 'work', 'note.txt'), 'the note a hosted session can read\n');
  const surfaceDir = join(home, '.goodvibes', 'tui');
  mkdirSync(surfaceDir, { recursive: true });
  writeFileSync(join(surfaceDir, 'benchmarks.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
  // The token the product's own loopback file-token bootstrap will read from the
  // throwaway home is the one the daemon is composed to require, so the
  // production auth path is exercised rather than bypassed.
  const { token } = getOrCreateCompanionToken('tui', { daemonHomeDir: daemonHome });
  const fixture = await startDaemonFixture({
    root,
    token,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  });
  // The seam boot uses for the persisted discovery cache: a hosted turn calls a
  // REAL model, so the daemon's registry learns the local OpenAI-compatible stub.
  fixture.services.providerRegistry.registerDiscoveredProviders([{
    name: STUB_PROVIDER_NAME,
    host: '127.0.0.1',
    port: stubPort,
    baseURL: `http://127.0.0.1:${stubPort}/v1`,
    models: [STUB_MODEL_NAME],
    serverType: 'vllm',
  }]);
  return { fixture, home: fixture.homeDirectory, baseUrl: fixture.baseUrl, port: Number(new URL(fixture.baseUrl).port), token };
}

describe('client seams against a real daemon', () => {
  let daemon: BootedDaemon;
  let verbs: DaemonVerbCaller;
  let stubModel: { stop: () => void; port: number } | null = null;
  let discovery: ReturnType<typeof spyOn> | undefined;

  beforeAll(async () => {
    // Up BEFORE the daemon: the discovered-provider record the boot writes is
    // read at startup and probed, so a stub that is not yet listening means a
    // provider the daemon never registers.
    stubModel = startStubModelServer();
    // Live model discovery is a network call; the daemon under test learns its
    // one provider from the stub registered at boot instead.
    discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
    daemon = await bootIsolatedDaemon(stubModel.port);
    // THE PRODUCT'S OWN SEAM, not a hand-rolled client. `createDaemonVerbCaller`
    // is what every retargeted seam calls through, so what this suite exercises
    // is the base-URL derivation, the loopback token read, the operator client
    // construction and the ws-only fallback the product actually ships, not a
    // parallel implementation that could be right while the product is wrong.
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      configDir: join(daemon.home, 'client-config'),
      workingDir: join(daemon.home, 'work'),
      homeDir: daemon.home,
    });
    configManager.setDynamic('daemon.enabled' as never, true as never);
    configManager.setDynamic('controlPlane.host' as never, '127.0.0.1' as never);
    configManager.setDynamic('controlPlane.port' as never, daemon.port as never);
    verbs = createDaemonVerbCaller({ configManager, homeDirectory: daemon.home });
  }, BOOT_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    try { await daemon?.fixture.stop(); }
    finally {
      stubModel?.stop();
      discovery?.mockRestore();
    }
  });

  test('the daemon answers on its isolated port, and it is not the default one', () => {
    expect(daemon.baseUrl).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.port).not.toBe(3421);
    expect(daemon.token.length).toBeGreaterThan(0);
    // The product's own resolution finds it: base URL derived from
    // controlPlane.host+port, token read from the daemon's state directory.
    expect(verbs.probe().available).toBe(true);
  });

  test('S2 sessions: a session registered here is listed back by the daemon', async () => {
    const sessionId = `e2e-session-${Date.now()}`;
    await verbs.invoke('sessions.register', {
      sessionId,
      project: join(daemon.home, 'work'),
      title: 'Adopt e2e session',
      participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', displayName: 'Terminal UI' },
    });
    const rows = readList<{ id: string }>(await verbs.invoke('sessions.list', { limit: 50 }), 'sessions');
    expect(rows.some((row) => row.id === sessionId)).toBe(true);
  });

  test('S3 approvals: an ask raised over the wire comes back as a pending record and decides', async () => {
    const raised = await verbs.invoke<{ approval?: { id: string; status: string }; decided?: boolean }>('approvals.raise', {
      request: {
        callId: `e2e-${Date.now()}`,
        tool: 'bash',
        args: { command: 'ls -la' },
        category: 'execute',
        analysis: { riskLevel: 'low', reasons: ['end-to-end check'], classification: 'read', summary: 'list files' },
      },
    });

    expect(raised.approval?.id).toBeTruthy();
    // The verb does not park the request across a person's attention span,
    // it hands back the PENDING record and the decision arrives separately.
    expect(raised.decided).toBe(false);
    const approvalId = raised.approval?.id as string;

    // The action verbs answer with the RECORD wrapped, not bare: the daemon
    // is the authority on what it recorded, and the wrapper is what carries
    // the rest of that receipt.
    const decided = await verbs.invoke<{ approval?: { status?: string } } | null>('approvals.approve', {
      approvalId, actor: 'tui', actorSurface: 'tui',
    });
    expect(decided?.approval?.status).toBe('approved');

    // And the daemon's own list is what says so, the parity contract the
    // client raiser depends on when it reads a decision made elsewhere.
    const rows = readList<{ id: string; status: string }>(
      await verbs.invoke('approvals.list', { includeResolved: true }), 'approvals');
    expect(rows.find((row) => row.id === approvalId)?.status).toBe('approved');
  });

  test('S4 config: a daemon-owned key written over the wire reads back changed', async () => {
    // watchers.* is daemon-owned (the daemon runs the watcher framework), so
    // this is exactly the class of write that would silently land in
    // this surface's own settings file if it were not routed to the daemon.
    const config = createDaemonConfigClient(verbs);
    expect(config.ownsKey('watchers.enabled')).toBe(true);
    await config.set('watchers.enabled', false);
    expect(await config.get('watchers.enabled')).toBe(false);
  });

  test('S5 credentials: the daemon stores the value AND points the config key at it', async () => {
    // The verb takes the CONFIG key, not a store key, and does the whole
    // sequence: derive the store name, write, read back and compare, then
    // replace the config value with its reference. That ordering is why this
    // is one call rather than a config write plus a secret write from here,
    // the two halves must not be separable across a process boundary.
    const credentials = createDaemonCredentialsClient(verbs);
    const configKey = 'surfaces.telegram.botToken';
    const receipt = await credentials.set(configKey, 'e2e-not-a-real-token');
    expect(receipt).toBeTruthy();

    // The config key now holds a REFERENCE, and the reference is what the
    // daemon resolves. Never the value: nothing in the receipt or the config
    // repeats the credential.
    const stored = await createDaemonConfigClient(verbs).get(configKey);
    expect(String(stored)).toContain('goodvibes://secrets/');
    expect(String(stored)).not.toContain('e2e-not-a-real-token');
    expect(JSON.stringify(receipt)).not.toContain('e2e-not-a-real-token');

    await credentials.clear(configKey);
  });

  test('S11 tasks: the union reader reaches the daemon and keeps the local half separable', async () => {
    // Driven through the product's own union client, so what is exercised is
    // the verb id, the wrapper key the tasks array actually arrives under,
    // and the local-wins dedupe, not a hand-rolled fetch that could be right
    // while the product is wrong.
    const localOnly = { id: 'local-only', kind: 'agent', title: 'this terminal', status: 'running',
      owner: 'tui', cancellable: true, childTaskIds: [], queuedAt: Date.now() } as never;
    const client = createTasksClient({
      local: { list: () => [localOnly], get: (id: string) => (id === 'local-only' ? localOnly : null) },
      verbs,
    });
    const result = await client.list();
    // The daemon answered, so the union is complete rather than degraded.
    expect(result.daemonUnavailable).toBeNull();
    const local = result.tasks.filter((entry) => entry.origin === 'local');
    expect(local.map((entry) => entry.task.id)).toEqual(['local-only']);
    // Every row the daemon contributed is labelled as the daemon's, which is
    // what decides whether a lifecycle act may be applied locally.
    for (const entry of result.tasks.filter((e) => e.origin === 'daemon')) {
      expect(typeof entry.task.id).toBe('string');
    }
  });

  test('S10 fleet: the union read model folds the daemon\'s rows in over the wire', async () => {
    const localNode = { id: 'local-agent', kind: 'agent', label: 'this terminal', state: 'thinking',
      elapsedMs: 0, costState: 'unpriced',
      capabilities: { interruptible: false, resumable: false, killable: false, steerable: false } } as never;
    const union = createFleetUnionReadModel({
      local: createStaticFleetReadModel(buildFleetSnapshot([localNode], Date.now())),
      verbs,
    });
    // A real fleet.snapshot round trip: this is a ws-declared verb, so it also
    // proves the generic-gateway fallback carries the fleet reads.
    await union.refresh();
    const ids = union.getSnapshot().rows.map((row) => row.node.id);
    // The local row survives the merge whatever the daemon returned; a fresh
    // daemon contributes none, and that is an honest empty rather than a
    // failure.
    expect(ids).toContain('local-agent');
    // Steering a row this terminal does not own refuses with a reason.
    const refusal = union.steer('not-a-local-row', 'stop');
    expect(refusal.queued).toBe(false);
    if (refusal.queued === false) expect(refusal.reason).toContain('daemon');
    union.stop();
  });

  test('S12 devices: the device verbs answer, with no paired phone on a fresh home', async () => {
    const rows = await createDevicesClient(verbs).listNodes();
    expect(rows).toEqual([]);
  });

  test('S12 devices: a capability request reaches the runtime and its refusal is an ANSWER', async () => {
    // A fresh home has no paired phone, so the runtime refuses. That refusal
    // is the point: it proves the request reached the real capability service
    // (wrong verb id or wrong argument names would have thrown instead), and
    // it proves the shape a decline comes back in.
    const outcome = await createDevicesClient(verbs).requestCapability({
      nodeId: 'phone-that-is-not-paired',
      capabilityId: 'device.clipboard.read',
      reason: 'end-to-end check',
    });
    expect(outcome.ok).toBe(false);
    // The runtime's own code and words, not a transport error dressed up.
    expect(String(outcome.refusal ?? '')).not.toBe('');
    expect(String(outcome.detail ?? '')).not.toBe('');

    // And through the TOOL, which is what the model sees: a refusal is a
    // SUCCESSFUL tool result saying it was refused, never a failed call the
    // model would retry by prompting the person again.
    const tool = createClientPhoneTool(createDevicesClient(verbs));
    const result = await tool.execute({
      action: 'run',
      capabilityId: 'device.clipboard.read',
      nodeId: 'phone-that-is-not-paired',
      reason: 'end-to-end check',
    });
    const payload = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
    // With nothing paired the tool refuses before the round trip, naming the
    // absent phone, which is the honest answer and not an invented refusal.
    expect(String(payload['error'] ?? payload['detail'] ?? '')).not.toBe('');
  });

  test('S12 devices: retained captures list over the wire on a fresh home', async () => {
    const listed = await createDevicesClient(verbs).listArtifacts({ limit: 5 });
    expect(listed.artifacts).toEqual([]);
    // The retention window is the daemon's policy, reported rather than
    // guessed, a zero here would mean the verb did not answer at all.
    expect(listed.retentionHours).toBeGreaterThan(0);
  });

  test('S15 rewind: a conversation-scope rewind driven daemon-side is answered by THIS surface', async () => {
    const hostedSession = `e2e-rewind-${Date.now()}`;
    const host = createConversationRewindHost({
      verbs,
      // Stands in for this process's conversation with a known message count,
      // which is what makes the daemon's answer checkable.
      // Only preview/rewind are RewindConversationPort's members, the host
      // never calls restoreBefore/restoreAfter (the TUI's own /undo-/redo
      // accessors), so this stand-in stub carries only what it is asked for.
      port: {
        preview: async () => ({ messagesToDrop: 3, messagesRemaining: 9 }),
        rewind: async () => ({ droppedMessages: 3, undoSnapshotId: 'rwc_e2e' }),
      },
      hosts: (sessionId) => sessionId === hostedSession,
      label: 'the terminal app (e2e)',
      waitMs: 0,
    });

    // Before the offer: the daemon holds no conversation for this session and
    // must say so rather than answering zero. This is the exact regression the
    // surface-hosted contract exists to close, the old behaviour returned a
    // confident 0 here, indistinguishable from a real one.
    const beforeOffer = await verbs.invoke<Record<string, unknown>>('rewind.plan', {
      sessionId: hostedSession, scope: 'conversation',
    });
    const beforeConversation = findConversationPart(beforeOffer);
    expect(beforeConversation?.['available']).toBe(false);
    // Not merely a false flag: the plan carries a warning saying WHY, so the
    // zeroes beside it cannot be read as a real count by anything downstream.
    expect(JSON.stringify(beforeOffer['warnings'] ?? [])).toContain('conversation rewind unavailable');

    host.offer(hostedSession);
    await host.pump();
    expect(host.hostId()).toBeTruthy();

    // Now drive the rewind from the DAEMON side, exactly as another surface
    // would, and answer it from here while the call is in flight.
    let planSettled = false;
    const planned = verbs.invoke<Record<string, unknown>>('rewind.plan', {
      sessionId: hostedSession, scope: 'conversation',
    });
    void planned.then(() => { planSettled = true; }, () => { planSettled = true; });
    // The question is raised by the call above; pump until the plan answers,
    // rather than guessing how long the daemon takes to ask it.
    expect(await waitFor(async () => { await host.pump(); return planSettled; })).toBe(true);
    const plan = await planned;

    // The counts came from THIS process's port and nothing else could have
    // produced them: the daemon has no conversation for this session, and
    // 3-of-12 is a shape it could not have guessed. Read out of the plan's
    // conversation part by name rather than by string search, so a plan that
    // merely happened to contain a 3 somewhere cannot pass this.
    const conversation = findConversationPart(plan);
    expect(conversation).toBeTruthy();
    expect(conversation?.['messagesToDrop']).toBe(3);
    expect(conversation?.['messagesRemaining']).toBe(9);
    expect(conversation?.['available']).not.toBe(false);

    await host.stop();
  });

  // ── hosted sessions ────────────────────────────────────────────────────
  //
  // Everything below drives the real daemon through the whole hosted story:
  // create, one turn that calls a real (stubbed) model, the stream this
  // terminal renders from, detach under BOTH policies, reattach with history
  // and a resumed stream, and an approval the hosted run itself raised
  // arriving on the push channel the raiser now subscribes to. Every test
  // creates the session it drives, so one failure cannot cascade into the next.
  describe('hosted sessions', () => {
    const detachPolicyKey = 'hostedSessions.detachPolicy';
    const workspaceRoot = (): string => join(daemon.home, 'work');
    const modelId = `${STUB_PROVIDER_NAME}:${STUB_MODEL_NAME}`;

    function clientConfigManager(): ConfigManager {
      const configManager = new ConfigManager({
        surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
        configDir: join(daemon.home, 'client-config'),
        workingDir: workspaceRoot(),
        homeDir: daemon.home,
      });
      configManager.setDynamic('daemon.enabled' as never, true as never);
      configManager.setDynamic('controlPlane.host' as never, '127.0.0.1' as never);
      configManager.setDynamic('controlPlane.port' as never, daemon.port as never);
      return configManager;
    }

    /**
     * Run steps that make the daemon's orchestrator answer a turn. The hosted
     * session installs its own judgment port while it is created, so the
     * readings go in after creation and come out before the session is killed.
     */
    async function withTurnReadings<T>(run: () => Promise<T>): Promise<T> {
      const restore = installHostedTurnReadings();
      try { return await run(); }
      finally { restore(); }
    }

    test('create composes a session in the named workspace, under the shipped kill default', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'kill');
      const client = createHostedSessionsClient(verbs);

      const record = await client.create({
        workspaceRoot: workspaceRoot(),
        title: 'the adopt e2e hosted session',
        modelId,
      });

      expect(record.status).toBe('idle');
      // The DAEMON's answer about what leaving would do, not this client's
      // memory of a setting it wrote a moment ago.
      expect(record.effectiveDetachPolicy).toBe('kill');
      expect(record.detachPolicy).toBeNull();
      expect(record.workspaceRoot).toBe(workspaceRoot());
      expect(record.attachedClients).toContain(terminalHostedClientId());

      const listed = await client.list();
      expect(listed.map((entry) => entry.id)).toContain(record.id);
    });

    test('a relative workspace root is refused rather than resolved against the daemon\'s own directory', async () => {
      let refusal: unknown = null;
      try {
        await createHostedSessionsClient(verbs).create({ workspaceRoot: 'relative/path' });
      } catch (error) {
        refusal = error;
      }
      expect(String((refusal as Error | null)?.message ?? '')).toContain('absolute');
    });

    test('a turn driven by sessions.steer calls a real model, and its output arrives on the stream this modal renders from', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'kill');
      const client = createHostedSessionsClient(verbs);
      const record = await client.create({ workspaceRoot: workspaceRoot(), modelId });
      const feed = new HostedSessionFeed();

      // The product's own subscription, the same one `/hosted attach` opens,
      // narrowed to turn/tools/session and filtered on this session id.
      const subscription = await watchHostedSession({
        baseUrl: daemon.baseUrl,
        sessionId: record.id,
        getAuthToken: () => daemon.token,
        onEvent: (event) => feed.apply(event),
        onLifecycle: (update) => feed.applyLifecycle(update),
      });
      try {
        expect(subscription).not.toBeNull();
        feed.attach((await client.attach(record.id)).session, []);

        stubNextReply = { content: 'the hosted session answered over the wire' };
        const callsBefore = stubCalls;
        await withTurnReadings(async () => {
          // `sessions.steer`, the ORDINARY verb, resolving a hosted id.
          await client.steer(record.id, 'say something for the record');
          expect(await waitFor(() => stubCalls > callsBefore)).toBe(true);
          // The turn's text reached this process over SSE, folded into the rows
          // the Hosted Session modal draws.
          expect(await waitFor(() => feed.getState().rows.some(
            (row) => row.kind === 'assistant' && row.text.includes('answered over the wire'),
          ))).toBe(true);
        });
      } finally {
        subscription?.close();
      }
    }, 60_000);

    test('detach under the kill default ends the session, and the record says why', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'kill');
      const client = createHostedSessionsClient(verbs);
      const created = await client.create({ workspaceRoot: workspaceRoot(), modelId });

      const record = await client.detach(created.id);
      expect(record.status).toBe('terminated');
      // A hosted session never simply disappears: the reason is on the record.
      expect(record.terminatedReason).toBe('detached');

      // And it is gone from the live list while still answerable with --all.
      expect((await client.list()).map((entry) => entry.id)).not.toContain(created.id);
      expect((await client.list({ includeTerminated: true })).map((entry) => entry.id))
        .toContain(created.id);
    });

    test('detach under survive leaves it idle, and reattaching backfills the history and resumes the stream', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'survive');
      const client = createHostedSessionsClient(verbs);
      const survivor = await client.create({ workspaceRoot: workspaceRoot(), title: 'the survivor', modelId });
      expect(survivor.effectiveDetachPolicy).toBe('survive');

      await withTurnReadings(async () => {
        stubNextReply = { content: 'said before the terminal walked away' };
        const callsBefore = stubCalls;
        await client.steer(survivor.id, 'say something before I go');
        expect(await waitFor(() => stubCalls > callsBefore)).toBe(true);
        // The reply lands in the transcript after the model answered; wait for
        // both messages so the backfill below is not racing the turn.
        expect(await waitFor(async () => {
          const listed = await verbs.invoke<{ sessions: Array<{ id: string; messageCount?: number }> }>(
            'sessions.hosted.list', {});
          return (listed.sessions.find((entry) => entry.id === survivor.id)?.messageCount ?? 0) >= 2;
        })).toBe(true);

        const detached = await client.detach(survivor.id);
        expect(detached.status).not.toBe('terminated');
        expect(detached.attachedClients).not.toContain(terminalHostedClientId());

        // Reattach: the transcript comes back, which is the whole point of a
        // session outliving the window that started it.
        const reattached = await client.attach(survivor.id);
        expect(reattached.session.id).toBe(survivor.id);
        expect(reattached.session.status).not.toBe('terminated');
        expect(reattached.history.length).toBeGreaterThan(0);
        expect(JSON.stringify(reattached.history)).toContain('before the terminal walked away');

        // And the live stream resumes: a turn steered AFTER the reattach lands
        // on the newly opened subscription, not only in the backfill.
        const feed = new HostedSessionFeed();
        feed.attach(reattached.session, reattached.history);
        const subscription = await watchHostedSession({
          baseUrl: daemon.baseUrl,
          sessionId: survivor.id,
          getAuthToken: () => daemon.token,
          onEvent: (event) => feed.apply(event),
        });
        try {
          expect(subscription).not.toBeNull();
          stubNextReply = { content: 'and this is after the reattach' };
          await client.steer(survivor.id, 'say something now that I am back');
          expect(await waitFor(() => feed.getState().rows.some(
            (row) => row.text.includes('after the reattach'),
          ))).toBe(true);
        } finally {
          subscription?.close();
        }
      });
    }, 90_000);

    test('a per-session kill override beats a survive setting', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'survive');
      const client = createHostedSessionsClient(verbs);
      const overridden = await client.create({ workspaceRoot: workspaceRoot(), detachPolicy: 'kill' });
      expect(overridden.detachPolicy).toBe('kill');
      expect(overridden.effectiveDetachPolicy).toBe('kill');
      const after = await client.detach(overridden.id);
      expect(after.status).toBe('terminated');
      expect(after.terminatedReason).toBe('detached');
    });

    test('an approval raised on the daemon arrives on the SSE channel the raiser subscribes to, and so does its decision', async () => {
      // The subscriber is the product's own seam, the one wired into
      // createClientApprovalRaiser in runtime/services.ts, so what this
      // exercises is the base-URL derivation, the token read and the
      // permissions-domain narrowing that ship, not a hand-rolled stream. A
      // hosted run's own write-class calls are refused by surface authority
      // rather than asked, so the ask is raised over the wire the way another
      // surface would raise it.
      const seen: Array<{ id: string; status: string }> = [];
      const subscription = await createTerminalApprovalUpdateSubscriber({
        configManager: clientConfigManager(), homeDirectory: daemon.home,
      })((notice) => {
        seen.push({ id: String(notice.approval['id'] ?? ''), status: String(notice.approval['status'] ?? '') });
      });
      try {
        expect(subscription).not.toBeNull();
        const raised = await verbs.invoke<{ approval?: { id: string } }>('approvals.raise', {
          request: {
            callId: 'e2e-sse-approval',
            tool: 'bash',
            args: { command: 'ls -la' },
            category: 'execute',
            analysis: { riskLevel: 'low', reasons: ['end-to-end check'], classification: 'read', summary: 'list files' },
          },
        });
        const approvalId = raised.approval?.id ?? '';
        expect(approvalId).not.toBe('');

        // Pending is what a raise publishes; the decision publishes again.
        expect(await waitFor(() => seen.some((entry) => entry.id === approvalId && entry.status === 'pending'))).toBe(true);
        await verbs.invoke('approvals.approve', { approvalId, actor: 'tui', actorSurface: 'tui' });
        expect(await waitFor(() => seen.some((entry) => entry.id === approvalId && entry.status === 'approved'))).toBe(true);
      } finally {
        subscription?.close();
      }
    }, 30_000);

    test('quitting the terminal detaches, so the kill default still means what it always meant', async () => {
      // The exit path, driven exactly as bootstrap's shutdown drives it. A
      // terminal that exits WITHOUT this leaves a kill-policy session alive
      // and attached to a process that is gone, which is the familiar
      // behavior silently changing, the thing the owner's default exists to
      // prevent.
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'kill');
      const client = createHostedSessionsClient(verbs);
      const leaving = await client.create({ workspaceRoot: workspaceRoot() });
      expect(leaving.effectiveDetachPolicy).toBe('kill');

      const configManager = clientConfigManager();
      const feed = new HostedSessionFeed();
      feed.attach(leaving, []);

      expect(await leaveHostedSessionOnExit({ configManager, homeDirectory: daemon.home, feed })).toBe('detached');

      const after = (await client.list({ includeTerminated: true })).find((entry) => entry.id === leaving.id);
      expect(after?.status).toBe('terminated');
      expect(after?.terminatedReason).toBe('detached');

      // Nothing attached is not an error and must not delay an exit.
      expect(await leaveHostedSessionOnExit({
        configManager, homeDirectory: daemon.home, feed: new HostedSessionFeed(),
      })).toBe('none');
    }, 30_000);

    test('kill ends a session regardless of policy, and the record keeps its reason', async () => {
      await createDaemonConfigClient(verbs).set(detachPolicyKey, 'survive');
      const client = createHostedSessionsClient(verbs);
      const survivor = await client.create({ workspaceRoot: workspaceRoot(), modelId });
      expect(survivor.effectiveDetachPolicy).toBe('survive');

      const record = await client.kill(survivor.id);
      expect(record.status).toBe('terminated');
      expect(record.terminatedReason).toBe('killed');
    });
  });

  test('S6 voice: speech-to-text refuses honestly when no local provider is provisioned', async () => {
    // The refusal path matters more than the happy path here: a fresh home
    // has no whisper model, and what the surface must get back is a stated
    // reason rather than an empty transcript it would paste into the
    // composer as if the user had said nothing.
    let refusal: unknown = null;
    try {
      await verbs.invoke('voice.stt', { audio: { data: '', mimeType: 'audio/wav' } });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).not.toBeNull();
    expect(String((refusal as Error).message).length).toBeGreaterThan(0);
  });
});
