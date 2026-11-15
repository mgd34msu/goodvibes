import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allWorkspaceActions } from '../../tools/agent-harness-workspace-actions.ts';

const TOOLS_DIR = join(import.meta.dir, '../../tools');
const ROUTE_SOURCES = [
  'agent-harness-autonomy-queue.ts',
  'agent-harness-autonomy-live-records.ts',
  'agent-harness-autonomy-intake.ts',
];

describe('autonomy routes point at workspace actions that exist', () => {
  test('every actionId a queue, live-record or intake route names resolves in the workspace action table', () => {
    const known = new Set(allWorkspaceActions().map(entry => entry.action.id));
    const missing: string[] = [];
    for (const file of ROUTE_SOURCES) {
      for (const match of readFileSync(join(TOOLS_DIR, file), 'utf8').matchAll(/actionId:\\?"([a-z0-9-]+)"/g)) {
        if (!known.has(match[1]!)) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
