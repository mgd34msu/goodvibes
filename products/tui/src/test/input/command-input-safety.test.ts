/**
 * Commands that act on typed input must refuse what they cannot read instead
 * of guessing: a mistyped flag, an ambiguous id prefix, a malformed identity
 * list, a failed signature, a missing path. Each test names the wrong action
 * the command used to take and asserts it no longer happens.
 */
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPlatformAccessRuntimeCommands } from '../../input/commands/platform-access-runtime.ts';
import { registerPlatformServicesRuntimeCommands } from '../../input/commands/platform-services-runtime.ts';
import { registerShareRuntimeCommands } from '../../input/commands/share-runtime.ts';
import { registerPrincipalsRuntimeCommands } from '../../input/commands/principals-runtime.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';
import { registerPluginRuntimeCommands } from '../../input/commands/plugin-runtime.ts';
import { handleRemoteCancelCommand, registerRemoteRuntimeCommands } from '../../input/commands/remote-runtime.ts';
import { registerSettingsSyncRuntimeCommands } from '../../input/commands/settings-sync-runtime.ts';
import { registerServicesRuntimeCommands } from '../../input/commands/services-runtime.ts';
import { registerProfileSyncRuntimeCommands } from '../../input/commands/profile-sync-runtime.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { providerCommand } from '../../input/commands/provider.ts';
import { handleSandboxSessionCommand } from '../../input/commands/platform-sandbox-session.ts';
import { handleRecallFilesReview } from '../../input/commands/recall-files.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root = '';
beforeEach(() => {
  root = makeProjectTempDir('gv-command-input-safety');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Workspace paths that resolve under `root` and throw on a non-string, like the real service. */
function shellPaths() {
  const resolveWorkspacePath = (path: unknown): string => {
    if (typeof path !== 'string') throw new TypeError('path must be a string');
    return join(root, path);
  };
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveWorkspacePath,
    resolveProjectPath: (...parts: string[]) => join(root, ...parts),
    resolveUserPath: (...parts: string[]) => join(root, ...parts),
  };
}

function makeCtx(extra: Record<string, unknown> = {}): { ctx: CommandContext; out: string[] } {
  const out: string[] = [];
  const base = {
    print: (text: string) => { out.push(text); },
    renderRequest: () => {},
    exit: () => {},
    session: { conversationManager: {}, runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'sess-1' } },
    provider: {},
    workspace: { shellPaths: shellPaths() },
    platform: { configManager: {} },
    ops: {},
    extensions: {},
    clients: {},
  };
  const merged = { ...base, ...extra } as Record<string, unknown>;
  for (const key of ['session', 'provider', 'workspace', 'platform', 'ops', 'extensions', 'clients'] as const) {
    if (extra[key] !== undefined) merged[key] = { ...(base[key] as object), ...(extra[key] as object) };
  }
  return { ctx: merged as unknown as CommandContext, out };
}

function command(register: (registry: CommandRegistry) => void, name: string) {
  const registry = new CommandRegistry();
  register(registry);
  return registry.get(name)!;
}

// Bun's fetch type also carries `preconnect`, which a stub has no use for.
function fakeFetch(handler: (url: unknown, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect() {} });
}

