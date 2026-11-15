/**
 * The session-store import never overwrites a home store it could not read,
 * and reports the companion files it could not use.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacySessionStores } from '../platform/src/platform/control-plane/index.ts';
import { HomeSessionStoreUnreadableError } from '../platform/src/platform/control-plane/session-store-importer.ts';
import type { PersistedChatSession } from '../platform/src/platform/companion/companion-chat-persistence.ts';

/** A companion chat saved as one file by an earlier version, the format the fold reads from other instances. */
function saveCompanionChat(dir: string, chat: PersistedChatSession): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chat.meta.id}.json`), JSON.stringify(chat));
}

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'importer-guards-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function companionDirWith(sessions: string[]): Promise<string> {
  const dir = join(root(), 'companion');
  const now = Date.now();
  for (const id of sessions) {
    saveCompanionChat(dir, {
      meta: { id, kind: 'companion-chat', title: `Chat ${id}`, model: null, provider: null, systemPrompt: null, status: 'active', createdAt: now, updatedAt: now, closedAt: null, messageCount: 1 },
      messages: [{ id: `${id}-m1`, sessionId: id, role: 'user', content: 'hello', attachments: [], createdAt: now }],
    });
  }
  return dir;
}

describe('importLegacySessionStores', () => {
  test('an unreadable home store is left exactly as it was and the import reports why', async () => {
    const dir = root();
    const homeStorePath = join(dir, 'home', 'control-plane', 'sessions.json');
    mkdirSync(join(dir, 'home', 'control-plane'), { recursive: true });
    const damaged = '{"sessions": [ {"id": "kept-session"';
    writeFileSync(homeStorePath, damaged);
    const companion = await companionDirWith(['legacy-one']);

    const run = importLegacySessionStores({ homeStorePath, sources: [{ kind: 'companion-dir', path: companion, project: 'unknown' }] });

    await expect(run).rejects.toBeInstanceOf(HomeSessionStoreUnreadableError);
    await expect(run).rejects.toThrow(/left untouched/);
    expect(readFileSync(homeStorePath, 'utf8')).toBe(damaged);
  });

  test('companion files that cannot be used are listed in the result', async () => {
    const dir = root();
    const homeStorePath = join(dir, 'home', 'sessions.json');
    const companion = await companionDirWith(['good-one']);
    writeFileSync(join(companion, 'broken.json'), '{ not valid json');

    const result = await importLegacySessionStores({ homeStorePath, sources: [{ kind: 'companion-dir', path: companion, project: 'unknown' }] });

    expect(result.imported).toBe(1);
    expect(result.skippedFiles).toEqual([join(companion, 'broken.json')]);
  });
});
