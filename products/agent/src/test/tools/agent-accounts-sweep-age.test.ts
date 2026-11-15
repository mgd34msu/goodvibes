import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentAccountsTool, registerAgentAccountsTool } from '../../tools/agent-accounts-tool.ts';
import { AgentAccountRegistry } from '@goodvibes-jev/engine/platform/platform/google';
import { containsSecretLikeText } from '../../agent/memory-safety.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

let home = '';
let fixture: ReturnType<typeof recordedEffectFixture>;
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;

beforeEach(() => {
  home = makeProjectTempDir('accounts-sweep-age');
  resetSessionUntrustedContentLedgerForTests();
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' || name === 'effect__kind' ? 'read' : 'generic', 0.999);
    throw new Error(`Unexpected question ${name}`);
  });
  previous = installJudgmentPort(withDecisionLog(fake.port, log));
  const options = {
    registry: new AgentAccountRegistry({ storePath: join(home, 'accounts.json'), containsSecretLikeText }),
    baseAddress: () => 'owner@example.com',
  };
  fixture = recordedEffectFixture(createAgentAccountsTool(options), 'safe-owner', {}, home);
  fixture.registry.unregister('accounts');
  registerAgentAccountsTool(fixture.registry, options);
});

afterEach(() => {
  installJudgmentPort(previous);
  log[Symbol.dispose]();
  rmSync(home, { recursive: true, force: true });
  resetSessionUntrustedContentLedgerForTests();
});

describe('accounts sweep age', () => {
  // A zero or negative age puts the cutoff at or after now, which would drop every record.
  test.each([0, -1])('maxAgeDays %p is refused before the register is touched', async (maxAgeDays) => {
    const swept = await fixture.run({ action: 'sweep', maxAgeDays });

    expect(swept.success).toBe(false);
    expect(swept.error).toContain('greater than 0');
    expect(existsSync(join(home, 'accounts.json'))).toBe(false);
  });
});
