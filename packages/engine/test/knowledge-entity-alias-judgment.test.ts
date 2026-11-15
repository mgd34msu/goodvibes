import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readKnowledgeEntityAliases } from '../platform/src/platform/knowledge/entity-aliases.js';
import { entityAlias } from '../platform/src/platform/knowledge/batteries/entity-alias.js';
import { registry } from '../platform/src/platform/knowledge/aliases/judgment-registry.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

type AliasState = { entity: { title: string }; candidates: string[]; evidence: string };

describe('knowledge entity alias readings', () => {
  test('registers fixtures for every candidate slot', async () => {
    expect(registry.get(entityAlias.name)).toBe(entityAlias);
    const fake = fakePort((name, _question, state) => {
      const fixture = entityAlias.fixtures.find((entry) => JSON.stringify(entry.state) === JSON.stringify(state));
      return noulAnswer((fixture?.expect as Record<string, string> | undefined)?.[name] === 'yes' ? 0.99 : 0.01);
    });
    const checks = await entityAlias.checkFixtures(fake.port);
    expect(checks.every((check) => check.correct)).toBe(true);
  });

  test('at most one request per tagged entity, whatever the document length; none without a stated name', async () => {
    const fake = fakePort((name, _question, state) => {
      const { candidates } = state as AliasState;
      return noulAnswer(candidates[Number(name.slice(1)) - 1] === 'AR' ? 0.99 : 0.01);
    });
    installJudgmentPort(fake.port);
    const words = Array.from({ length: 3_000 }, (_, index) => `word${index}`).join(' ');
    const aliases = await readKnowledgeEntityAliases(
      [{ kind: 'project', title: 'Aurora Runtime' }, { kind: 'project', title: 'Borealis' }],
      { title: 'Notes', summary: `Aurora Runtime (AR) ships weekly. ${words}`, extractionSummary: '', sections: ['Borealis is a separate project.'] },
    );
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.state as AliasState).candidates).toContain('AR');
    expect(aliases).toEqual([['AR'], []]);
  });

  test('an entity whose reading does not settle keeps no inferred alias; the others keep theirs', async () => {
    const fake = fakePort((_name, _question, state) => noulAnswer((state as AliasState).entity.title === 'Aurora Runtime' ? 0.99 : 0.5));
    installJudgmentPort(fake.port);
    const aliases = await readKnowledgeEntityAliases(
      [{ kind: 'project', title: 'Aurora Runtime' }, { kind: 'project', title: 'Borealis' }],
      { title: '', summary: 'Aurora Runtime (AR) and Borealis (BX) are both maintained here.', extractionSummary: '', sections: [] },
    );
    expect(fake.requests).toHaveLength(2);
    expect(aliases).toEqual([['AR'], []]);
  });
});
