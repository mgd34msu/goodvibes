/**
 * A built-in channel account says what is true about it: a surface with nothing
 * set up is unconfigured, a credential that cannot resolve is not healthy, an
 * action the surface does not have is not authorized, and allowlist edits touch
 * only the group they name.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import { BuiltinChannelRuntime } from '../platform/src/platform/channels/builtin-runtime.js';
import type { BuiltinChannelRuntimeDeps } from '../platform/src/platform/channels/builtin/shared.js';
import type { ChannelDoctorReport } from '../platform/src/platform/channels/types.js';

const SECTIONS = [
  'slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'googleChat',
  'signal', 'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
] as const;

interface Harness {
  readonly runtime: BuiltinChannelRuntime;
  readonly config: Map<string, unknown>;
  readonly upserts: Record<string, unknown>[];
}

function harness(options: {
  readonly surfaces?: Record<string, Record<string, unknown>>;
  readonly groupPolicies?: readonly Record<string, unknown>[];
  readonly enabled?: readonly string[];
  readonly allowlistUserIds?: readonly string[];
} = {}): Harness {
  const surfaces: Record<string, Record<string, unknown>> = {};
  for (const section of SECTIONS) surfaces[section] = {};
  surfaces['whatsapp'] = { provider: 'meta-cloud' };
  surfaces['telephony'] = { provider: 'twilio' };
  for (const [section, values] of Object.entries(options.surfaces ?? {})) surfaces[section] = { ...surfaces[section], ...values };
  const config = new Map<string, unknown>();
  for (const [section, values] of Object.entries(surfaces)) {
    for (const [key, value] of Object.entries(values)) config.set(`surfaces.${section}.${key}`, value);
  }
  const upserts: Record<string, unknown>[] = [];
  const policy = {
    allowlistUserIds: options.allowlistUserIds ?? [], allowlistChannelIds: [], allowlistGroupIds: [],
    groupPolicies: options.groupPolicies ?? [],
  };
  const registry = new ChannelPluginRegistry();
  const deps = {
    channelPlugins: registry,
    configManager: {
      get: (key: string) => config.get(key),
      getCategory: () => surfaces,
      set: (key: string, value: unknown) => { config.set(key, value); },
      subscribe: () => () => undefined,
    },
    secretsManager: { get: async () => null, set: async () => undefined, delete: async () => undefined, getGlobalHome: () => undefined },
    serviceRegistry: { get: () => undefined, resolveSecret: async () => null },
    routeBindings: { start: async () => undefined, getBinding: () => undefined, listBindings: () => [] },
    channelPolicy: {
      start: async () => undefined,
      getPolicy: () => policy,
      upsertPolicy: async (_surface: string, input: Record<string, unknown>) => { upserts.push(input); return input; },
    },
    deliveryRouter: {},
    surfaceDeliveryEnabled: (surface: string) => (options.enabled ?? []).includes(surface) || config.get(`surfaces.${surface}.enabled`) === true,
    buildSurfaceAdapterContext: () => ({}),
    buildGenericWebhookAdapterContext: () => ({}),
    deliverSurfaceProgress: async () => undefined,
    deliverSlackAgentReply: async () => undefined,
    deliverDiscordAgentReply: async () => undefined,
    deliverNtfyAgentReply: async () => undefined,
    deliverWebhookAgentReply: async () => undefined,
    deliverSlackApprovalUpdate: async () => undefined,
    deliverDiscordApprovalUpdate: async () => undefined,
    deliverNtfyApprovalUpdate: async () => undefined,
    deliverWebhookApprovalUpdate: async () => undefined,
  } as unknown as BuiltinChannelRuntimeDeps;
  const runtime = new BuiltinChannelRuntime(deps);
  runtime.registerPlugins();
  return { runtime, config, upserts };
}

const UNRESOLVABLE = 'goodvibes://secrets/goodvibes/NOT_IN_THIS_STORE';

describe('account configured and state', () => {
  test('a surface with nothing set up is unconfigured and its retest fails', async () => {
    const { runtime } = harness({ enabled: ['telegram'] });
    const account = await runtime.buildAccount('telegram');
    expect(account.configured).toBe(false);
    expect(account.state).toBe('unconfigured');
    expect(account.authState).toBe('not-configured');
    const retest = await runtime.runOperatorAction('telegram', 'account-action', { action: 'retest' }) as { ok: boolean };
    expect(retest.ok).toBe(false);
    const doctor = await runtime.runOperatorAction('telegram', 'doctor') as ChannelDoctorReport;
    expect(doctor.checks.find((check) => check.id === 'configured')?.status).toBe('fail');
    expect(doctor.checks.find((check) => check.id === 'credentials')?.status).toBe('fail');
  });

  test('the terminal UI has nothing to configure and is configured', async () => {
    const { runtime } = harness();
    const account = await runtime.buildAccount('tui');
    expect(account.configured).toBe(true);
    expect(account.state).toBe('healthy');
  });

  test('a token reference that does not resolve is not healthy', async () => {
    const { runtime } = harness({
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE, botUsername: 'gv_bot' } },
      enabled: ['telegram'],
    });
    const account = await runtime.buildAccount('telegram');
    expect(account.configured).toBe(true);
    expect(account.state).not.toBe('healthy');
    expect(account.authState).not.toBe('linked');
  });

  test('a Slack surface with only a webhook URL is healthy, a missing bot token notwithstanding', async () => {
    const previous = process.env['SLACK_WEBHOOK_URL'];
    process.env['SLACK_WEBHOOK_URL'] = 'https://hooks.example.invalid/services/T/B/X';
    try {
      const { runtime } = harness({ enabled: ['slack'] });
      const account = await runtime.buildAccount('slack');
      expect(account.configured).toBe(true);
      expect(account.state).toBe('healthy');
    } finally {
      if (previous === undefined) delete process.env['SLACK_WEBHOOK_URL'];
      else process.env['SLACK_WEBHOOK_URL'] = previous;
    }
  });

  test('a doctor asked about an account that does not exist says so instead of echoing another account', async () => {
    const { runtime } = harness({ surfaces: { ntfy: { topic: 'alerts' } } });
    const doctor = await runtime.runOperatorAction('ntfy', 'doctor', { accountId: 'no-such-account' }) as ChannelDoctorReport;
    expect(doctor.checks[0]?.id).toBe('account-found');
    expect(doctor.checks[0]?.status).toBe('fail');
    expect(doctor.metadata['requestedAccountFound']).toBe(false);
    expect(doctor.metadata['accountId']).toBe('alerts');
  });
});

describe('setup on a surface with nothing provided', () => {
  test('ntfy setup with no input does not switch the surface on or report success', async () => {
    const { runtime, config } = harness();
    const result = await runtime.runOperatorAction('ntfy', 'account-action', { action: 'setup' }) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(config.get('surfaces.ntfy.enabled')).not.toBe(true);
  });

  test('ntfy setup with a topic enables it', async () => {
    const { runtime, config } = harness();
    const result = await runtime.runOperatorAction('ntfy', 'account-action', { action: 'setup', topic: 'alerts' }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(config.get('surfaces.ntfy.enabled')).toBe(true);
  });

  test('slack setup with only a default channel stores it but does not enable or succeed', async () => {
    const { runtime, config } = harness();
    const result = await runtime.runOperatorAction('slack', 'account-action', { action: 'setup', defaultChannel: 'general' }) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(config.get('surfaces.slack.defaultChannel')).toBe('general');
    expect(config.get('surfaces.slack.enabled')).not.toBe(true);
  });

  test('slack setup with nothing says what to provide', async () => {
    const { runtime } = harness();
    const result = await runtime.runOperatorAction('slack', 'account-action', { action: 'setup' }) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('botToken');
  });
});

describe('channel action outcomes', () => {
  test('only ok is success: a missing account, a bad lifecycle action and an unknown action say which they are', async () => {
    const { runtime } = harness({ surfaces: { ntfy: { topic: 'alerts' } }, enabled: ['ntfy'] });
    expect((await runtime.invokeOperatorAction('ntfy', 'inspect-account', { accountId: 'nobody' })).status).toBe('not-found');
    expect((await runtime.invokeOperatorAction('ntfy', 'account-action', { action: 'nope' })).status).toBe('refused');
    const unknown = await runtime.invokeOperatorAction('ntfy', 'no-such-action');
    expect(unknown.status).toBe('unknown-action');
    if (unknown.status === 'unknown-action') expect(unknown.known).toContain('doctor');
    expect((await runtime.invokeOperatorAction('ntfy', 'doctor')).status).toBe('ok');
  });
});

describe('actor authorization', () => {
  test('an action name the surface does not have is not allowed', async () => {
    const { runtime } = harness({ surfaces: { ntfy: { topic: 'alerts' } }, enabled: ['ntfy'] });
    const unknown = await runtime.runOperatorAction('ntfy', 'authorize-actor-action', { actionId: 'anything', actorId: 'u1' }) as { allowed: boolean; reason: string; metadata: Record<string, unknown> };
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toContain("Unknown action 'anything'");
    const known = await runtime.runOperatorAction('ntfy', 'authorize-actor-action', { actionId: 'inspect', actorId: 'u1' }) as { allowed: boolean; metadata: Record<string, unknown> };
    expect(known.allowed).toBe(true);
    expect(known.metadata['actorEvaluated']).toBe(true);
  });

  test('an actor off a non-empty allowlist is refused, an anonymous one too, a listed one is allowed', async () => {
    const { runtime } = harness({ surfaces: { ntfy: { topic: 'alerts' } }, enabled: ['ntfy'], allowlistUserIds: ['owner'] });
    const ask = (actorId?: string) => runtime.runOperatorAction('ntfy', 'authorize-actor-action', { actionId: 'inspect', ...(actorId ? { actorId } : {}) }) as Promise<{ allowed: boolean; reason: string }>;
    const stranger = await ask('stranger');
    expect(stranger.allowed).toBe(false);
    expect(stranger.reason).toContain("not on the surface's user list");
    const anonymous = await ask();
    expect(anonymous.allowed).toBe(false);
    expect(anonymous.reason).toContain('no actorId');
    expect((await ask('owner')).allowed).toBe(true);
  });

  test('authorizing without an action name is refused, not answered for an action called unknown', async () => {
    const { runtime } = harness({ surfaces: { ntfy: { topic: 'alerts' } }, enabled: ['ntfy'] });
    for (const input of [{ actorId: 'u1' }, { actionId: '  ', actorId: 'u1' }]) {
      const result = await runtime.runOperatorAction('ntfy', 'authorize-actor-action', input) as { ok?: boolean; error?: string; allowed?: boolean };
      expect(result.ok).toBe(false);
      expect(result.allowed).toBeUndefined();
    }
  });
});

describe('allowlist edits', () => {
  const policies = [
    { id: 'g-other', groupId: 'B', workspaceId: 'W', allowlistUserIds: ['keep-me'], allowlistChannelIds: [], allowlistGroupIds: [] },
  ];

  test('an edit scoped to a group and a workspace does not rewrite another group in that workspace', async () => {
    const { runtime, upserts } = harness({ groupPolicies: policies });
    await runtime.runOperatorAction('slack', 'edit-allowlist', { add: ['user:U1'], groupId: 'A', workspaceId: 'W', callerUserId: 'U1' });
    const groups = (upserts[0]?.['groupPolicies'] ?? []) as { id: string; groupId?: string; allowlistUserIds: string[] }[];
    const other = groups.find((group) => group.id === 'g-other');
    expect(other?.groupId).toBe('B');
    expect(other?.allowlistUserIds).toEqual(['keep-me']);
    const created = groups.find((group) => group.groupId === 'A');
    expect(created?.id).toBe('allowlist:slack:A:W');
    expect(created?.allowlistUserIds).toEqual(['U1']);
  });

  test('a name that matches no one is unresolved, and an edit carrying it is refused and changes nothing', async () => {
    const { runtime, upserts } = harness();
    const resolution = await runtime.runOperatorAction('slack', 'resolve-allowlist', { add: ['someone'], kind: 'user' }) as { resolved: unknown[]; unresolved: string[] };
    expect(resolution.resolved).toHaveLength(0);
    expect(resolution.unresolved).toEqual(['someone']);
    const edit = await runtime.invokeOperatorAction('slack', 'edit-allowlist', { add: ['someone'], kind: 'user', force: true });
    expect(edit.status).toBe('refused');
    const noKind = await runtime.invokeOperatorAction('slack', 'edit-allowlist', { add: ['alice'] });
    expect(noKind.status).toBe('refused');
    expect(upserts).toHaveLength(0);
  });

  test('the first entry on an empty user list is refused unless the caller stays admitted', async () => {
    const { runtime, upserts } = harness();
    expect((await runtime.invokeOperatorAction('slack', 'edit-allowlist', { add: ['user:U9'] })).status).toBe('refused');
    expect(upserts).toHaveLength(0);
    expect((await runtime.invokeOperatorAction('slack', 'edit-allowlist', { add: ['user:U9'], callerUserId: 'U9' })).status).toBe('ok');
    expect(upserts).toHaveLength(1);
  });
});

