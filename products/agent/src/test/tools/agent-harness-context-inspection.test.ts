import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { makeFixture, executeHarnessJson, createHarnessFixtureReadings } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);

let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
  fixtureLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
});
afterEach(() => { installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });

describe('prompt context inspection', () => {
  test('the advertised segment order names exactly the segments that are returned', async () => {
    const fixture = makeFixture();
    try {
      const result = await executeHarnessJson<{ readonly order: readonly string[]; readonly segments: readonly { readonly id: string; readonly order: number }[] }>(fixture, { mode: 'prompt_context' });
      expect(result.order).toEqual(result.segments.map(segment => segment.id));
      expect(result.order).not.toContain('operator_policy');
      expect(result.segments.map(segment => segment.order)).toEqual([...result.segments.map(segment => segment.order)].sort((a, b) => a - b));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('project context file lookup', () => {
  test('a query names the file even when target points discovery at a directory', async () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture.root, 'sub'));
      writeFileSync(join(fixture.root, 'AGENTS.md'), '# Root instructions\nUse bun.\n');
      const listing = await executeHarnessJson<{ readonly files: readonly { readonly id: string }[] }>(fixture, { mode: 'project_context', target: 'sub' });
      const id = listing.files[0]?.id;
      if (!id) throw new Error('Expected a discovered project context file');
      const found = await executeHarnessJson<{ readonly id: string }>(fixture, { mode: 'project_context_file', query: id, target: 'sub' });
      expect(found.id).toBe(id);
    } finally {
      await fixture.cleanup();
    }
  });
});
