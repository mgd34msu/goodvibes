import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeServices } from '../../runtime/services.ts';
import { seedBenchmarkCacheFixture } from '../helpers/benchmark-cache-fixture.ts';

test('a worker write in an undecided workspace raises the trust question first, and a restricted answer refuses it without an approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-worker-trust-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  seedBenchmarkCacheFixture({ workingDirectory: root, homeDirectory: root, surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, root, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir: root, homeDirectory: root, modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  const answers = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.98);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.98);
    if (name === 'kind') return choiceAnswer(question, 'other', 0.98);
    if (name === 'category') return choiceAnswer(question, 'lasting', 0.98);
    if (name === 'hazard') return choiceAnswer(question, 'none', 0.98);
    if (question.type === 'noul') return noulAnswer(/weakens/i.test(name) ? 0.98 : 0.02);
    throw new Error(`Unscripted question: ${name}`);
  });
  spyOn(services.judgment.port, 'ask').mockImplementation((request) => answers.port.ask(request));
  let humanAsks = 0;
  let trustQuestions = 0;
  services.localPromptRef.requestPermission = async () => { humanAsks++; return { approved: false }; };
  services.trustPromptRef.requestTrustDecision = async () => { trustQuestions++; return 'restricted'; };
  try {
    expect(services.workspaceTrustManager.isDecided()).toBe(false);
    const approved = await services.permissionManager.check('write', { path: join(root, 'out.txt'), content: 'x' }).catch((error: unknown) => { return false; });
    expect(approved).toBe(false);
    expect(trustQuestions).toBe(1);
    expect(humanAsks).toBe(0);
  } finally {
    services.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('workers and the turn share one trust prompt for an undecided workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-worker-trust-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  seedBenchmarkCacheFixture({ workingDirectory: root, homeDirectory: root, surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, root, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir: root, homeDirectory: root, modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  let prompts = 0;
  const release = Promise.withResolvers<'restricted'>();
  services.trustPromptRef.requestTrustDecision = () => { prompts++; return release.promise; };
  try {
    const first = services.requestTrustDecision();
    const second = services.requestTrustDecision();
    release.resolve('restricted');
    expect(await first).toBe('restricted');
    expect(await second).toBe('restricted');
    expect(prompts).toBe(1);
  } finally {
    services.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