describe('/auth login', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function authCtx(stored: Map<string, string>) {
    let concealed: { onSubmit: (value: string) => void | Promise<void> } | undefined;
    const made = makeCtx({
      platform: { secretsManager: { set: async (k: string, v: string) => { stored.set(k, v); } }, subscriptionManager: {}, serviceRegistry: {} },
      beginConcealedInput: (req: { onSubmit: (value: string) => void | Promise<void> }) => { concealed = req; },
    });
    return { ...made, submit: (value: string) => concealed!.onSubmit(value), isAsking: () => concealed !== undefined };
  }

  test('login posts under the daemon base path rather than the origin root', async () => {
    const urls: string[] = [];
    globalThis.fetch = fakeFetch(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ token: 'tok-p' }), { status: 200 });
    });
    const { ctx } = authCtx(new Map());
    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'daemon', 'http://127.0.0.1:1/goodvibes', 'owner', 'pw'], ctx);
    expect(urls).toEqual(['http://127.0.0.1:1/goodvibes/login']);
  });

  test('without a password argument the password is asked for with masked input and never printed', async () => {
    const calls: Array<{ body: string }> = [];
    globalThis.fetch = fakeFetch(async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 });
    });
    const stored = new Map<string, string>();
    const { ctx, out, submit, isAsking } = authCtx(stored);

    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'daemon', 'http://127.0.0.1:1', 'owner'], ctx);
    expect(isAsking()).toBe(true);
    expect(calls).toHaveLength(0);

    await submit('hunter2-secret');
    expect(JSON.parse(calls[0]!.body)).toEqual({ username: 'owner', password: 'hunter2-secret' });
    expect(stored.get('DAEMON_SESSION_TOKEN')).toBe('tok-1');
    expect(out.join('\n')).not.toContain('hunter2-secret');
  });

  test('a password is never sent over plain http to another machine', async () => {
    const urls: string[] = [];
    globalThis.fetch = fakeFetch(async (url: unknown) => { urls.push(String(url)); return new Response('{}', { status: 200 }); });
    const { ctx, isAsking } = authCtx(new Map());
    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'daemon', 'http://daemon.example:3421', 'owner'], ctx);
    expect(isAsking()).toBe(false);
    expect(urls).toEqual([]);
  });

  test('a rejected login does not echo the response body, which may reflect the credentials', async () => {
    globalThis.fetch = fakeFetch(async () => new Response('bad password hunter2-secret for owner', { status: 401 }));
    const stored = new Map<string, string>();
    const { ctx, out, submit } = authCtx(stored);
    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'daemon', 'http://127.0.0.1:1', 'owner'], ctx);
    await submit('hunter2-secret');
    expect(out.join('\n')).toContain('HTTP 401');
    expect(out.join('\n')).not.toContain('hunter2-secret');
    expect(stored.size).toBe(0);
  });

  test('a server that never answers is abandoned by the request timeout and nothing is stored', async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = fakeFetch(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const stored = new Map<string, string>();
    const { ctx, out, submit } = authCtx(stored);
    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'daemon', 'http://127.0.0.1:1', 'owner'], ctx);
    await submit('pw');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(out.join('\n')).toContain('timed out');
    expect(stored.size).toBe(0);
  });

  test('a password argument still works but warns that it stays on screen', async () => {
    globalThis.fetch = fakeFetch(async () => new Response(JSON.stringify({ token: 'tok-2' }), { status: 200 }));
    const stored = new Map<string, string>();
    const { ctx, out } = authCtx(stored);
    await command(registerPlatformAccessRuntimeCommands, 'auth').handler(['login', 'listener', 'http://127.0.0.1:1', 'owner', 'pw'], ctx);
    expect(stored.get('LISTENER_SESSION_TOKEN')).toBe('tok-2');
    expect(out.join('\n')).toContain('visible on screen');
  });
});

describe('bundle subcommands without a mode or path', () => {
  test('/install bundle prints usage instead of throwing on an undefined path', async () => {
    const { ctx, out } = makeCtx();
    await command(registerPlatformAccessRuntimeCommands, 'install').handler(['bundle'], ctx);
    expect(out.join('\n')).toContain('Usage: /install bundle');
    out.length = 0;
    await command(registerPlatformAccessRuntimeCommands, 'install').handler(['bundle', 'foo'], ctx);
    expect(out.join('\n')).toContain('Usage: /install bundle');
  });

  test('/storage bundle prints usage instead of throwing on an undefined path', async () => {
    const { ctx, out } = makeCtx({
      platform: {
        secretsManager: {
          inspect: async () => ({ policy: 'x', secureKeys: 0, plaintextKeys: 0, locations: [], warnings: [] }),
          list: async () => [],
          listDetailed: async () => [],
        },
      },
    });
    await command(registerPlatformServicesRuntimeCommands, 'storage').handler(['bundle'], ctx);
    expect(out.join('\n')).toContain('Usage: /storage bundle');
  });
});

