/** A typed name resolves through the plugin directory only when it names an entry exactly. */
import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import type { ChannelDirectoryEntry, ChannelDirectoryQueryOptions } from '../platform/src/platform/channels/types.js';

function entry(id: string, label: string, handle?: string): ChannelDirectoryEntry {
  return { id, surface: 'telegram', kind: 'user', label, ...(handle ? { handle } : {}), metadata: {} };
}

function registry(entries: readonly ChannelDirectoryEntry[]): ChannelPluginRegistry {
  const channelPlugins = new ChannelPluginRegistry();
  channelPlugins.register({
    id: 'telegram-test',
    surface: 'telegram',
    displayName: 'telegram',
    capabilities: ['egress', 'target_resolution'],
    queryDirectory: async (query: ChannelDirectoryQueryOptions) => entries
      .filter((candidate) => `${candidate.id} ${candidate.label} ${candidate.handle ?? ''}`.toLowerCase().includes((query.query ?? '').toLowerCase()))
      .slice(0, query.limit ?? entries.length),
  });
  return channelPlugins;
}

describe('plugin directory target resolution', () => {
  const entries = [entry('123456789', 'Dana'), entry('alice-smith', 'Alice Smith', '@alice-smith')];

  test('a partial id or name does not resolve to the entry that merely contains it', async () => {
    const channelPlugins = registry(entries);
    for (const input of ['12345', 'alice']) {
      const target = await channelPlugins.resolveTarget('telegram', { input });
      expect(target?.source).not.toBe('directory');
      expect(target?.to).toBe(input);
    }
  });

  test('an exact match resolves even when a partial match is listed first', async () => {
    const channelPlugins = registry([entry('9', 'Alice Smith Jr', '@alice-smith-jr'), ...entries]);
    const target = await channelPlugins.resolveTarget('telegram', { input: '@Alice-Smith' });
    expect(target?.source).toBe('directory');
    expect(target?.directoryEntryId).toBe('alice-smith');
  });
});
