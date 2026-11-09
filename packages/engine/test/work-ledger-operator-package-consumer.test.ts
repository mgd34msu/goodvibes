import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the ledger operator adapter resolves from its separate Bun package subpath', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures/work-ledger-operator-consumer.mjs')], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain('PASS work-ledger operator public consumer');
});

test('local ledger and operator platform barrels do not pull in the remote ledger adapter', () => {
  const local = readFileSync(join(import.meta.dir, '../platform/src/platform/workflow/work-ledger/index.ts'), 'utf8');
  const operator = readFileSync(join(import.meta.dir, '../operator-client/src/index.ts'), 'utf8');
  expect(local).not.toContain('operator-read-client');
  expect(operator).not.toContain('work-ledger-read-client');
  expect(operator).not.toContain('createOperatorWorkLedgerReadClient');
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
    exports: Record<string, { bun?: string; types?: string; import?: string }>;
  };
  expect(manifest.exports['./platform/platform/workflow/work-ledger/operator-read-client']).toEqual({
    bun: './platform/src/platform/workflow/work-ledger/operator-read-client.ts',
    types: './platform/dist/platform/workflow/work-ledger/operator-read-client.d.ts',
    import: './platform/dist/platform/workflow/work-ledger/operator-read-client.js',
  });
});