describe('/share', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a mistyped flag is refused: nothing is written and nothing is uploaded', async () => {
    let fetched = false;
    globalThis.fetch = fakeFetch(async () => { fetched = true; return new Response('{}'); });
    let began = false;
    const { ctx, out } = makeCtx({ shareReading: { begin: () => { began = true; return undefined; } } });
    await command(registerShareRuntimeCommands, 'share').handler(['md', '--reddact', '--upload'], ctx);
    expect(out.join('\n')).toContain('Unknown option: --reddact');
    expect(began).toBe(false);
    expect(fetched).toBe(false);
  });

  test('more than one output path is refused', async () => {
    const { ctx, out } = makeCtx();
    await command(registerShareRuntimeCommands, 'share').handler(['md', 'a.md', 'b.md'], ctx);
    expect(out.join('\n')).toContain('at most one output path');
  });
});

describe('/principals identities', () => {
  const principals = () => command(registerPrincipalsRuntimeCommands, 'principals');

  test('update with a token that has no channel:value is refused before any daemon call, never clearing identities', async () => {
    const { ctx, out } = makeCtx();
    await principals().handler(['update', 'p1', '--identities', 'slack'], ctx);
    const text = out.join('\n');
    expect(text).toContain('not a channel:value identity: slack');
    expect(text).toContain('Nothing was changed');
    expect(text).not.toContain('control-plane');
  });

  test('update with one good and one malformed token is refused whole', async () => {
    const { ctx, out } = makeCtx();
    await principals().handler(['update', 'p1', '--identities', 'slack:U1,discord'], ctx);
    expect(out.join('\n')).toContain('not a channel:value identity: discord');
  });

  test('create with a malformed identity is refused instead of creating a principal with fewer mappings', async () => {
    const { ctx, out } = makeCtx();
    await principals().handler(['create', 'bob', 'user', 'slack-U1'], ctx);
    expect(out.join('\n')).toContain('not a channel:value identity: slack-U1');
  });

  test('clearing identities is explicit: "none" is accepted and proceeds to the daemon', async () => {
    const { ctx, out } = makeCtx();
    await principals().handler(['update', 'p1', '--identities', 'none'], ctx);
    expect(out.join('\n')).not.toContain('refused');
    expect(out.join('\n')).toContain('[principals]');
  });
});

describe('/schedule job ids', () => {
  function jobs() {
    const removed: string[] = [];
    const list = [
      { id: 'auto-1a2b3c4d-aaaa', name: 'first' },
      { id: 'auto-1a2b9z9z-bbbb', name: 'second' },
      { id: 'solo-0001', name: 'solo' },
    ];
    const { ctx, out } = makeCtx({
      ops: {
        automationManager: {
          start: async () => {},
          listJobs: () => list,
          removeJob: async (id: string) => { removed.push(id); return true; },
        },
      },
    });
    return { ctx, out, removed };
  }
  const schedule = () => command(registerScheduleRuntimeCommands, 'schedule');

  test('a prefix shared by two jobs removes nothing and lists the candidates', async () => {
    const { ctx, out, removed } = jobs();
    await schedule().handler(['remove', 'auto-1a2b'], ctx);
    expect(removed).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('Ambiguous');
    expect(text).toContain('auto-1a2b3c4d-aaaa');
    expect(text).toContain('auto-1a2b9z9z-bbbb');
  });

  test('an exact id wins over longer ids that share it, and a unique prefix still resolves', async () => {
    const { ctx, removed } = jobs();
    await schedule().handler(['remove', 'auto-1a2b3c4d-aaaa'], ctx);
    await schedule().handler(['remove', 'solo'], ctx);
    expect(removed).toEqual(['auto-1a2b3c4d-aaaa', 'solo-0001']);
  });
});

describe('/plugin capabilities', () => {
  test('does not claim a trust tier blocks capabilities that plugins running in this process still hold', async () => {
    const capabilities = () => ({ ok: true, requested: ['fs.write'], highRisk: ['fs.write'], safe: [], tier: 'limited', blocked: ['fs.write'] });
    const { ctx, out } = makeCtx({ extensions: { pluginManager: { capabilities } } });
    await command(registerPluginRuntimeCommands, 'plugin').handler(['capabilities', 'demo'], ctx);
    const text = out.join('\n');
    expect(text).not.toMatch(/BLOCKED|blocked by trust/);
    expect(text).toContain('not enforced per capability');
    expect(text).toContain('/plugin quarantine demo');
  });
});

