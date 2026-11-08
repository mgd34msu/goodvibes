import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableContractAdmissions, durableKeyHash, durablePayloadRevision, freezeDurableRequest,
  type DurableContractAdmission, type DurableContractKey } from '../../sdk/src/platform/contract/durable-admission.js';
import { makeProjectTempDir } from '../_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = makeProjectTempDir('gv-admission-index'); roots.push(root);
  const directory = join(root, '.goodvibes', 'contracts', 'admissions');
  const make = (attemptId = 'attempt-a', contractId = 'ctr-1234abcd'): DurableContractAdmission => {
    const request = freezeDurableRequest({
      key: { workId: 'work', criteriaId: 'criteria', criteriaRevision: 'revision', attemptId },
      binding: { sourceId: 'source', inputRevision: 'input', actionId: 'action', actionRevision: 'revision',
        authorityId: 'owner', authorityRevision: 'owner-revision', scopeId: 'scope', scopeRevision: 'scope-revision' },
      input: { ask: 'Prepare the requested module', sessionId: 'session', origin: 'turn', projectRoot: root, isolation: 'shared' },
    });
    return { ...request, schemaVersion: 1, contractId, ownerAgentId: 'owner', payloadRevision: durablePayloadRevision(request) };
  };
  return { root, directory, make, store: new DurableContractAdmissions(root),
    path: (key: DurableContractKey) => join(directory, `${durableKeyHash(key)}.json`),
    index: (id: string) => join(directory, '.by-contract', `${id}.json`) };
}

