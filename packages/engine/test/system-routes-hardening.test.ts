/** System routes: credential config keys, approvals and service status authority, watchers and workspace swap. */
import { describe, expect, test } from 'bun:test';
import { createDaemonSystemRouteHandlers } from '../daemon-api/src/system-routes.js';
import { CONFIG_SCHEMA } from '../platform/src/platform/config/schema.js';
import { coerceSchemaValue } from '../platform/src/platform/config/manager-bootstrap.js';

const realCoerce = (key: string, value: unknown): unknown => coerceSchemaValue(key, CONFIG_SCHEMA.find((setting) => setting.key === key), value);

interface Options {
  readonly admin?: boolean;
  readonly config?: Record<string, unknown>;
  readonly coerce?: (key: string, value: unknown) => unknown;
  readonly secretKeys?: readonly string[];
  readonly normalize?: (key: string, value: unknown) => unknown;
  readonly swap?: unknown;
  readonly watchers?: Map<string, Record<string, unknown>>;
  readonly serviceStatus?: Record<string, unknown>;
}

function build(options: Options = {}) {
  const config = options.config ?? {};
  const writes: Array<{ key: string; value: unknown }> = [];
  const resolved: string[] = [];
  const registered: Array<Record<string, unknown>> = [];
  const watchers = options.watchers ?? new Map<string, Record<string, unknown>>();
  let body: Record<string, unknown> = {};
  const context = {
    requireAdmin: () => options.admin === false ? Response.json({ error: 'admin required' }, { status: 403 }) : null,
    requireAuthenticatedSession: () => ({ username: 'viewer', roles: ['viewer'] }),
    parseJsonBody: async () => body,
    parseOptionalJsonBody: async () => body,
    recordApiResponse: (_req: Request, _path: string, response: Response) => response,
    isValidConfigKey: () => true,
    ...(options.normalize ? { coerceConfigValue: options.normalize } : {}),
    ...(options.secretKeys ? { isSecretBearingConfigKey: (key: string) => options.secretKeys!.includes(key) } : {}),
    configManager: {
      get: (key: string) => config[key],
      getAll: () => structuredClone(config),
      setDynamic: (key: string, value: unknown) => {
        writes.push({ key, value });
        config[key] = options.coerce ? options.coerce(key, value) : value;
      },
    },
    approvalBroker: {
      resolveApproval: async (id: string) => { resolved.push(id); return { id, status: 'approved' }; },
      claimApproval: async () => null,
      cancelApproval: async () => null,
    },
    integrationHelpers: null,
    inspectInboundTls: () => ({}),
    inspectOutboundTls: () => ({}),
    platformServiceManager: { status: () => options.serviceStatus ?? { installed: true, contents: 'Environment=GOODVIBES_DAEMON_TOKEN=abc' } },
    swapManager: options.swap ?? null,
    watcherRegistry: {
      list: () => [...watchers.values()],
      getWatcher: (id: string) => watchers.get(id) ?? null,
      removeWatcher: () => true,
      registerWatcher: (input: Record<string, unknown> & { id: string }) => {
        registered.push(input);
        const record = { ...input, state: 'stopped' };
        watchers.set(input.id, record);
        return record;
      },
    },
    routeBindings: {},
  } as never;
  const handlers = createDaemonSystemRouteHandlers(context);
  return {
    handlers, config, writes, resolved, registered, watchers,
    withBody: (next: Record<string, unknown>) => { body = next; },
  };
}

const req = (method = 'POST') => new Request('http://daemon.invalid/x', { method });