describe('/plugin trust', () => {
  function pluginCtx(signatureValid: boolean, answer: boolean) {
    const trust = mock((_name: string, _tier: string, _note?: string) => ({ ok: true }));
    const asked: string[] = [];
    const { ctx, out } = makeCtx({
      extensions: { pluginManager: {
        verify: () => ({ ok: signatureValid, valid: signatureValid, reason: signatureValid ? undefined : 'signature mismatch' }),
        trustSigned: () => (signatureValid ? { ok: true } : { ok: false, error: 'signature mismatch' }),
        trust,
      } },
      confirm: async (options: { title: string }) => { asked.push(options.title); return answer; },
    });
    return { ctx, out, trust, asked };
  }
  const plugin = () => command(registerPluginRuntimeCommands, 'plugin');

  test('a failed signature check asks the owner, and a declined question grants nothing', async () => {
    const { ctx, trust, asked } = pluginCtx(false, false);
    await plugin().handler(['trust', 'evil', 'trusted'], ctx);
    expect(asked).toHaveLength(1);
    expect(trust).not.toHaveBeenCalled();
  });

  test('a confirmed override grants it and records the failed check in the trust note', async () => {
    const { ctx, trust } = pluginCtx(false, true);
    await plugin().handler(['trust', 'mine', 'trusted', 'reviewed', 'by', 'me'], ctx);
    expect(trust).toHaveBeenCalledTimes(1);
    const [, tier, note] = trust.mock.calls[0]!;
    expect(tier).toBe('trusted');
    expect(note).toContain('failed signature check');
    expect(note).toContain('reviewed by me');
  });

  test('a valid signature is trusted without a question', async () => {
    const { ctx, trust, asked } = pluginCtx(true, false);
    await plugin().handler(['trust', 'signed', 'trusted'], ctx);
    expect(asked).toHaveLength(0);
    expect(trust).not.toHaveBeenCalled();
  });
});

