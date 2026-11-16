/**
 * Every local store file is rewritten whole by each save, so a save must never
 * follow a read that quietly left something out or treated a broken file as empty.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function withRoot<T>(run: (root: string) => T): T {
  const root = makeProjectTempDir('gv-local-store-integrity');
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

describe('research run store', () => {
  test('a runs.json that is not JSON is copied aside before a create replaces it', () => withRoot((root) => {
    const path = join(root, 'runs.json');
    seed(path, '{ this is not json');
    const registry = new AgentResearchRunRegistry(path);
    expect(() => registry.list()).toThrow(/Could not read Agent research run store/);
    registry.create({ title: 'New run', question: 'Why?' });
    expect(registry.list().map((run) => run.title)).toEqual(['New run']);
    const copies = readdirSync(root).filter((name) => name.startsWith('runs.json.unreadable-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, copies[0]!), 'utf-8')).toBe('{ this is not json');
  }));

  test('a show and a delete by title reach the same run, and a shared title is refused', () => withRoot((root) => {
    const registry = new AgentResearchRunRegistry(join(root, 'runs.json'));
    registry.create({ title: 'Q', question: 'Why?' });
    registry.create({ title: 'Q', question: 'Why again?' });
    expect(() => registry.get('Q')).toThrow(/2 research runs are titled/);
    expect(() => registry.delete('Q')).toThrow(/2 research runs are titled/);
    expect(registry.list()).toHaveLength(2);
  }));

  test('a checkpoint cannot end a run, and says which call does', () => withRoot((root) => {
    const registry = new AgentResearchRunRegistry(join(root, 'runs.json'));
    const run = registry.create({ title: 'Ledger', question: 'Why?' });
    registry.start(run.id);
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      expect(() => registry.checkpoint(run.id, { status, note: 'done' })).toThrow(/Use (complete|cancel|fail)/);
    }
    expect(registry.get(run.id)?.status).toBe('running');
  }));

  test('a start or resume note is screened for secrets like every other note', () => withRoot((root) => {
    const registry = new AgentResearchRunRegistry(join(root, 'runs.json'));
    const run = registry.create({ title: 'Ledger', question: 'Why?' });
    expect(() => registry.start(run.id, 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456')).toThrow(/secret-looking/);
    expect(registry.get(run.id)?.status).toBe('planned');
    registry.start(run.id);
    registry.pause(run.id);
    expect(() => registry.resume(run.id, 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456')).toThrow(/secret-looking/);
    expect(registry.get(run.id)?.status).toBe('paused');
  }));
});

describe('a store holding an entry this release cannot read', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly key: string; readonly save: (path: string) => void }> = [
    { name: 'routine', key: 'routines', save: (path) => { new AgentRoutineRegistry(path).create({ name: 'Fresh', description: 'd', steps: 's' }); } },
    { name: 'persona', key: 'personas', save: (path) => { new AgentPersonaRegistry(path).create({ name: 'Fresh', description: 'd', body: 'b' }); } },
    { name: 'note', key: 'notes', save: (path) => { new AgentNoteRegistry(path).create({ title: 'Fresh', body: 'b' }); } },
    { name: 'research run', key: 'runs', save: (path) => { new AgentResearchRunRegistry(path).create({ title: 'Fresh', question: 'q' }); } },
    { name: 'research source', key: 'sources', save: (path) => { new AgentResearchSourceRegistry(path).create({ question: 'q', title: 'Fresh', summary: 's' }); } },
  ];

  for (const entry of cases) {
    test(`a ${entry.name} save does not erase the unreadable entry`, () => withRoot((root) => {
      const path = join(root, 'store.json');
      const unreadable = { id: 'from-a-newer-release', shape: 'unknown' };
      seed(path, JSON.stringify({ version: 1, [entry.key]: [unreadable] }));
      try { entry.save(path); } catch { /* a store may refuse the save instead; either way the entry stays */ }
      expect((JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown[]>)[entry.key]).toContainEqual(unreadable);
    }));

    test(`a ${entry.name} store written by a newer version is not rewritten`, () => withRoot((root) => {
      const path = join(root, 'store.json');
      const body = JSON.stringify({ version: 2, [entry.key]: [] });
      seed(path, body);
      expect(() => entry.save(path)).toThrow(/version 2/);
      expect(readFileSync(path, 'utf-8')).toBe(body);
    }));
  }
});

describe('research source URLs', () => {
  test('credentials in the authority and in a token fragment are removed before storage', () => withRoot((root) => {
    const registry = new AgentResearchSourceRegistry(join(root, 'sources.json'));
    const source = registry.create({
      question: 'q',
      title: 'Credentialed link',
      summary: 's',
      url: 'https://user:hunter2pass@example.test/page?x=1#access_token=abc123&section=two',
    });
    expect(source.url).not.toContain('hunter2pass');
    expect(source.url).not.toContain('user:');
    expect(source.url).not.toContain('abc123');
    expect(source.url).toContain('x=1');
    expect(readFileSync(join(root, 'sources.json'), 'utf-8')).not.toContain('hunter2pass');
  }));

  test('an ordinary section anchor is kept as written', () => withRoot((root) => {
    const registry = new AgentResearchSourceRegistry(join(root, 'sources.json'));
    const source = registry.create({ question: 'q', title: 'Anchored', summary: 's', url: 'https://example.test/doc#installation' });
    expect(source.url).toBe('https://example.test/doc#installation');
  }));

  test('a secret-looking path is refused', () => withRoot((root) => {
    const registry = new AgentResearchSourceRegistry(join(root, 'sources.json'));
    expect(() => registry.create({
      question: 'q', title: 'Leaky path', summary: 's',
      url: 'https://example.test/hooks/sk-abcdefghijklmnopqrstuvwxyz123456',
    })).toThrow(/secret-looking/);
  }));

  test('a secret value under an unremarkable query or fragment name is refused', () => withRoot((root) => {
    const registry = new AgentResearchSourceRegistry(join(root, 'sources.json'));
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    for (const url of [`https://example.test/p?key=${secret}`, `https://example.test/p?sig=${secret}`, `https://example.test/p#${secret}`]) {
      expect(() => registry.create({ question: 'q', title: 'Leaky query', summary: 's', url })).toThrow(/secret-looking/);
    }
    expect(registry.create({ question: 'q', title: 'Cleaned', summary: 's', url: 'https://example.test/p?token=abc&page=2' }).url).toContain('page=2');
  }));
});
