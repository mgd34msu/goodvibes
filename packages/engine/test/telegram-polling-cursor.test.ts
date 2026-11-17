// Proves: Telegram polling confirms an update before it was processed, or hands processed updates out again after a restart part-way through a batch.
// Red when: dispatchBatch persists the offset past an update that did not settle, or does not persist a settled one.
/**
 * Telegram's getUpdates offset is the receipt: an update below it is never
 * handed out again. The offset is saved after each update is processed, so a
 * daemon that stops part-way through a batch resumes at the first update that
 * did not settle: nothing is lost and nothing already handled runs twice.
 *
 * Real Telegram ingress supervisor in polling mode, real Bot API client, the
 * real offset file, settings, secrets, service registry, session broker and
 * route bindings over their files. The Bot API is a loopback server that
 * records each offset it was asked for; the agent runtime is a stand-in that
 * records each start and refuses the first start for one update. A restart is
 * a second set of these objects over the same files.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { TelegramBotApi } from '../platform/src/platform/channels/telegram/api.ts';
import { TelegramIngressSupervisor } from '../platform/src/platform/channels/telegram/ingress.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ServiceRegistry } from '../platform/src/platform/config/service-registry.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';

const TOKEN = '7000001:fixture-token';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  surfaceInboundDedup.clear();
});

/** Let the event loop turn until `done` holds; bounded in turns, never in milliseconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 50_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!done()) throw new Error(`Gave up waiting for: ${what}`);
}

/** Three private chats each send one message, as one batch. */
const UPDATES = [1, 2, 3].map((id) => ({
  update_id: id,
  message: { message_id: id, chat: { id: 100 + id, type: 'private' }, from: { id: 100 + id, first_name: `sender ${id}` }, text: `message ${id}` },
}));

/** The Bot API: answers what the supervisor asks, records every getUpdates offset, and holds a poll with nothing to hand out. */
async function botApi() {
  const offsets: Array<number | null> = [];
  const held: ServerResponse[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop();
      const body = raw ? JSON.parse(raw) as { offset?: number } : {};
      const ok = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return ok({ id: 7000001, is_bot: true, username: 'gv_fixture_bot', first_name: 'fixture' });
      if (method === 'getWebhookInfo') return ok({ url: '', pending_update_count: 0 });
      if (method === 'deleteWebhook') return ok(true);
      if (method === 'sendMessage') return ok({ message_id: 1 });
      if (method === 'getUpdates') {
        offsets.push(body.offset ?? null);
        const pending = UPDATES.filter((update) => update.update_id >= (body.offset ?? 0));
        if (pending.length > 0) return ok(pending);
        held.push(res);
        return undefined;
      }
      res.writeHead(404).end();
      return undefined;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, offsets };
}

/** One daemon's Telegram receiving pieces over the home's files. */
async function daemon(root: string, apiUrl: string, runtime: { starts: string[]; refuseFirst: string; refused: boolean }) {
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: join(root, 'project') });
  const serviceRegistry = new ServiceRegistry({ user: join(root, 'home', 'services.json'), project: join(root, 'project', 'services.json') }, { secretsManager });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  await sessionBroker.start();
  let agents = 0;
  const context = {
    configManager, serviceRegistry, secretsManager, routeBindings, sessionBroker,
    authorizeSurfaceIngress: async () => ({ allowed: true }),
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    performInteractiveSurfaceAction: async () => 'ok',
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => true,
    // The agent runtime: records each start; the first start for one message finds no free agent.
    trySpawnAgent: (input: { task: string }) => {
      runtime.starts.push(input.task);
      if (input.task.includes(runtime.refuseFirst) && !runtime.refused) {
        runtime.refused = true;
        return Response.json({ error: 'no agent is free' }, { status: 503 });
      }
      return { id: `agent-${++agents}-${runtime.starts.length}` };
    },
  };
  const supervisor = new TelegramIngressSupervisor({
    configManager, secretsManager, serviceRegistry,
    buildSurfaceAdapterContext: () => context as never,
    offsetFilePath: join(root, 'telegram-offset.json'),
    createApi: (token) => new TelegramBotApi(token, (input, init) => fetch(input, init), apiUrl),
  });
  return {
    configManager, sessionBroker, supervisor,
    async stop() { await supervisor.stop(); await sessionBroker.stop(); },
  };
}

test('a stop part-way through a batch resumes at the first update that did not settle, and nothing processed runs twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-telegram-cursor-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  cleanups.push(() => { if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken; });
  const api = await botApi();
  const runtime = { starts: [] as string[], refuseFirst: 'message 2', refused: false };

  const first = await daemon(root, api.url, runtime);
  let firstRunning = true;
  cleanups.push(async () => { if (firstRunning) await first.stop(); });
  first.configManager.setMany([
    { key: 'surfaces.telegram.enabled' as ConfigKey, value: true },
    { key: 'surfaces.telegram.mode' as ConfigKey, value: 'polling' },
    { key: 'surfaces.telegram.botUsername' as ConfigKey, value: 'gv_fixture_bot' },
  ], { kind: 'owner', surface: 'fixture' });
  expect((await first.supervisor.start()).mode).toBe('polling');

  // Update 1 is processed; update 2 finds no free agent and waits to be tried again. The daemon stops in that wait.
  await until(() => runtime.refused, 'the refused start of update 2');
  await first.stop();
  firstRunning = false;
  expect(runtime.starts.filter((task) => task.includes('message 3'))).toEqual([]);

  const second = await daemon(root, api.url, runtime);
  cleanups.push(() => second.stop());
  expect((await second.supervisor.start()).mode).toBe('polling');
  await until(() => api.offsets.includes(4), 'the poll after the redelivered updates');

  // The restart asked from update 2: update 1 had been confirmed, update 2 had not.
  expect(api.offsets).toEqual([null, 2, 4]);
  const started = (n: number) => runtime.starts.filter((task) => task.includes(`message ${n}`)).length;
  expect({ one: started(1), two: started(2), three: started(3) }).toEqual({ one: 1, two: 2, three: 1 });
  const recorded = (n: number) => second.sessionBroker.listSessions(100)
    .flatMap((session) => second.sessionBroker.getMessages(session.id, 100))
    .filter((message) => message.role === 'user' && message.body === `message ${n}`).length;
  expect({ one: recorded(1), two: recorded(2), three: recorded(3) }).toEqual({ one: 1, two: 1, three: 1 });
});