describe('/remote', () => {
  function peer(extra: { contracts?: Record<string, { capabilityCeiling: unknown }>; artifacts?: Record<string, unknown> } = {}) {
    const registered: unknown[] = [];
    const exported: Array<[string, string | undefined]> = [];
    const imported: string[] = [];
    const runners = {
      registerContract: (contract: unknown) => { registered.push(contract); },
      getContract: (id: string) => extra.contracts?.[id] ?? null,
      getArtifact: (id: string) => extra.artifacts?.[id] ?? null,
      exportArtifact: async (id: string, path?: string) => { exported.push([id, path]); return { artifact: { id }, path: path ?? '(default)' }; },
      importArtifact: async (path: string) => { imported.push(path); return { id: 'artifact:imported', runnerId: 'r1' }; },
    };
    const snapshot = { acp: { activeConnections: [] }, supervisor: { sessions: [], degradedConnections: 0 }, runners: { contracts: [], pools: [], artifacts: [] } };
    return { clients: { peer: { getSnapshot: () => snapshot, runners } }, registered, exported, imported };
  }
  const remote = () => command(registerRemoteRuntimeCommands, 'remote');
  async function asOwner(args: string[], ctx: CommandContext) {
    const registry = new CommandRegistry();
    registerRemoteRuntimeCommands(registry);
    await registry.executeFromOwner('remote', args, ctx, `/remote ${args.join(' ')}`);
  }

  test('a first word that is an Object.prototype key is task text, not a template', async () => {
    const fake = peer();
    const spawn = mock(async (_input: { description: string; tools: string[] }) => 'runner-1');
    const { ctx, out } = makeCtx({ clients: fake.clients, ops: { acpManager: { spawn } } });
    await asOwner(['dispatch', 'constructor', 'fix', 'the', 'build'], ctx);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0].description).toBe('constructor fix the build');
    expect(out.join('\n')).toContain('template: general');
  });

  describe('rerun-local', () => {
    const artifact = (allowedTools: string[]) => ({
      id: 'artifact:a1',
      task: { task: 'inspect the logs' },
      runnerContract: {
        template: 'engineer',
        capabilityCeiling: { allowedTools, successCriteria: [], requiredEvidence: [], writeScope: [], executionProtocol: 'gather-plan-apply', reviewMode: 'none', communicationLane: 'direct' },
      },
    });

    test('spawns with only the recorded tools, shows the task and tools first-hand, and only for a directly typed command', async () => {
      const fake = peer({ artifacts: { 'artifact:a1': artifact(['read']) } });
      const spawn = mock((_input: { tools: string[]; restrictTools?: boolean }) => ({ id: 'agent-1' }));
      const { ctx, out } = makeCtx({ clients: fake.clients, ops: { agentManager: { spawn } } });
      await asOwner(['rerun-local', 'artifact:a1'], ctx);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]![0].tools).toEqual(['read']);
      expect(spawn.mock.calls[0]![0].restrictTools).toBe(true);
      const text = out.join('\n');
      expect(text).toContain('inspect the logs');
      expect(text).toContain('tools (only these): read');
    });

    test('is refused when not typed by the owner (model-invoked or programmatic)', async () => {
      const fake = peer({ artifacts: { 'artifact:a1': artifact(['read']) } });
      const spawn = mock(() => ({ id: 'agent-1' }));
      const { ctx, out } = makeCtx({ clients: fake.clients, ops: { agentManager: { spawn } } });
      await remote().handler(['rerun-local', 'artifact:a1'], ctx);
      expect(spawn).not.toHaveBeenCalled();
      expect(out.join('\n')).toContain('directly entered command');
    });

    test('an artifact with no recorded tools is not rerun as a tool-less agent', async () => {
      const fake = peer({ artifacts: { 'artifact:a1': artifact([]) } });
      const spawn = mock(() => ({ id: 'agent-1' }));
      const { ctx, out } = makeCtx({ clients: fake.clients, ops: { agentManager: { spawn } } });
      await asOwner(['rerun-local', 'artifact:a1'], ctx);
      expect(spawn).not.toHaveBeenCalled();
      expect(out.join('\n')).toContain('no allowed tools');
    });
  });

  test('artifact export and import resolve paths against the workspace, expanding the same way as /bridge', async () => {
    const fake = peer();
    const { ctx } = makeCtx({ clients: fake.clients });
    await remote().handler(['artifact', 'export', 'artifact:a1', 'out.json'], ctx);
    expect(fake.exported).toEqual([['artifact:a1', join(root, 'out.json')]]);
    await remote().handler(['import', 'in.json'], ctx);
    expect(fake.imported).toEqual([join(root, 'in.json')]);
  });

  test('importing a file that would replace a known runner\'s capability ceiling is refused', async () => {
    const fake = peer({ contracts: { r1: { capabilityCeiling: { allowedTools: ['read'] } } } });
    const file = join(root, 'wide.json');
    writeFileSync(file, JSON.stringify({ runnerId: 'r1', runnerContract: { capabilityCeiling: { allowedTools: ['read', 'exec', 'write'] } } }));
    const { ctx, out } = makeCtx({ clients: fake.clients });
    await remote().handler(['import', 'wide.json'], ctx);
    expect(fake.imported).toEqual([]);
    expect(out.join('\n')).toContain('Remote import refused');
  });

  test('cancelling an external runner reports a failed cancel instead of claiming it was requested', async () => {
    const out: string[] = [];
    await handleRemoteCancelCommand(
      'agent-1',
      [{ agentId: 'agent-1' }],
      { print: (text: string) => { out.push(text); } },
      { cancel: () => false },
      { cancel: async () => { throw new Error('connection closed'); } },
    );
    const text = out.join('\n');
    expect(text).toContain('connection closed');
    expect(text).not.toContain('Cancellation requested');
  });
});

