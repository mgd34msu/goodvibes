/** Real adapter to synthetic HTTP fixture; authored UNRUN during coding. */
import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { Questions } from '@goodvibes-jev/judgment';
import { bindVerificationTargets } from '../sdk/src/platform/core/verification/targets.js';
import { startE2EJudgments } from '../../../products/agent/src/test/e2e/judgment-fixture.js';
import recorded from '../../../products/agent/src/test/fixtures/e2e-judgments/headless-completion.json';

test('Agent E2E endpoint accepts the actual native text target adapter without obsolete digest fields', async () => {
  const server = startE2EJudgments(), fake = fakePort(() => noulAnswer(0.01));
  server.expectTextOnlyCompletion(recorded.state.request, recorded.state.response);
  const questions: Questions = Object.fromEntries(Object.entries(recorded.questions).map(([name, value]) => [name,
    { type: 'noul' as const, instructions: value.instructions.question }]));
  const ask = (body: unknown) => fetch(`${server.baseURL}/v1/systemone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await bindVerificationTargets(fake.port).ask({ model: recorded.model, questions, state: recorded.state });
    expect(fake.requests).toHaveLength(1);
    expect((await ask(fake.requests[0])).status).toBe(200);
    expect((await ask(recorded)).status).toBe(422);
    expect(recorded.questions.false_blocker.instructions.nativeTargets.proposedAnswer).toHaveProperty('digest');
  } finally { server.stop(); }
});
