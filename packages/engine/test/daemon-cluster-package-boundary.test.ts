import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clusterPackageImportProblems } from '../scripts/daemon-architecture-check.ts';

function fixture(run: (put: (path: string, body: string) => void, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'daemon-cluster-boundary-'));
  const put = (path: string, body: string): void => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  try {
    put('packages/engine/terminal-shell/src/daemon-ws-call.ts', 'export async function callDaemonWsVerb(): Promise<void> {}\nexport interface DaemonWebSocket {}\n');
    put('packages/engine/terminal-shell/src/raw-reply-route.ts', 'export function callDaemonRoute(): void {}\n');
    run(put, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a config file importing a cluster reader through the package specifier is a violation', () => fixture((put, root) => {
  put('products/daemon/src/config/value.ts', "import { callDaemonRoute } from '@goodvibes-jev/engine/terminal-shell';\nexport const x = callDaemonRoute;\n");
  const problems = clusterPackageImportProblems(root);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('layer config');
  expect(problems[0]).toContain('callDaemonRoute');
}));

test('type-only imports, unrelated names and allowed layers are not violations', () => fixture((put, root) => {
  put('products/daemon/src/core/value.ts', "import type { DaemonWebSocket } from '@goodvibes-jev/engine/terminal-shell';\nimport { somethingElse } from '@goodvibes-jev/engine/terminal-shell';\nexport { somethingElse };\n");
  put('products/daemon/src/cli/parser.ts', "import { callDaemonWsVerb } from '@goodvibes-jev/engine/terminal-shell';\nexport { callDaemonWsVerb };\n");
  put('products/daemon/src/config/other.ts', "import { type callDaemonRoute } from '@goodvibes-jev/engine/terminal-shell';\nexport {};\n");
  expect(clusterPackageImportProblems(root)).toEqual([]);
}));