describe('/settings-sync resolve', () => {
  test('resolving a conflict on one key leaves the live model selection alone', async () => {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, '.goodvibes', 'tui') });
    const flag = CONFIG_SCHEMA.find((entry) => typeof entry.default === 'boolean' && !entry.key.startsWith('provider.'))!;
    const bundlePath = join(root, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify({ version: 1, exportedAt: 1, source: 'settings-sync', settings: { [flag.key]: !flag.default } }));
    const runtime = { model: 'session-only-model', provider: 'session-provider', reasoningEffort: 'high' };
    const { ctx, out } = makeCtx({ platform: { configManager }, session: { runtime } });
    const sync = command(registerSettingsSyncRuntimeCommands, 'settings-sync');
    await sync.handler(['pull', 'bundle.json'], ctx);
    out.length = 0;
    await sync.handler(['resolve', flag.key, 'local'], ctx);
    expect(out.join('\n')).toContain('Resolved synced conflict');
    expect(runtime).toEqual({ model: 'session-only-model', provider: 'session-provider', reasoningEffort: 'high' });
  });

  test('inspect and pull refuse a file that is not a bundle in one line', async () => {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, '.goodvibes', 'tui') });
    const { ctx, out } = makeCtx({ platform: { configManager } });
    const sync = command(registerSettingsSyncRuntimeCommands, 'settings-sync');
    writeFileSync(join(root, 'not-json.json'), 'not json at all');
    writeFileSync(join(root, 'settings-is-a-number.json'), JSON.stringify({ version: 1, exportedAt: 1, settings: 5 }));
    writeFileSync(join(root, 'no-export-time.json'), JSON.stringify({ version: 1, settings: {} }));
    for (const sub of ['inspect', 'pull']) {
      for (const file of ['not-json.json', 'settings-is-a-number.json', 'no-export-time.json', 'missing.json']) {
        out.length = 0;
        const reason = /not valid JSON|not a settings sync bundle|Cannot read/;
        if (sub === 'pull') {
          // A pull that fails throws its refusal, so a modal action reports Failed instead of Done.
          await expect(Promise.resolve().then(() => sync.handler([sub, file], ctx))).rejects.toThrow(reason);
          continue;
        }
        await sync.handler([sub, file], ctx);
        expect(out.join('\n').split('\n')).toHaveLength(1);
        expect(out.join('\n')).toMatch(reason);
      }
    }
  });
});

