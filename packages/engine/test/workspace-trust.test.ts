// Proves: In a workspace the owner has not decided or marked restricted, a change or command runs; or a trust file shipped in the checkout is honoured.
// Red when: The trust manager stops refusing a write or command in a workspace the owner marked restricted where Jev decides (no ask reaches the trust gate there), the restricted answer lets the asking write run, or the manager takes a trust.json inside the checkout as the owner's decision.
/**
 * The terminal app's composition: the real WorkspaceTrustManager over a temp
 * home and project, the trust gate as the outer ask of the real
 * PermissionManager and the trust manager as its autonomous constraint, over a
 * real settings manager. In jev-decides with a working decision model no ask
 * reaches the trust gate, so the trust manager's constraint is what refuses.
 * The decision port is scripted (readings, and act to every disposition) and
 * counts its requests; the owner's prompt and the trust question count theirs.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { trustGatedAsk, WorkspaceTrustManager, type WorkspaceTrustLevel } from '../platform/src/platform/runtime/workspace-trust.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-workspace-trust-')));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('a shipped trust.json is not honoured; answered restricted, writes and commands do not run, also where Jev decides; reads run', async () => {
  forgetGateReadings();
  const readings = gateReadingsPort();
  let jevRequests = 0;
  const disposition = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'fixture-model', ask: (request) => {
    jevRequests++;
    return request.context?.site === 'engine.gate.autonomous-tool' ? disposition.port.ask(request) : readings.port.ask(request);
  } };
  const previous = installJudgmentPort(withDecisionLog(port, log));
  try {
    const home = join(root, 'home');
    const project = join(root, 'cloned-project');
    mkdirSync(join(project, '.goodvibes', 'goodvibes'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(project, '.goodvibes', 'goodvibes', 'trust.json'), JSON.stringify({ level: 'trusted', trusted: true }));
    writeFileSync(join(project, 'README.md'), 'readme\n');

    const trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: project, homeDirectory: home }), surfaceRoot: 'goodvibes' });
    await trust.load();
    expect(trust.hasIgnoredLegacyDecision()).toBe(true);
    expect(trust.isDecided()).toBe(false);

    const config = new ConfigManager({ surfaceRoot: 'goodvibes', workingDir: project, homeDir: home, configDir: join(root, 'config'), ownsDaemonTier: true });
    const owner = { kind: 'owner', surface: 'fixture' } as const;
    expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], owner).ok).toBe(true);
    let ownerPrompts = 0;
    let trustQuestions = 0;
    const answer = async (): Promise<WorkspaceTrustLevel> => { trustQuestions++; return 'restricted'; };
    const manager = new PermissionManager(
      trustGatedAsk(trust, async () => { ownerPrompts++; return { approved: true }; }, answer),
      createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { workspaceTrust: trust });

    // Refused is a decision that does not approve, or the constraint's refusal of a restricted workspace.
    const runs = (tool: string, args: Record<string, unknown>) => manager.checkDetailed(tool, args).then((result) => result.approved,
      (error: unknown) => { if (error instanceof Error && error.message.includes('restricted workspace forbids')) return false; throw error; });
    const write = { files: [{ path: join(project, 'src.ts'), content: 'export {};\n' }] };
    const command = { commands: [{ cmd: 'npm install left-pad --save' }] };
    // Undecided, decision models off: the first write raises the one trust question; answered restricted, it does not run.
    const retire = configureDecisionModelPolicy(() => 'No Decision Model');
    try { expect(await runs('write', write)).toBe(false); } finally { retire(); }
    expect(trust.getLevel()).toBe('restricted');
    expect(trust.isDecided()).toBe(true);

    // Restricted, with Jev deciding and ready to act: writes and commands do not run and Jev is not asked; a read runs.
    expect(config.setMany([
      { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
      { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
      { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
      { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
    ], owner).ok).toBe(true);
    expect(manager.getMode()).toBe('jev-decides');
    expect(await runs('write', write)).toBe(false);
    expect(await runs('exec', command)).toBe(false);
    expect(`${trustQuestions} trust questions, ${ownerPrompts} owner prompts, ${jevRequests} Jev requests`).toBe('1 trust questions, 0 owner prompts, 0 Jev requests');
    expect(await runs('read', { files: [{ path: join(project, 'README.md') }] })).toBe(true);
  } finally {
    installJudgmentPort(previous);
    log[Symbol.dispose]();
    forgetGateReadings();
  }
});
