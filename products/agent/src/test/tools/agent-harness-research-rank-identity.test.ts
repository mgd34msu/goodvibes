import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withNativeCatalog, rankResearchRecords } from '../../tools/agent-harness-research-catalog-source.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); previous = undefined; });

interface Row { readonly id: string; readonly title: string }

async function rankWith(rows: readonly Row[], wanted: (candidateName: string) => number): Promise<readonly Row[]> {
  const root = makeProjectTempDir('research-rank-identity'), path = join(root, 'records.json');
  writeFileSync(path, JSON.stringify({ rows }));
  const screening = researchScreeningFixture();
  const port = fakePort((name, _question, state) => {
    const candidate = state && typeof state === 'object' && 'candidate' in state && state.candidate && typeof state.candidate === 'object' ? state.candidate : undefined;
    const candidateName = candidate && 'name' in candidate && typeof candidate.name === 'string' ? candidate.name : '';
    if (name !== 'match' || !candidateName) throw new Error('Unexpected request');
    return noulAnswer(wanted(candidateName));
  });
  installJudgmentPort(port.port);
  const log = new SqliteDecisionLog(':memory:');
  const original = installJudgmentPort(withDecisionLog(judgmentPort('agent.research.rank-identity'), log));
  try {
    return await withNativeCatalog({ query: 'seawater' }, { sourceOwner: screening.owner }, [path], () => rows,
      (_args, current, options) => rankResearchRecords(current, 'seawater', row => ({ id: row.id, description: row.title, evidence: row }), options, 'agent.research.rank-identity'));
  } finally { installJudgmentPort(original); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); }
}

describe('ranking records that share an id', () => {
  test('the match is the record that was read, not the first one with the same id', async () => {
    const rows = [{ id: 'dup', title: 'Ocean boiler' }, { id: 'dup', title: 'Seawater study' }];
    const selected = await rankWith(rows, candidateName => candidateName.endsWith('#1') ? 0.99 : 0.01);
    expect(selected).toEqual([rows[1]]);
  });

  test('records with no id are told apart by position', async () => {
    const rows = [{ id: '', title: 'Ocean boiler' }, { id: '', title: 'Seawater study' }];
    const selected = await rankWith(rows, candidateName => candidateName === 'item#1' ? 0.99 : 0.01);
    expect(selected).toEqual([rows[1]]);
  });

  test('a unique id keeps its own name', async () => {
    const rows = [{ id: 'a', title: 'Ocean boiler' }, { id: 'b', title: 'Seawater study' }];
    const selected = await rankWith(rows, candidateName => candidateName === 'b' ? 0.99 : 0.01);
    expect(selected).toEqual([rows[1]]);
  });
});