describe('/services import and /profile-sync import', () => {
  test('/services list and inspect name an unusable services file instead of showing an empty list', async () => {
    const services = { getAll: () => ({}), inspect: async () => null, unreadableReason: () => '/w/services.json is not valid JSON' };
    for (const args of [['list'], ['inspect', 'github'], ['doctor']]) {
      const { ctx, out } = makeCtx({ platform: { serviceRegistry: services } });
      await command(registerServicesRuntimeCommands, 'services').handler(args, ctx);
      expect(out.join('\n')).toContain('Service list unusable: /w/services.json is not valid JSON');
      expect(out.join('\n')).not.toContain('Unknown service');
      expect(out.join('\n')).not.toContain('No services configured');
    }
  });

  test('/services import refuses a file that is not a services config and keeps the current one', async () => {
    const services = { getAll: () => ({ github: { authType: 'bearer', tokenKey: 'GITHUB_TOKEN' } }) };
    const { ctx, out } = makeCtx({ platform: { serviceRegistry: services } });
    const target = join(root, 'tui', 'services.json');
    mkdirSync(join(root, 'tui'), { recursive: true });
    writeFileSync(target, '{"keep":"me"}');
    writeFileSync(join(root, 'bad.json'), JSON.stringify({ profiles: [1, 2] }));
    await command(registerServicesRuntimeCommands, 'services').handler(['import', 'bad.json'], ctx);
    expect(out.join('\n')).toContain('Services import refused');
    expect(readFileSync(target, 'utf-8')).toBe('{"keep":"me"}');
  });

  test('/services import keeps the previous file as a backup and names what was replaced and dropped', async () => {
    const services = { getAll: () => ({ github: { authType: 'bearer', tokenKey: 'A' }, old: { authType: 'bearer', tokenKey: 'B' } }) };
    const { ctx, out } = makeCtx({ platform: { serviceRegistry: services } });
    const target = join(root, 'tui', 'services.json');
    mkdirSync(join(root, 'tui'), { recursive: true });
    writeFileSync(target, '{"previous":true}');
    writeFileSync(join(root, 'good.json'), JSON.stringify({ github: { name: 'github', authType: 'bearer', tokenKey: 'GITHUB_TOKEN' } }));
    await command(registerServicesRuntimeCommands, 'services').handler(['import', 'good.json'], ctx);
    expect(readFileSync(`${target}.bak`, 'utf-8')).toBe('{"previous":true}');
    const text = out.join('\n');
    expect(text).toContain('replaced: github');
    expect(text).toContain('no longer configured: old');
  });

  function profileCtx(existing: string[]) {
    const saved: string[] = [];
    const pm = { list: () => existing.map((name) => ({ name, timestamp: 1 })), sanitizeName: (name: string) => name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'profile', save: (name: string) => { saved.push(name); } };
    const { ctx, out } = makeCtx({
      workspace: { profileManager: pm },
      platform: { configManager: { getControlPlaneConfigDir: () => root } },
    });
    return { ctx, out, saved };
  }

  test('/profile-sync import refuses to overwrite an existing profile unless --overwrite is given, and saves nothing', async () => {
    writeFileSync(join(root, 'p.json'), JSON.stringify({ version: 1, exportedAt: 1, profiles: [{ name: 'work', data: {} }, { name: 'home', data: {} }] }));
    const { ctx, out, saved } = profileCtx(['work']);
    await command(registerProfileSyncRuntimeCommands, 'profile-sync').handler(['import', 'p.json'], ctx);
    expect(saved).toEqual([]);
    expect(out.join('\n')).toContain('already exist: work');
    out.length = 0;
    await command(registerProfileSyncRuntimeCommands, 'profile-sync').handler(['import', 'p.json', '--overwrite'], ctx);
    expect(saved).toEqual(['work', 'home']);
    expect(out.join('\n')).toContain('replaced: work');
  });

  test('/profile-sync import judges clashes by the stored (sanitized) name and refuses unstorable or colliding names up front', async () => {
    const run = async (names: string[], args: string[] = []) => {
      writeFileSync(join(root, 'p.json'), JSON.stringify({ version: 1, exportedAt: 1, profiles: names.map((name) => ({ name, data: {} })) }));
      const { ctx, out, saved } = profileCtx(['home-work']);
      await command(registerProfileSyncRuntimeCommands, 'profile-sync').handler(['import', 'p.json', ...args], ctx);
      return { text: out.join('\n'), saved };
    };
    const clash = await run(['Home Work']);
    expect(clash.saved).toEqual([]);
    expect(clash.text).toContain('already exist: home-work');
    const unstorable = await run(['ok', '!!!']);
    expect(unstorable.saved).toEqual([]);
    expect(unstorable.text).toContain('no letters or digits');
    const dup = await run(['Team A', 'team-a']);
    expect(dup.saved).toEqual([]);
    expect(dup.text).toContain('both stored as "team-a"');
  });

  test('/profile-sync import of a bundle without a profiles list reports it instead of throwing', async () => {
    writeFileSync(join(root, 'p.json'), JSON.stringify({ version: 1 }));
    const { ctx, out, saved } = profileCtx([]);
    await command(registerProfileSyncRuntimeCommands, 'profile-sync').handler(['import', 'p.json'], ctx);
    expect(saved).toEqual([]);
    expect(out.join('\n')).toContain('not a profile sync bundle');
  });
});

describe('sandbox session start', () => {
  test('a start that throws (for example a failed backend probe) is reported, not left unhandled', async () => {
    const registry = { start: async () => { throw new Error('backend exploded'); } };
    const { ctx, out } = makeCtx({ workspace: { sandboxSessionRegistry: registry }, platform: { configManager: { get: () => 'local' } } });
    await expect(handleSandboxSessionCommand(['session', 'start', 'mcp-shared'], ctx)).resolves.toBe(true);
    expect(out.join('\n')).toContain('Sandbox session command failed: backend exploded');
  });
});

