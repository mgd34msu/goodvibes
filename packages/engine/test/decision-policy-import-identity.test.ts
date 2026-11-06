import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('source and published policy entrypoints share Classic, Preferred fallback, refusal memory and revocation identity', async () => {
  // Keep the deliberately mixed imports inside a child so this regression does
  // not change the parent suite's installed observer or configuration source.
  const source = resolve(import.meta.dir, '../sdk/src/platform/runtime/decision-policy.ts');
  const built = resolve(import.meta.dir, '../sdk/dist/platform/runtime/decision-policy.js');
  const script = `
    import { strict as assert } from 'node:assert';
    import { JudgmentError } from '@goodvibes-jev/judgment';
    const source = await import(${JSON.stringify(source)});
    const built = await import(${JSON.stringify(built)});
    let decisions = 0;
    await source.withDecisionModelPolicy(() => 'Classic - Off', async () => {
      assert.equal(built.isClassicOperation(), true);
      assert.equal(await built.decisionOrClassic(async () => { decisions++; return 'decision'; }, () => 'classic'), 'classic');
      source.rememberDecisionRefusal('bound-refusal');
      assert.equal(built.wasDecisionRefused('bound-refusal'), true);
    });
    assert.equal(decisions, 0);
    await built.withDecisionModelPolicy(() => 'Preferred', async () => {
      assert.equal(await source.decisionOrClassic(async () => { decisions++; throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }, () => 'classic'), 'classic');
      assert.equal(built.isClassicOperation(), true);
      assert.equal(await built.decisionOrClassic(async () => { decisions++; return 'decision'; }, () => 'classic'), 'classic');
    });
    assert.equal(decisions, 1);
    let policy = 'Classic - Off';
    await source.withDecisionModelPolicy(() => policy, async () => {
      policy = 'Default - On';
      assert.throws(() => built.isClassicOperation(), error => error instanceof source.DecisionModelPolicyChangedError && error instanceof built.DecisionModelPolicyChangedError);
    });
    policy = 'Classic - Off';
    const retire = source.configureDecisionModelPolicy(() => policy);
    try { await built.withConfiguredDecisionModelPolicy(async () => assert.equal(built.isClassicOperation(), true)); }
    finally { retire(); }
    assert.equal(source.isClassicOperation(), false);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
