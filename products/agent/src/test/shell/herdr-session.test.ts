import { expect, test } from 'bun:test';
import { createHerdrSessionReporter } from '@goodvibes-jev/engine/terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager, InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { buildAgentHerdrSessionUpdate } from '../../shell/herdr-session.ts';
import { settleInteractiveExit } from '../../shell/exit-completion.ts';

test('native Agent lifecycle reports busy, actual owner questions, and resumed session identity without prompt contents', async () => {
  const calls: string[][] = [];
  const reporter = createHerdrSessionReporter({ environment: { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p3', HERDR_BIN_PATH: '/fixture/herdr', HERDR_SOCKET_PATH: '/fixture/herdr.sock' }, transport: async argv => { calls.push([...argv]); if (argv[0] === '--version') return 'herdr 0.9.3'; } });
  const runtime = { sessionId: 'Session Original' };
  const orchestrator = { isThinking: false, isBusy: false };
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => new InfiniteBuffer(), () => {}, () => {}, (await createDefaultUiRuntimeServices()));
  const snapshot = () => buildAgentHerdrSessionUpdate({ runtime, orchestrator, input, surface: { sessionsDir: '/owned/agent/sessions' }, workingDir: '/owned/project with spaces' });
  await reporter.update(snapshot());
  orchestrator.isThinking = true;
  await reporter.update(snapshot());
  input.selectionModal.open('Private owner question', [{ id: 'yes', label: 'Private answer' }]);
  input.selectionCallback = () => {};
  await reporter.update(snapshot());
  input.selectionModal.close(); input.selectionCallback = null;
  await reporter.update(snapshot());
  orchestrator.isThinking = false;
  runtime.sessionId = 'resumed-id';
  await reporter.update(snapshot());
  expect(snapshot().resumeArgv).toEqual(['goodvibes-agent', '--working-dir', '/owned/project with spaces', '--resume', 'resumed-id']);
  expect(snapshot().sessionPath).toBe('/owned/agent/sessions/resumed-id.jsonl');
  await reporter.close();
  const reports = calls.filter(argv => argv[1] === 'report-agent');
  expect(reports.map(argv => argv[argv.indexOf('--state') + 1])).toEqual(['idle', 'working', 'blocked', 'working', 'idle']);
  expect(reports.at(-1)).toContain('--agent-session-id=resumed-id');
  expect(reports.at(-1)).toContain('--agent-session-path=/owned/agent/sessions/resumed-id.jsonl');
  expect(JSON.stringify(calls)).not.toContain('Private');
});

test('recovery, daemon repair, and line requests report explicit waiting while unrelated picker navigation does not', async () => {
  const base = { runtime: { sessionId: 'id' }, orchestrator: { isThinking: true, isBusy: false }, surface: { sessionsDir: '/sessions' }, workingDir: '/project' };
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => new InfiniteBuffer(), () => {}, () => {}, (await createDefaultUiRuntimeServices()));
  expect(buildAgentHerdrSessionUpdate({ ...base, orchestrator: { isThinking: false, isBusy: true } }).busy).toBe(true);
  input.selectionModal.open('Ordinary picker', []);
  expect(buildAgentHerdrSessionUpdate({ ...base, input }).waitingForOwner).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, recoveryPending: 'recover-id' }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, pendingPermission: { callId: 'call', tool: 'exec', args: { command: 'Private command' }, category: 'execute', analysis: { classification: 'dangerous', riskLevel: 'high', summary: 'Private risk', reasons: [] }, resolve() {} } }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, daemonRepairPrompt: { pending: () => true } }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, daemonRepairPrompt: { pending: () => false } }).waitingForOwner).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'awaiting-owner', groups: [], units: [] }] }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'running', groups: [], units: [] }] }).waitingForOwner).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'running', groups: [{ status: 'awaiting-owner' }], units: [] }] }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'running', groups: [], units: [{ status: 'awaiting-owner' }] }] }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, setupPairing: { waitingForOwner: true } }).waitingForOwner).toBe(true);
  input.concealedInput = { label: 'Private credential', onSubmit() {} };
  expect(buildAgentHerdrSessionUpdate({ ...base, input }).waitingForOwner).toBe(true);
  input.concealedInput = null; input.plainLineInput = { onSubmit() {} };
  expect(buildAgentHerdrSessionUpdate({ ...base, input }).waitingForOwner).toBe(true);
});

