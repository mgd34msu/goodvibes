import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '@/input/command-registry.ts';
import type { OperatorRpc } from '@/runtime/client/operator-endpoint.ts';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];

// Only the connection resolution is replaced: the command, its argument
// validation and its rendering all run, and every verb's operator method id
// and payload is recorded at the wire boundary.
const invocations: Array<{ methodId: string; input: unknown }> = [];
let resolutions = 0;
let rpc: OperatorRpc = { available: false, reason: 'no control-plane base URL is configured (fixture)' };
let respond: (methodId: string, input: unknown) => unknown = () => { throw new Error('unexpected operator call'); };

const operatorRpc = await import('@/input/commands/operator-rpc.ts');
mock.module('@/input/commands/operator-rpc.ts', () => ({
  ...operatorRpc,
  getOperatorRpc: () => { resolutions++; return rpc; },
}));
const { registerPrincipalsRuntimeCommands, renderPrincipal } = await import('@/input/commands/principals-runtime.ts');

const alice = {
  id: 'p1', name: 'Alice', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }], createdAt: 0, updatedAt: 0,
} as Principal;

beforeEach(() => {
  invocations.length = 0;
  resolutions = 0;
  rpc = { available: false, reason: 'no control-plane base URL is configured (fixture)' };
  respond = () => { throw new Error('unexpected operator call'); };
});
afterEach(() => { mock.restore(); });

function connect(): void {
  rpc = {
    available: true,
    platformClient: {
      operator: {
        invoke: async (methodId: string, input: unknown) => {
          invocations.push({ methodId, input });
          return respond(methodId, input);
        },
      },
    },
  } as unknown as OperatorRpc;
}

function makeCtx(): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    platform: {
      configManager: { get: () => undefined },
    },
    workspace: {},
  } as unknown as CommandContext & { printed: string[] };
}

function makeRegistry() {
  const registry = new CommandRegistry();
  registerPrincipalsRuntimeCommands(registry);
  return registry;
}

async function run(args: string[]): Promise<string> {
  const ctx = makeCtx();
  await makeRegistry().get('principals')!.handler(args, ctx);
  return ctx.printed.join('\n');
}

describe('/principals usage paths never resolve the operator connection', () => {
  test('unknown subcommand prints usage', async () => {
    expect(await run(['bogus'])).toContain('Usage: /principals <subcommand>');
    expect(resolutions).toBe(0);
  });

  test('get without an id prints usage', async () => {
    expect(await run(['get'])).toBe('Usage: /principals get <id>');
    expect(resolutions).toBe(0);
  });

  test('create without a valid kind prints usage', async () => {
    expect(await run(['create', 'Alice', 'bogus-kind'])).toContain('Usage: /principals create <name>');
    expect(resolutions).toBe(0);
  });

  test('update without an id prints usage', async () => {
    expect(await run(['update'])).toContain('Usage: /principals update <id>');
    expect(resolutions).toBe(0);
  });

  test('delete without an id prints usage', async () => {
    expect(await run(['delete'])).toBe('Usage: /principals delete <id>');
    expect(resolutions).toBe(0);
  });

  test('resolve without channel+value prints usage', async () => {
    expect(await run(['resolve', 'slack'])).toContain('Usage: /principals resolve <channel> <value>');
    expect(resolutions).toBe(0);
  });

  test('a malformed identity is refused before the connection is resolved', async () => {
    expect(await run(['create', 'Alice', 'user', 'not-an-identity'])).toContain('refused: not a channel:value identity: not-an-identity');
    expect(resolutions).toBe(0);
    expect(invocations).toEqual([]);
  });
});

describe('/principals with no reachable operator connection', () => {
  test('list prints the refusal reason and sends nothing', async () => {
    expect(await run(['list'])).toBe('[principals] no control-plane base URL is configured (fixture)');
    expect(invocations).toEqual([]);
  });

  test('resolve with valid args prints the refusal reason and sends nothing', async () => {
    expect(await run(['resolve', 'slack', 'U123'])).toBe('[principals] no control-plane base URL is configured (fixture)');
    expect(invocations).toEqual([]);
  });
});