describe('durable admission reverse identity', () => {
  test('a committed target resolves without parsing an unrelated damaged receipt', () => {
    const f = fixture(), admission = f.make();
    f.store.write(admission, 'original checkpoint');
    writeFileSync(join(f.directory, `${'0'.repeat(64)}.json`), '{');
    const reopened = new DurableContractAdmissions(f.root);
    expect(reopened.findByContractId(admission.contractId)).toEqual(admission);
    expect(reopened.checkpoint(admission.key)).toBe('original checkpoint');
    expect(() => reopened.findByContractId('ctr-ffffffff')).toThrow('invalid');
  });

  test('a target index never substitutes for its missing or damaged authoritative receipt', () => {
    for (const damage of ['missing', 'corrupt'] as const) {
      const f = fixture(), admission = f.make(); f.store.write(admission, 'checkpoint');
      if (damage === 'missing') unlinkSync(f.path(admission.key)); else writeFileSync(f.path(admission.key), '{');
      expect(() => new DurableContractAdmissions(f.root).findByContractId(admission.contractId)).toThrow('invalid');
      expect(existsSync(f.index(admission.contractId))).toBe(true);
    }
  });

  test('a corrupt index refuses rather than scanning around the original target fence', () => {
    const f = fixture(), admission = f.make(); f.store.write(admission, 'checkpoint');
    writeFileSync(f.index(admission.contractId), '{');
    expect(() => f.store.findByContractId(admission.contractId)).toThrow('invalid');
    expect(() => f.store.read(admission.key)).toThrow('invalid');
  });

  test('a second key cannot claim the contract ID or leave a conflicting forward receipt', () => {
    const f = fixture(), first = f.make(), second = f.make('attempt-b');
    f.store.write(first, 'first checkpoint');
    expect(() => new DurableContractAdmissions(f.root).write(second, 'second checkpoint')).toThrow('conflict');
    expect(existsSync(f.path(second.key))).toBe(false);
    expect(f.store.findByContractId(first.contractId)).toEqual(first);
  });

  test('checkpoint updates retain the immutable small index and actual newest checkpoint', () => {
    const f = fixture(), admission = f.make(); f.store.write(admission, 'first checkpoint');
    const pointer = readFileSync(f.index(admission.contractId), 'utf-8');
    f.store.update(admission, 'next checkpoint with private captured work');
    expect(readFileSync(f.index(admission.contractId), 'utf-8')).toBe(pointer);
    expect(pointer).not.toContain('checkpoint'); expect(pointer).not.toContain(admission.input.ask);
    expect(new DurableContractAdmissions(f.root).checkpoint(admission.key)).toBe('next checkpoint with private captured work');
  });

  test('a validated older receipt acquires an index without rewriting its envelope', () => {
    const f = fixture(), admission = f.make(); mkdirSync(f.directory, { recursive: true });
    const original = JSON.stringify({ admission, checkpoint: 'older checkpoint' });
    writeFileSync(f.path(admission.key), original);
    expect(f.store.findByContractId(admission.contractId)).toEqual(admission);
    expect(readFileSync(f.path(admission.key), 'utf-8')).toBe(original);
    writeFileSync(join(f.directory, `${'0'.repeat(64)}.json`), '{');
    expect(new DurableContractAdmissions(f.root).findByContractId(admission.contractId)).toEqual(admission);
  });

  test('a new key cannot steal an older unindexed contract ID', () => {
    const f = fixture(), original = f.make(); mkdirSync(f.directory, { recursive: true });
    const envelope = JSON.stringify({ admission: original, checkpoint: 'older original checkpoint' });
    writeFileSync(f.path(original.key), envelope);
    const replacement = f.make('replacement-attempt');
    expect(() => f.store.write(replacement, 'replacement')).toThrow('conflict');
    expect(existsSync(f.path(replacement.key))).toBe(false);
    expect(existsSync(f.index(original.contractId))).toBe(false);
    expect(readFileSync(f.path(original.key), 'utf-8')).toBe(envelope);
    expect(f.store.read(original.key)).toEqual(original);
  });

  test('an interrupted index reservation without its forward receipt remains fenced', () => {
    const f = fixture(), admission = f.make();
    // Exact on-disk state after the durable reverse reservation and before
    // the forward envelope publication. This pointer is never a checkpoint.
    mkdirSync(join(f.directory, '.by-contract'), { recursive: true });
    writeFileSync(f.index(admission.contractId), JSON.stringify({ schemaVersion: 1, contractId: admission.contractId, key: admission.key }));
    expect(() => f.store.findByContractId(admission.contractId)).toThrow('invalid');
    expect(() => f.store.write(f.make('different-attempt'), 'replacement')).toThrow('conflict');
    f.store.write(admission, 'checkpoint');
    expect(f.store.findByContractId(admission.contractId)).toEqual(admission);
  });

  test('a crash-retained publication hard link cannot hide the valid reverse identity', () => {
    const f = fixture(), admission = f.make(); f.store.write(admission, 'checkpoint');
    const candidate = `${f.index(admission.contractId)}.tmp-interrupted`;
    linkSync(f.index(admission.contractId), candidate);
    expect(new DurableContractAdmissions(f.root).findByContractId(admission.contractId)).toEqual(admission);
  });

  test('dangling forward and index symlinks are unreadable authority, never absent authority', () => {
    const f = fixture(), admission = f.make(); mkdirSync(f.directory, { recursive: true });
    symlinkSync(join(f.root, 'missing'), f.path(admission.key));
    expect(() => f.store.read(admission.key)).toThrow('invalid');
    unlinkSync(f.path(admission.key));
    mkdirSync(join(f.directory, '.by-contract')); symlinkSync(join(f.root, 'missing-index'), f.index(admission.contractId));
    expect(() => f.store.findByContractId(admission.contractId)).toThrow('invalid');
  });

  test('independent processes racing different keys publish exactly one contract-ID owner', async () => {
    const f = fixture(), admissions = [f.make('race-a'), f.make('race-b')];
    const module = fileURLToPath(new URL('../../sdk/src/platform/contract/durable-admission.ts', import.meta.url));
    const children = admissions.map(admission => {
      const code = `import { DurableContractAdmissions } from ${JSON.stringify(module)};
        const start = new Promise(resolve => process.stdin.once('data', resolve));
        process.stdout.write('ready\\n'); await start;
        try { new DurableContractAdmissions(${JSON.stringify(f.root)}).write(${JSON.stringify(admission)}, 'checkpoint');
          process.stdout.write(JSON.stringify({ state: 'committed' }) + '\\n'); }
        catch(error) { process.stdout.write(JSON.stringify({ state: error.code ?? 'failed' }) + '\\n'); }
        process.stdin.pause();`;
      return Bun.spawn([process.execPath, '-e', code], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    });
    const readers = children.map(child => child.stdout.getReader());
    const errors = children.map(child => new Response(child.stderr).text());
    const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill(); }, 10_000);
    try {
      await Promise.all(readers.map(async reader => {
        let line = '';
        const decoder = new TextDecoder();
        while (!line.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw new Error('Admission peer stopped before readiness');
          line += decoder.decode(next.value, { stream: true });
        }
        expect(line).toBe('ready\n');
      }));
      for (const child of children) { child.stdin.write('start\n'); child.stdin.end(); }
      const output = await Promise.all(readers.map(async reader => {
        let text = '';
        const decoder = new TextDecoder();
        for (;;) {
          const next = await reader.read();
          if (next.done) return text + decoder.decode();
          text += decoder.decode(next.value, { stream: true });
        }
      }));
      expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
      expect(await Promise.all(errors)).toEqual(['', '']);
      const states = output.map(text => (JSON.parse(text) as { state: string }).state);
      expect([...states].sort()).toEqual(['committed', 'conflict']);
      const winner = states.indexOf('committed'), loser = winner === 0 ? 1 : 0;
      expect(f.store.findByContractId(admissions[winner]!.contractId)).toEqual(admissions[winner]);
      expect(f.store.read(admissions[loser]!.key)).toBeNull();
    } finally {
      clearTimeout(deadline);
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled([...children.map(child => child.exited), ...readers.map(reader => reader.cancel()), ...errors]);
    }
  }, 20_000);
});