test('exit waits for native session release even when runtime and audio have settled, and late paints cannot reclaim it', async () => {
  const release = Promise.withResolvers<void>();
  const releaseStarted = Promise.withResolvers<void>();
  const calls: string[][] = [];
  const reporter = createHerdrSessionReporter({ environment: { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p3', HERDR_BIN_PATH: '/fixture/herdr', HERDR_SOCKET_PATH: '/fixture/herdr.sock' }, transport: async argv => {
    calls.push([...argv]);
    if (argv[0] === '--version') return 'herdr 0.9.3';
    if (argv[1] === 'release-agent' && argv[argv.indexOf('--source') + 1] === 'goodvibes') { releaseStarted.resolve(); await release.promise; }
  } });
  const state = buildAgentHerdrSessionUpdate({ runtime: { sessionId: 'id' }, surface: { sessionsDir: '/sessions' }, orchestrator: { isThinking: false, isBusy: false }, workingDir: '/project' });
  await reporter.update(state);
  let exited = false;
  const completion = settleInteractiveExit(Promise.resolve(), Promise.resolve(), reporter.close()).then(() => { exited = true; });
  await releaseStarted.promise;
  await reporter.update({ ...state, busy: true });
  expect(exited).toBe(false);
  release.resolve(); await completion;
  expect(exited).toBe(true);
  expect(calls.at(-1)?.[1]).toBe('release-agent');
  expect(calls.filter(argv => argv[1] === 'report-agent')).toHaveLength(1);
});


test('only current-session agent work, active contracts, and actual hooks keep an otherwise idle Agent busy', () => {
  const base = { runtime: { sessionId: 'id' }, orchestrator: { isThinking: false, isBusy: false }, surface: { sessionsDir: '/sessions' }, workingDir: '/project' };
  expect(buildAgentHerdrSessionUpdate(base).busy).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, hookDispatcher: { activeInvocationCount: 1 } }).busy).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'running', groups: [], units: [] }] }).busy).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, contracts: [{ status: 'passed', groups: [], units: [] }] }).busy).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, fleetNodes: [{ kind: 'agent', state: 'queued', sessionRef: { sessionId: 'id' } }] }).busy).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, fleetNodes: [{ kind: 'agent', state: 'thinking', sessionRef: { sessionId: 'other-session' } }] }).busy).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, fleetNodes: [{ kind: 'agent', state: 'done', sessionRef: { sessionId: 'id' } }] }).busy).toBe(false);
  expect(buildAgentHerdrSessionUpdate({ ...base, fleetNodes: [{ kind: 'agent', state: 'awaiting-approval', sessionRef: { sessionId: 'id' } }] }).waitingForOwner).toBe(true);
  expect(buildAgentHerdrSessionUpdate({ ...base, fleetNodes: [{ kind: 'agent', state: 'awaiting-approval', sessionRef: { sessionId: 'other' } }] }).waitingForOwner).toBe(false);
});

test('native owner wait follows concrete settings, deletion, and custom modal questions, and clears after dismissal', async () => {
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => new InfiniteBuffer(), () => {}, () => {}, (await createDefaultUiRuntimeServices()));
  expect(input.waitingForOwner).toBe(false);
  input.settingsModal.active = true;
  expect(input.waitingForOwner).toBe(false);
  input.settingsModal.mcpAllowAllConfirmationTarget = 'server';
  expect(input.waitingForOwner).toBe(true);
  input.settingsModal.mcpAllowAllConfirmationTarget = null;
  input.settingsModal.subscriptionLogoutConfirmationTarget = 'provider';
  expect(input.waitingForOwner).toBe(true);
  input.settingsModal.active = false;
  expect(input.waitingForOwner).toBe(false);
  input.sessionPickerModal.active = true; input.sessionPickerModal.deleteConfirmationTarget = 'saved';
  expect(input.waitingForOwner).toBe(true);
  input.sessionPickerModal.close();
  expect(input.waitingForOwner).toBe(false);
  input.profilePickerModal.active = true; input.profilePickerModal.deleteConfirmationTarget = 'profile';
  expect(input.waitingForOwner).toBe(true);
  input.profilePickerModal.close();
  expect(input.waitingForOwner).toBe(false);
  input.surfaceModals.push({ name: 'unrelated-browser', handleToken() {}, render: () => { throw new Error('No paint in owner-state test'); } });
  expect(input.waitingForOwner).toBe(false);
  input.surfaceModals.push({ name: 'actual-owner-question', waitingForOwner: true, handleToken() {}, render: () => { throw new Error('No paint in owner-state test'); } });
  expect(input.waitingForOwner).toBe(true);
  input.surfaceModals.clear();
  expect(input.waitingForOwner).toBe(false);
});
