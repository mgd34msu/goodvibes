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
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');

function unreadableCopies(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.startsWith(`${path.split('/').pop()}.unreadable-`));
}

describe('a write does not erase an entry the parser rejected', () => {
  const SEND: Parameters<typeof recordAgentChannelDeliveryReceipt>[1] = {
    source: 'command',
    deliveryInput: { message: 'hello', channel: 'slack:ops' },
    result: { message: 'hello', title: 'Hello', target: { kind: 'surface', surfaceKind: 'slack', routeId: 'ops' }, strategyCount: 1 },
  };

  test('a delivery receipt this version cannot read stays in the file, unchanged, beside the new receipt', () => {
    const root = makeProjectTempDir('gv-loss-receipts');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const path = agentChannelDeliveryReceiptPath(paths);
      mkdirSync(dirname(path), { recursive: true });
      const damaged = { version: 1, id: 'half-written' };
      writeFileSync(path, `${JSON.stringify({ version: 1, receipts: [damaged] })}\n`);

      const receipt = recordAgentChannelDeliveryReceipt(paths, SEND);

      expect(readAgentChannelDeliveryReceipts(paths).receipts).toHaveLength(1);
      expect(JSON.parse(readFileSync(path, 'utf8')).receipts).toEqual([JSON.parse(JSON.stringify({ ...receipt, storeNote: undefined })), damaged]);
      expect(receipt.storeNote).toContain('left as found');
      expect(unreadableCopies(path)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a store file that is not valid JSON is copied aside before it is replaced', () => {
    const root = makeProjectTempDir('gv-loss-not-json');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const path = agentChannelDeliveryReceiptPath(paths);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"version":1,"receipts":[{"id":"r-1",');

      const receipt = recordAgentChannelDeliveryReceipt(paths, SEND);

      expect(readAgentChannelDeliveryReceipts(paths).receipts).toHaveLength(1);
      expect(readFileSync(join(dirname(path), unreadableCopies(path)[0]!), 'utf8')).toContain('r-1');
      expect(receipt.storeNote).toContain(unreadableCopies(path)[0]!);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a calendar entry the parser rejects stays in the file when another event is written', () => {
    const root = makeProjectTempDir('gv-loss-cal');
    try {
      const path = join(root, 'calendar.json');
      const rejected = { id: 'no-title', start: '2026-01-01' };
      writeFileSync(path, `${JSON.stringify({ version: 1, events: [rejected] })}\n`);

      new AgentCalendarRegistry(path).create({ title: 'Dentist', start: '2026-02-01' });

      expect(JSON.parse(readFileSync(path, 'utf8')).events).toContainEqual(rejected);
      expect(unreadableCopies(path)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a store a newer version wrote is not changed', () => {
    const root = makeProjectTempDir('gv-loss-newer');
    try {
      const path = join(root, 'calendar.json');
      const newer = `${JSON.stringify({ version: 2, events: [] })}\n`;
      writeFileSync(path, newer);

      expect(() => new AgentCalendarRegistry(path).create({ title: 'Dentist', start: '2026-02-01' })).toThrow('newer GoodVibes');
      expect(readFileSync(path, 'utf8')).toBe(newer);
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

      const ids = registry.versions('long-lived').map((v) => v.id);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
      expect(ids.at(-1)).toBe('v61');
      expect(last.versionCount).toBe(50);
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
