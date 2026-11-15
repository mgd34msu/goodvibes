import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { WorkLedgerAncestryInput } from './helpers/work-ledger-ancestry.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const depth of [0, 1, 2]) for (const lateCloseFailure of [false, true]) {
  test(`creation retry reestablishes ancestor ${depth} durability, including replay and close-failure=${lateCloseFailure}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-ancestry-')); roots.push(root);
    let dbPath = join(root, 'first', 'second', 'third', 'knowledge.sqlite');
    let failDirectory = depth === 0 ? root : join(root, 'first');
    if (depth === 2) {
      mkdirSync(join(root, 'canonical', 'branch'), { recursive: true });
      mkdirSync(join(root, 'alias-side'));
      symlinkSync(join(root, 'canonical', 'branch'), join(root, 'alias-side', 'alias'));
      dbPath = join(root, 'alias-side', 'alias', 'first', 'second', 'third', 'knowledge.sqlite');
      failDirectory = join(root, 'canonical');
    }
    const input: WorkLedgerAncestryInput = { dbPath, failDirectory, lateCloseFailure };
    const run = spawnSync(process.execPath, [join(import.meta.dir, 'helpers/work-ledger-ancestry.ts'), JSON.stringify(input)], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(output.attempts).toEqual(['failed', 'failed', 'accepted']);
    // Both early attempts failed for the injected durability fault, not for some other reason.
    expect(output.errors).toEqual(['Injected ancestor durability failure', 'Injected ancestor durability failure']);
    // The accepted attempt re-synced every ancestor from the database directory up to and
    // including the directory whose sync had failed.
    const events = output.events as { operation: string; path?: string }[];
    const accepted = new Set(events.slice(events.findIndex(event => event.operation === 'attempt-2')).map(event => event.path));
    const chain: string[] = [];
    for (let directory = realpathSync(dirname(dbPath)); ; directory = dirname(directory)) {
      chain.push(directory);
      if (directory === failDirectory) break;
    }
    expect(chain.length).toBeGreaterThanOrEqual(3);
    for (const directory of chain) expect(accepted.has(directory), `${directory} was not synced on the accepted attempt`).toBe(true);
    expect(output.uncertainReplay).toMatchObject({ kind: 'indeterminate', requestId: 'durable' });
    expect(output.replay).toMatchObject({ kind: 'accepted', replayed: true });
    expect(output.historyLength).toBe(1);
    expect(output.unchanged).toBe(true);
  });
}
