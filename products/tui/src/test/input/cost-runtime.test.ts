import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerCostRuntimeCommands } from '../../input/commands/cost-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function makeCtx(configGet?: (key: string) => unknown): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {},
    platform: {
      configManager: {
        get: (key: string) => (configGet ? configGet(key) : undefined),
      },
    },
  } as unknown as CommandContext & { printed: string[] };
}

describe('/cost attribution', () => {
  function makeRegistry() {
    const registry = new CommandRegistry();
    registerCostRuntimeCommands(registry);
    return registry;
  }

  test('honestly reports the daemon as disabled rather than fabricating a report', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry.get('cost')!.handler(['attribution'], ctx);
    const text = ctx.printed.join('\n');
    expect(text).toContain('[cost attribution]');
    expect(text).toContain('daemon is disabled');
  });

  describe('with the daemon enabled', () => {
    const realFetch = globalThis.fetch;
    const dirs: string[] = [];
    afterEach(() => {
      globalThis.fetch = realFetch;
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    type Request = { url: string; body: string };
    function daemonCtx(respond: (dimension: string) => Response): { ctx: CommandContext & { printed: string[] }; requests: Request[] } {
      const dir = makeProjectTempDir('gv-cost-attribution');
      dirs.push(dir);
      const requests: Request[] = [];
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === 'string' ? init.body : '';
        requests.push({ url, body });
        const dimension = /"dimension":"(\w+)"/.exec(body)?.[1] ?? new URL(url).searchParams.get('dimension') ?? '';
        return respond(dimension);
      }) as typeof fetch;
      const config: Record<string, unknown> = { 'daemon.enabled': true, 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 4317 };
      const ctx = makeCtx((key) => config[key]);
      (ctx as { workspace: unknown }).workspace = { shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }) };
      return { ctx, requests };
    }
    const result = (dimension: string, window: string, rows: unknown[] = []) => ({
      window, windowStartMs: 0, dimension, totalCostUsd: rows.length ? 1.5 : 0, costState: 'priced', costSource: 'catalog', pricingAsOf: null,
      pricedRecordCount: rows.length, unpricedRecordCount: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rows,
    });
    const agentRow = { key: 'agent-one', costUsd: 1.5, costState: 'priced', costSource: 'catalog', pricingAsOf: null, pricedRecordCount: 1, unpricedRecordCount: 0, tokens: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };

    test('requests every dimension for the 24h default and prints the rows it got back', async () => {
      const { ctx, requests } = daemonCtx((dimension) => Response.json(result(dimension, '24h', dimension === 'agent' ? [agentRow] : [])));
      await makeRegistry().get('cost')!.handler(['attribution'], ctx);
      expect(requests).toHaveLength(6);
      for (const dimension of ['agent', 'model', 'provider', 'tool', 'hook', 'mcp']) {
        expect(requests.filter((r) => r.body.includes(`"dimension":"${dimension}"`))).toHaveLength(1);
      }
      for (const request of requests) expect(request.body).toContain('"window":"24h"');
      const text = ctx.printed.join('\n');
      expect(text).toContain('Cost Attribution: 24h');
      expect(text).toContain('agent-one');
      expect(text).toContain('$1.5000');
      expect(text).toContain('in=7 out=3');
      // Primary dimensions with no rows are still shown; empty optional ones are not.
      expect(text).toContain('model (24h');
      expect(text).not.toContain('tool (24h');
    });

    test('the 7d flag selects the 7d window in every request and the heading', async () => {
      const { ctx, requests } = daemonCtx((dimension) => Response.json(result(dimension, '7d')));
      await makeRegistry().get('cost')!.handler(['attribution', '7d'], ctx);
      expect(requests).toHaveLength(6);
      for (const request of requests) expect(request.body).toContain('"window":"7d"');
      expect(ctx.printed.join('\n')).toContain('Cost Attribution: 7d');
    });

    test('--json prints the raw results as JSON instead of the formatted report', async () => {
      const { ctx } = daemonCtx((dimension) => Response.json(result(dimension, '24h')));
      await makeRegistry().get('cost')!.handler(['attribution', '--json'], ctx);
      expect(ctx.printed).toHaveLength(1);
      const parsed = JSON.parse(ctx.printed[0]!) as Array<{ dimension: string }>;
      expect(parsed.map((r) => r.dimension)).toEqual(['agent', 'model', 'provider', 'tool', 'hook', 'mcp']);
    });

    test('a failing daemon request is reported, not printed as an empty report', async () => {
      const { ctx } = daemonCtx(() => Response.json({ error: 'boom' }, { status: 500 }));
      await makeRegistry().get('cost')!.handler(['attribution'], ctx);
      const text = ctx.printed.join('\n');
      expect(text).toContain('[cost attribution] round-trip request failed');
      expect(text).not.toContain('Cost Attribution:');
    });
  });

  test('rejects an unknown or conflicting window option without contacting the daemon', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry.get('cost')!.handler(['attribution', '24h', '7d'], ctx);
    expect(ctx.printed.join('\n')).toContain('Unknown or conflicting option(s): 24h and 7d');
    const ctx2 = makeCtx();
    await registry.get('cost')!.handler(['attribution', '30d'], ctx2);
    expect(ctx2.printed.join('\n')).toContain('Unknown or conflicting option(s): 30d');
  });

  test('usage message for an unknown subcommand mentions attribution', async () => {
    const registry = makeRegistry();
    const ctx = makeCtx();
    await registry.get('cost')!.handler(['bogus'], ctx);
    expect(ctx.printed.join('\n')).toContain('attribution');
  });
});
