import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { knowledgeCommand } from '../../input/commands/knowledge.ts';
import { parseBrowserImportScope } from '../../input/commands/knowledge-browser-flags.ts';

function makeContext(printed: string[], api: Record<string, unknown>, transcript: unknown[] = []): CommandContext {
  return {
    session: {
      conversationManager: { getMessageSnapshot: () => transcript },
      runtime: { sessionId: 'session-guards' },
    },
    extensions: {},
    clients: { agentKnowledgeApi: api },
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
}

describe('/knowledge import-browser-history scope', () => {
  function browserHistoryApi() {
    const calls: unknown[] = [];
    return {
      calls,
      api: {
        ingest: {
          browserHistory: async (input: unknown) => {
            calls.push(input);
            return { imported: 0, failed: 0, sources: [], errors: [], profiles: [] };
          },
        },
      },
    };
  }

  test('an unknown browser is refused by name and nothing is imported', async () => {
    const printed: string[] = [];
    const { api, calls } = browserHistoryApi();
    await knowledgeCommand.handler(['import-browser-history', '--browsers', 'nope', '--yes'], makeContext(printed, api));
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('Unknown browser nope');
    expect(printed.join('\n')).toContain('Nothing was imported');
  });

  test('a mistyped name in a list is refused instead of dropped', async () => {
    const printed: string[] = [];
    const { api, calls } = browserHistoryApi();
    await knowledgeCommand.handler(['import-browser-history', '--browsers', 'chrome,firefx', '--yes'], makeContext(printed, api));
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('Unknown browser firefx');
  });

  test('a differently cased name is accepted as the browser it names', async () => {
    const printed: string[] = [];
    const { api, calls } = browserHistoryApi();
    await knowledgeCommand.handler(['import-browser-history', '--browsers', 'Chrome', '--yes'], makeContext(printed, api));
    expect(calls).toHaveLength(1);
    expect((calls[0] as { browsers: readonly string[] }).browsers).toEqual(['chrome']);
  });

  test('without a browsers flag the importer receives an empty list, which means every browser', async () => {
    const printed: string[] = [];
    const { api, calls } = browserHistoryApi();
    await knowledgeCommand.handler(['import-browser-history', '--yes'], makeContext(printed, api));
    expect((calls[0] as { browsers: readonly string[]; limit: number }).browsers).toEqual([]);
    expect((calls[0] as { limit: number }).limit).toBe(250);
  });

  test('a limit or day count that is not a positive whole number is refused', () => {
    expect(parseBrowserImportScope(['--limit', 'abc'], 0)).toEqual({ ok: false, message: expect.stringContaining('--limit needs a whole number above zero') });
    expect(parseBrowserImportScope(['--limit', '0'], 0).ok).toBe(false);
    expect(parseBrowserImportScope(['--since-days', 'x'], 0).ok).toBe(false);
    expect(parseBrowserImportScope(['--sources', 'bookmarks'], 0)).toEqual({ ok: false, message: expect.stringContaining('Unknown source kind bookmarks') });
  });

  test('a day count becomes a cutoff relative to the supplied time', () => {
    const result = parseBrowserImportScope(['--since-days', '2'], 10 * 24 * 60 * 60 * 1000);
    expect(result.ok && result.scope.sinceMs).toBe(8 * 24 * 60 * 60 * 1000);
  });
});
