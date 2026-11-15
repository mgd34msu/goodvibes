import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURED_BUN_RUNTIME_VERSION } from '@goodvibes-jev/engine/toolchain';
import { daemonSqliteRuntime } from '../../cli/native-sqlite-runtime.ts';

interface TargetRow { readonly key: string; readonly capturedBunRuntime?: string; readonly sqliteRuntime?: Record<string, unknown> }
const config = JSON.parse(readFileSync(join(import.meta.dir, '../../../toolchain.config.json'), 'utf8')) as { build: { targets: TargetRow[] } };

test('the declared SQLite pin of each Darwin target is the one the runtime and producer use', () => {
  for (const row of config.build.targets.filter((target) => target.key.startsWith('darwin-'))) {
    const runtime = daemonSqliteRuntime('darwin', row.key.slice('darwin-'.length));
    expect(runtime).not.toBeNull();
    const { target, ...declared } = runtime!;
    expect<string>(target).toBe(row.key);
    expect(row.sqliteRuntime, `${row.key} SQLite declaration`).toEqual(declared);
  }
});

test('every Linux target declares the Bun version the toolchain captures', () => {
  for (const row of config.build.targets.filter((target) => target.key.startsWith('linux-'))) {
    expect(row.capturedBunRuntime, `${row.key} captured Bun`).toBe(CAPTURED_BUN_RUNTIME_VERSION);
  }
});