describe('POST /config with credential keys', () => {
  test('a literal for a credential key is refused and nothing is written', async () => {
    const f = build({ secretKeys: ['cluster.secret'] });
    f.withBody({ key: 'cluster.secret', value: 'hunter2' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('SECRET_CONFIG_KEY');
    expect(f.writes).toEqual([]);
  });

  test('a goodvibes://secrets reference for a credential key is accepted', async () => {
    const f = build({ secretKeys: ['cluster.secret'] });
    f.withBody({ key: 'cluster.secret', value: 'goodvibes://secrets/cluster-secret' });
    expect((await f.handlers.postConfig(req())).status).toBe(200);
    expect(f.writes).toHaveLength(1);
  });

  test('reading the config redacts a credential literal left in the file but keeps references', async () => {
    const f = build({
      secretKeys: ['surfaces.email.password', 'surfaces.slack.botToken'],
      config: { surfaces: { email: { password: 'plain', host: 'imap.example' }, slack: { botToken: 'goodvibes://secrets/slack' } } } as never,
    });
    const body = await (await f.handlers.getConfig(req('GET'))).json() as { surfaces: { email: { password: string; host: string }; slack: { botToken: string } } };
    expect(body.surfaces.email.password).toBe('[redacted]');
    expect(body.surfaces.email.host).toBe('imap.example');
    expect(body.surfaces.slack.botToken).toBe('goodvibes://secrets/slack');
  });
});

describe('POST /config value comparison', () => {
  test('a value the manager coerces to the key type is a success, not a 409', async () => {
    const f = build({ coerce: (_key, value) => typeof value === 'string' ? Number(value.trim()) : value });
    f.withBody({ key: 'controlPlane.port', value: ' 8080 ' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(200);
    expect((await response.json() as { value: unknown }).value).toBe(8080);
  });

  test('a permission-mode alias the manager normalizes is a success, not a 409', async () => {
    const f = build({ coerce: realCoerce, normalize: realCoerce });
    f.withBody({ key: 'permissions.mode', value: 'allow-all' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(200);
    expect((await response.json() as { value: unknown }).value).toBe('yolo');
  });

  test('a money string the manager parses to a number is a success, not a 409', async () => {
    const moneyKey = CONFIG_SCHEMA.find((setting) => setting.unit === 'money')!.key;
    const f = build({ coerce: realCoerce, normalize: realCoerce });
    f.withBody({ key: moneyKey, value: '$1,250.50' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(200);
    expect((await response.json() as { value: unknown }).value).toBe(1250.5);
  });

  test('a value that really differs is still a 409 and names the held value for an ordinary key', async () => {
    const f = build({ coerce: () => 'other' });
    f.withBody({ key: 'tts.voice', value: 'mine' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('other');
  });
});

describe('who may decide approvals and read the service unit', () => {
  test('a non-admin caller cannot approve and the broker is never asked', async () => {
    const f = build({ admin: false });
    const response = await f.handlers.approvalAction('a-1', 'approve', req());
    expect(response.status).toBe(403);
    expect(f.resolved).toEqual([]);
  });

  test('an admin caller can approve', async () => {
    const f = build();
    expect((await f.handlers.approvalAction('a-1', 'approve', req())).status).toBe(200);
    expect(f.resolved).toEqual(['a-1']);
  });

  test('service status is refused to a non-admin caller', async () => {
    const f = build({ admin: false });
    expect((await f.handlers.getServiceStatus(req('GET'))).status).toBe(403);
  });

  test('service status without a request to check never includes the unit file', async () => {
    const f = build();
    const body = await (await f.handlers.getServiceStatus()).json() as Record<string, unknown>;
    expect(body.installed).toBe(true);
    expect(body.contents).toBeUndefined();
  });
});

describe('watchers', () => {
  test('registering the same label twice is a 409 and keeps the first watcher', async () => {
    const f = build();
    f.withBody({ label: 'Build' });
    expect((await f.handlers.postWatcher(req())).status).toBe(201);
    const second = await f.handlers.postWatcher(req());
    expect(second.status).toBe(409);
    expect((await second.json() as { code: string }).code).toBe('WATCHER_EXISTS');
    expect(f.registered).toHaveLength(1);
  });

  test('changing a watcher created with a run text keeps that run', async () => {
    const f = build();
    f.withBody({ label: 'Build', run: 'echo hi' });
    await f.handlers.postWatcher(req());
    f.withBody({ intervalMs: 5000 });
    expect((await f.handlers.patchWatcher('watcher-build', req('PATCH'))).status).toBe(200);
    const patched = f.registered[1] as { run?: () => string };
    expect(patched.run?.()).toBe('echo hi');
  });
});

describe('watcher request headers', () => {
  test('a literal header value is refused on register and on change, and nothing is stored', async () => {
    const f = build();
    f.withBody({ label: 'Build', url: 'https://example.test/', headers: { Authorization: 'Bearer hunter2' } });
    const refused = await f.handlers.postWatcher(req());
    expect(refused.status).toBe(400);
    const payload = await refused.json() as { code: string; error: string };
    expect(payload.code).toBe('WATCHER_HEADER_LITERAL');
    expect(payload.error).toContain('Authorization');
    expect(payload.error).not.toContain('hunter2');
    expect(f.registered).toHaveLength(0);

    f.withBody({ label: 'Build', url: 'https://example.test/' });
    await f.handlers.postWatcher(req());
    f.withBody({ metadata: { headers: { 'X-Api-Key': 'abc123' } } });
    expect((await f.handlers.patchWatcher('watcher-build', req('PATCH'))).status).toBe(400);
    expect(f.registered).toHaveLength(1);
  });

  test('a secret reference is accepted and stored as the reference', async () => {
    const f = build();
    f.withBody({ label: 'Build', url: 'https://example.test/', headers: { Authorization: 'goodvibes://secrets/BUILD_TOKEN' } });
    expect((await f.handlers.postWatcher(req())).status).toBe(201);
    expect(JSON.stringify(f.registered[0])).toContain('goodvibes://secrets/BUILD_TOKEN');
  });
});

describe('workspace swap refusal', () => {
  test('a busy swap reports when to retry in milliseconds', async () => {
    const f = build({ swap: { requestSwap: async () => ({ ok: false, code: 'WORKSPACE_BUSY', reason: 'Retry after active inputs complete', retryAfter: 5 }) } });
    f.withBody({ key: 'runtime.workingDir', value: '/tmp/other' });
    const response = await f.handlers.postConfig(req());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'WORKSPACE_BUSY', retryAfterMs: 5000 });
  });
});

describe('GET /api/approvals', () => {
  test('an approvalId in the query is handed to the snapshot, and a plain read asks for the default list', async () => {
    const asked: Array<string | undefined> = [];
    const handlers = createDaemonSystemRouteHandlers({
      integrationHelpers: { getApprovalSnapshot: (approvalId?: string) => { asked.push(approvalId); return { approvals: [] }; } },
    } as never);
    await handlers.getApprovals(new URL('http://daemon.invalid/api/approvals?approvalId=ask-7'));
    await handlers.getApprovals(new URL('http://daemon.invalid/api/approvals'));
    expect(asked).toEqual(['ask-7', undefined]);
  });
});
