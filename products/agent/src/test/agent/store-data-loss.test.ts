/**
 * store-data-loss.test.ts, the stores that read leniently and write whole files
 * do not erase what they could not read, version ids stay unique at the cap, and
 * two processes writing one file keep both writers' changes.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentCalendarRegistry } from '../../agent/calendar-registry.ts';
import { AgentDocumentRegistry, documentStorePath } from '../../agent/document-registry.ts';
import { agentChannelDeliveryReceiptPath, readAgentChannelDeliveryReceipts, recordAgentChannelDeliveryReceipt } from '../../agent/channel-delivery-receipts.ts';
import { appendChannelRoutingSyncReceipts, channelRoutingSyncReceiptPath, readChannelRoutingSyncReceipts } from '../../agent/channel-routing-sync-receipts.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');

function unreadableCopies(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.startsWith(`${path.split('/').pop()}.unreadable-`));
}

describe('a write does not erase an entry the parser rejected', () => {
  test('a delivery receipt file with one damaged entry is kept beside the file before the new receipt is written', () => {
    const root = makeProjectTempDir('gv-loss-receipts');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const path = agentChannelDeliveryReceiptPath(paths);
      mkdirSync(dirname(path), { recursive: true });
      const damaged = `${JSON.stringify({ version: 1, receipts: [{ version: 1, id: 'half-written' }] })}\n`;
      writeFileSync(path, damaged);

      recordAgentChannelDeliveryReceipt(paths, {
        source: 'command',
        deliveryInput: { message: 'hello', channel: 'slack:ops' },
        result: { message: 'hello', title: 'Hello', target: { kind: 'surface', surfaceKind: 'slack', routeId: 'ops' }, strategyCount: 1 },
      });

      expect(readAgentChannelDeliveryReceipts(paths).receipts).toHaveLength(1);
      const copies = unreadableCopies(path);
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dirname(path), copies[0]!), 'utf8')).toBe(damaged);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a routing sync receipt file that is not valid JSON is kept before it is replaced', () => {
    const root = makeProjectTempDir('gv-loss-sync-receipts');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const path = channelRoutingSyncReceiptPath(paths);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"version":1,"receipts":[{"id":"crs-1",');

      appendChannelRoutingSyncReceipts(paths, [{
        version: 1, id: 'crs-2', createdAt: '2026-01-01T00:00:00.000Z', routeId: 'r', surfaceKind: 'slack', profileId: 'p',
        previousSyncState: 'pending', outcome: 'synced', methodId: 'channels.routing.assign',
      }]);

      expect(readChannelRoutingSyncReceipts(paths).receipts).toHaveLength(1);
      expect(readFileSync(join(dirname(path), unreadableCopies(path)[0]!), 'utf8')).toContain('crs-1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a clean receipt file leaves no copy behind', () => {
    const root = makeProjectTempDir('gv-loss-clean');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const receipt = {
        version: 1 as const, id: 'crs-1', createdAt: '2026-01-01T00:00:00.000Z', routeId: 'r', surfaceKind: 'slack', profileId: 'p',
        previousSyncState: 'pending', outcome: 'synced' as const, methodId: 'channels.routing.assign',
      };
      appendChannelRoutingSyncReceipts(paths, [receipt]);
      appendChannelRoutingSyncReceipts(paths, [{ ...receipt, id: 'crs-2' }]);

      expect(unreadableCopies(channelRoutingSyncReceiptPath(paths))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a document the parser rejects is kept in a copy when another document is written', () => {
    const root = makeProjectTempDir('gv-loss-docs');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const registry = AgentDocumentRegistry.fromShellPaths(paths);
      const path = documentStorePath(paths);
      mkdirSync(dirname(path), { recursive: true });
      const original = `${JSON.stringify({ version: 1, documents: [{ id: 'empty-body', title: 'Empty body', body: '' }] })}\n`;
      writeFileSync(path, original);

      registry.create({ title: 'Fresh', body: 'Some text.' });

      expect(registry.list().map((d) => d.id)).toEqual(['fresh']);
      expect(readFileSync(join(dirname(path), unreadableCopies(path)[0]!), 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a calendar entry the parser rejects is kept in a copy when another event is written', () => {
    const root = makeProjectTempDir('gv-loss-cal');
    try {
      const path = join(root, 'calendar.json');
      const original = `${JSON.stringify({ version: 1, events: [{ id: 'no-title', start: '2026-01-01' }] })}\n`;
      writeFileSync(path, original);

      new AgentCalendarRegistry(path).create({ title: 'Dentist', start: '2026-02-01' });

      expect(readFileSync(join(root, unreadableCopies(path)[0]!), 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('document version ids', () => {
  test('stay unique past the 50-version cap', () => {
    const root = makeProjectTempDir('gv-version-ids');
    try {
      const registry = AgentDocumentRegistry.fromShellPaths(createShellPathService({ workingDirectory: root, homeDirectory: root }));
      registry.create({ title: 'Long lived', body: 'v1 text' });
      let last = registry.get('long-lived')!;
      for (let i = 0; i < 60; i += 1) last = registry.update('long-lived', { body: `revision ${i}` });

      const ids = last.versions.map((v) => v.id);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
      expect(ids.at(-1)).toBe('v61');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('two processes writing one store', () => {
  test('every comment either writer added to one document survives', async () => {
    const root = makeProjectTempDir('gv-doc-concurrent');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const storePath = documentStorePath(paths);
      AgentDocumentRegistry.fromShellPaths(paths).create({ title: 'Shared', body: 'Shared text.' });
      const script = join(root, 'comment-writer.ts');
      writeFileSync(script, [
        `import { AgentDocumentRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'document-registry.ts'))};`,
        'const [storePath, prefix, count] = process.argv.slice(2);',
        'const registry = new AgentDocumentRegistry(storePath!);',
        'for (let i = 0; i < Number(count); i += 1) registry.addComment("shared", { body: `${prefix} ${i}` });',
        '',
      ].join('\n'));

      const results = await Promise.all(['alpha', 'beta'].map(async (prefix) => {
        const proc = Bun.spawn(['bun', 'run', script, storePath, prefix, '15'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        return { stderr, exitCode };
      }));

      for (const result of results) expect(result).toEqual({ stderr: '', exitCode: 0 });
      expect(AgentDocumentRegistry.fromShellPaths(paths).get('shared')!.comments).toHaveLength(30);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