describe('/session export and delete', () => {
  // Without a judgment port, redaction masks credentials only in classic mode; otherwise it fails closed.
  const classicExport = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);
  function sessionCtx(messages: unknown[]) {
    const deleted: string[] = [];
    const sessionManager = {
      list: () => [{ name: 'old-1', title: 'Old', messageCount: 1 }],
      load: () => ({ meta: { title: 'Old' }, messages }),
      delete: (name: string) => { deleted.push(name); },
    };
    const { ctx, out } = makeCtx({ session: { sessionManager } });
    return { ctx, out, deleted };
  }

  test('a message whose content is an array of parts exports its text, not [object Object]', async () => {
    const { ctx, out } = sessionCtx([{ role: 'user', content: [{ type: 'text', text: 'hello there' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }] }]);
    await classicExport(() => handleSessionWorkflowCommand(['export', 'old-1', 'text'], ctx));
    const text = out.join('\n');
    expect(text).toContain('hello there');
    expect(text).toContain('[image part omitted]');
    expect(text).not.toContain('[object Object]');
  });

  test('a printed export redacts a credential carried by the transcript', async () => {
    const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2);
    const { ctx, out } = sessionCtx([{ role: 'user', content: `my key is ${key}` }]);
    await classicExport(() => handleSessionWorkflowCommand(['export', 'old-1', 'text'], ctx));
    expect(out.join('\n')).toContain('my key is');
    expect(out.join('\n')).not.toContain(key);
  });

  test('/session delete asks for --yes like the picker asks for confirmation', async () => {
    const { ctx, deleted } = sessionCtx([]);
    await handleSessionWorkflowCommand(['delete', 'old-1'], ctx);
    expect(deleted).toEqual([]);
    await handleSessionWorkflowCommand(['delete', 'old-1', '--yes'], ctx);
    expect(deleted).toEqual(['old-1']);
  });
});

describe('/load while a turn is running', () => {
  test('is refused and neither loads the session nor clears agents', async () => {
    const load = mock(() => ({ meta: { title: 't' }, messages: [], agentRecords: [] }));
    const clear = mock(() => {});
    const { ctx, out } = makeCtx({
      isGenerating: () => true,
      session: { sessionManager: { load } },
      ops: { agentManager: { clear } },
    });
    await command(registerSessionContentCommands, 'load').handler(['old-1'], ctx);
    expect(load).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('turn is still running');
  });
});

describe('/provider-opt persistence', () => {
  function optimizerCtx(enabled: boolean) {
    const writes: Array<[string, unknown]> = [];
    const optimizer = {
      enabled,
      mode: 'manual',
      pinnedTarget: null as { providerId: string; modelId: string } | null,
      setEnabled(value: boolean) { this.enabled = value; },
      setMode(value: string) { this.mode = value; },
      pin(providerId: string, modelId: string) { this.pinnedTarget = { providerId, modelId }; },
    };
    const model = { providerId: 'anthropic', modelId: 'opus', registryKey: 'anthropic:opus' };
    const { ctx, out } = makeCtx({
      provider: { providerOptimizer: optimizer },
      platform: { configManager: { setDynamic: (key: string, value: unknown) => { writes.push([key, value]); } } },
      clients: { providerApi: { listModels: async () => [model], getCurrentModel: async () => model } },
    });
    return { ctx, out, writes, optimizer };
  }

  test('route auto is saved when the optimizer is on, so it survives a restart', async () => {
    const { ctx, writes } = optimizerCtx(true);
    await providerCommand.handler(['route', 'auto'], ctx);
    expect(writes).toEqual([['provider.optimizerMode', 'auto']]);
  });

  test('route auto while the optimizer is off is not saved (it would switch the optimizer on) and says so', async () => {
    const { ctx, out, writes } = optimizerCtx(false);
    await providerCommand.handler(['route', 'auto'], ctx);
    expect(writes).toEqual([]);
    expect(out.join('\n')).toContain('not saved');
  });

  test('pin is saved as the pinned model and mode, and the printed unpin command is the real command name', async () => {
    const { ctx, out, writes } = optimizerCtx(true);
    await providerCommand.handler(['pin', 'anthropic:opus'], ctx);
    expect(writes).toEqual([
      ['provider.optimizerPinnedModel', 'anthropic:opus'],
      ['provider.optimizerMode', 'pinned'],
    ]);
    expect(out.join('\n')).toContain('/provider-opt route manual');
  });
});

describe('/recall files', () => {
  test('a store at the read cap is reported as possibly incomplete', async () => {
    const dir = join(root, 'projection');
    mkdirSync(dir, { recursive: true });
    const records = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, scope: 'session', summary: 's' }));
    const { ctx, out } = makeCtx({ clients: { memorySpine: { list: async () => records } } });
    await handleRecallFilesReview(['--dir', 'projection'], ctx);
    expect(out.join('\n')).toContain('the most this command reads');
  });
});