describe('/principals verbs over the operator wire', () => {
  beforeEach(connect);

  test('list sends principals.list and renders each principal', async () => {
    respond = () => ({ principals: [alice] });
    const out = await run(['list']);
    expect(invocations).toEqual([{ methodId: 'principals.list', input: {} }]);
    expect(out).toContain('Principals:');
    expect(out).toContain('p1  Alice  [user]');
    expect(out).toContain('slack:U123');
  });

  test('list says so when there are no principals', async () => {
    respond = () => ({ principals: [] });
    expect(await run(['list'])).toBe('[principals] no principals registered.');
  });

  test('get sends principals.get with the principal id', async () => {
    respond = () => ({ principal: alice });
    const out = await run(['get', 'p1']);
    expect(invocations).toEqual([{ methodId: 'principals.get', input: { principalId: 'p1' } }]);
    expect(out).toContain('Alice');
  });

  test('create sends principals.create with name, kind and parsed identities', async () => {
    respond = () => ({ principal: alice });
    const out = await run(['create', 'Alice', 'user', 'slack:U123']);
    expect(invocations).toEqual([{
      methodId: 'principals.create',
      input: { name: 'Alice', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }] },
    }]);
    expect(out).toContain('[principals create] created p1');
  });

  test('update sends only the flags given, and clears identities for "none"', async () => {
    respond = () => ({ principal: alice });
    await run(['update', 'p1', '--name', 'Alicia']);
    await run(['update', 'p1', '--kind', 'bot', '--identities', 'none']);
    expect(invocations).toEqual([
      { methodId: 'principals.update', input: { principalId: 'p1', name: 'Alicia' } },
      { methodId: 'principals.update', input: { principalId: 'p1', kind: 'bot', identities: [] } },
    ]);
  });

  test('delete sends principals.delete and reports whether anything was removed', async () => {
    respond = () => ({ deleted: true });
    expect(await run(['delete', 'p1', '--yes'])).toBe('[principals delete] deleted p1.');
    respond = () => ({ deleted: false });
    expect(await run(['delete', 'p9', '--yes'])).toBe('[principals delete] no principal found with id p9.');
    expect(invocations).toEqual([
      { methodId: 'principals.delete', input: { principalId: 'p1' } },
      { methodId: 'principals.delete', input: { principalId: 'p9' } },
    ]);
  });

  test('resolve sends principals.resolve and never names an unmapped identity', async () => {
    respond = () => ({ known: true, principal: alice });
    expect(await run(['resolve', 'slack', 'U123'])).toContain('slack:U123 -> Alice');
    respond = () => ({ known: false });
    expect(await run(['resolve', 'slack', 'U999'])).toContain('unknown principal: slack:U999 is not mapped');
    expect(invocations).toEqual([
      { methodId: 'principals.resolve', input: { channel: 'slack', value: 'U123' } },
      { methodId: 'principals.resolve', input: { channel: 'slack', value: 'U999' } },
    ]);
  });

  test('a failing call is reported under the verb and nothing else is sent', async () => {
    respond = () => { throw new Error('boom'); };
    expect(await run(['get', 'p1'])).toBe('[principals get] boom');
    expect(invocations).toHaveLength(1);
  });
});

describe('renderPrincipal', () => {
  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      id: 'p1',
      name: 'Alice',
      kind: 'user',
      identities: [],
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as Principal;
  }

  test('renders id, name, and kind', () => {
    const text = renderPrincipal(principal());
    expect(text).toContain('p1');
    expect(text).toContain('Alice');
    expect(text).toContain('[user]');
  });

  test('renders channel identities when present', () => {
    const text = renderPrincipal(principal({ identities: [{ channel: 'slack', value: 'U123' }] }));
    expect(text).toContain('slack:U123');
  });

  test('renders "(none)" when there are no identities', () => {
    const text = renderPrincipal(principal({ identities: [] }));
    expect(text).toContain('identities: (none)');
  });
});
