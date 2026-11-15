import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { AGENT_HARNESS_MODES, AGENT_HARNESS_PARAMETER_PROPERTIES } from '../../tools/agent-harness-tool-schema.ts';
import { BROWSER_COCKPIT_EXPECTED_LANES } from '../../tools/agent-harness-browser-cockpit-route.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { sudoExecutionPosture } from '../../tools/agent-harness-sudo-posture.ts';
import { ignoredSetupSmokeEvidenceFields, latestSetupSmokeEvidence, redactSetupSmokeEvidence, setupSmokeEvidenceMarkdown } from '../../tools/agent-harness-setup-smoke.ts';
import { listEveryArtifact } from '../../tools/agent-harness-setup-posture-utils.ts';
import { connectedHostAuthNeedsVerificationOnly, connectedHostBootstrapPlan, connectedHostServiceProbe } from '../../tools/agent-harness-setup-connected-host.ts';
import { primarySetupRepairDecision } from '../../tools/agent-harness-setup-describe.ts';
import type { SetupConnectedHostAuthPosture, SetupPlanItem } from '../../tools/agent-harness-setup-posture-types.ts';
import { effectOutput, homeRelativePath, nestedToolOutput } from '../../tools/agent-harness-tool-utils.ts';
import { describeLane as describeDocumentOpsLane, describeReviewPacketWizardStep } from '../../tools/agent-harness-document-ops.ts';
import { describeQueueItem as describePersonalOpsQueueItem } from '../../tools/agent-harness-personal-ops.ts';
import { executeHarnessJson, makeFixture, createHarnessFixtureReadings, type HarnessFixture } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);

let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
  resetAgentMcpCallRouteForTests();
  fixtureLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
});
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });

async function run(fixture: HarnessFixture, args: Record<string, unknown>) {
  const result = await fixture.admittedTool.execute(args);
  const body = result.output ? JSON.parse(result.output) as Record<string, unknown> : {};
  return { result, body };
}

describe('a refused or failed effect is not reported as success', () => {
  test.each(['not_applied', 'unsupported_keybinding_action', 'not_pasted', 'not_opened', 'ambiguous', 'missing_lookup', 'reading-held'])(
    'an effect handler answering %s is a failed result that keeps its body', (status) => {
      const result = effectOutput({ status, reason: 'nothing happened', candidates: [] });
      expect(result.success).toBe(false);
      expect(JSON.parse(result.output).status).toBe(status);
      expect(result.error).toContain(status);
    });

  test('an ambiguous effect request says nothing was done and how to disambiguate', () => {
    const result = effectOutput({ status: 'ambiguous', input: 'x', candidates: [{ id: 'a' }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing was done');
  });

  test('a real no-op stays a success', () => {
    expect(effectOutput({ status: 'nothing_to_dismiss' }).success).toBe(true);
  });

  test('a failed nested model tool makes the workspace action fail and keeps its body', async () => {
    const fixture = makeFixture();
    try {
      const nested = spyOn(fixture.toolRegistry, 'executeNested').mockResolvedValue({ success: false, error: 'export target exists' } as never);
      const { result, body } = await run(fixture, {
        mode: 'run_workspace_action', actionId: 'document-browse-artifacts', confirm: true, explicitUserRequest: 'Browse artifacts.',
      });
      expect(nested).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('export target exists');
      expect(body.status).toBe('model_tool_failed');
    } finally { await fixture.cleanup(); }
  });

  test('a successful nested model tool still succeeds', () => {
    const ok = nestedToolOutput({ success: true }, { tool: 'agent_artifacts', output: 'x', error: null });
    expect(ok.success).toBe(true);
    expect(JSON.parse(ok.output).status).toBe('executed_model_tool');
  });

  test('saving a checkpoint for an unknown step reports that nothing was written, in both routes', async () => {
    const fixture = makeFixture();
    try {
      const direct = await run(fixture, { mode: 'mark_setup_checkpoint', setupItemId: 'no-such-step', confirm: true, explicitUserRequest: 'Keep my place.' });
      expect(direct.result.success).toBe(false);
      expect(direct.body.status).toBe('no_checkpoint_written');

      const viaWorkspace = await run(fixture, {
        mode: 'run_workspace_action', actionId: 'setup-checkpoint-mark-current', setupItemId: 'no-such-step', confirm: true, explicitUserRequest: 'Keep my place.',
      });
      expect(viaWorkspace.result.success).toBe(false);
      expect(viaWorkspace.body.status).toBe('no_checkpoint_written');
      expect((viaWorkspace.body.result as { status: string }).status).toBe('no_checkpoint_written');
    } finally { await fixture.cleanup(); }
  });

  test('a blocked background sudo start is a failed result carrying the blocked body', async () => {
    const fixture = makeFixture();
    try {
      const { result, body } = await run(fixture, {
        mode: 'run_background_process', processAction: 'start', command: 'sudo true', confirm: true, explicitUserRequest: 'Try sudo.',
      });
      expect(result.success).toBe(false);
      expect(body.status).toBe('blocked');
    } finally { await fixture.cleanup(); }
  });

  test('an editor action is not run against the empty context used when the workspace snapshot cannot be read', async () => {
    const fixture = makeFixture();
    const snapshotModule = await import('../../input/agent-workspace-snapshot.ts');
    const spy = spyOn(snapshotModule, 'buildAgentWorkspaceRuntimeSnapshot').mockImplementation(() => { throw new Error('routine store unreadable'); });
    try {
      const result = await fixture.admittedTool.execute({ mode: 'run_workspace_action', actionId: 'routines-promote', recordId: 'weekly-review' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('routine store unreadable');
      expect(result.error).toContain('nothing was changed');
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });

  test('an editor that does not read the workspace snapshot still runs when the snapshot cannot be read', async () => {
    const fixture = makeFixture();
    const snapshotModule = await import('../../input/agent-workspace-snapshot.ts');
    const spy = spyOn(snapshotModule, 'buildAgentWorkspaceRuntimeSnapshot').mockImplementation(() => { throw new Error('routine store unreadable'); });
    try {
      const result = await fixture.admittedTool.execute({ mode: 'run_workspace_action', actionId: 'context-create-note' });
      expect(result.error ?? '').not.toContain('routine store unreadable');
      expect(result.error ?? '').not.toContain('was not run and nothing was changed');
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });

  test('a profile name that starts with "--" is refused instead of becoming a flag', async () => {
    const fixture = makeFixture();
    try {
      const { result } = await run(fixture, {
        mode: 'run_workspace_action', actionId: 'runtime-profile-create', fields: { name: '--template', template: 'none' }, confirm: true, explicitUserRequest: 'Create a profile.',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('starts with "--"');
    } finally { await fixture.cleanup(); }
  });
});

describe('typed outcomes and real errors keep their meaning', () => {
  test('a permanent failure on the sessions path names its cause', async () => {
    const fixture = makeFixture();
    try {
      Object.assign(fixture.context.session, { sessionManager: { list: () => [], search: () => { throw new Error('bad json in saved session'); } } });
      const { result } = await run(fixture, { mode: 'sessions', query: 'invoice' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('bad json in saved session');
    } finally { await fixture.cleanup(); }
  });

  test('a session found only by its transcript content resolves by that content', async () => {
    const fixture = makeFixture();
    try {
      const manager = fixture.context.session.sessionManager!;
      const alpha = manager.list()[0]!;
      Object.assign(fixture.context.session, { sessionManager: {
        list: () => [alpha],
        search: (query: string) => query === 'invoice-7731' ? [{ session: alpha, matchCount: 1, snippets: ['the invoice-7731 thread'] }] : [],
      } });
      const { result, body } = await run(fixture, { mode: 'session', query: 'invoice-7731' });
      expect(result.success).toBe(true);
      expect(JSON.stringify(body)).toContain(alpha.name);
      const missing = await run(fixture, { mode: 'session', query: 'no-such-thing' });
      expect(missing.result.success).toBe(false);
      expect(missing.result.error).toContain('Unknown session');
    } finally { await fixture.cleanup(); }
  });

  test('a stale source in a summary section rejects the call instead of reading as "unavailable"', async () => {
    const fixture = makeFixture();
    const posture = await import('../../tools/agent-harness-setup-posture.ts');
    const spy = spyOn(posture, 'setupPostureCatalogStatus').mockRejectedValueOnce(new ToolInputProjectionError('stale'));
    try {
      await expect(fixture.tool.execute({ mode: 'summary' })).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });

  test('a summary section that is unavailable is reported as unavailable instead of failing the summary', async () => {
    const fixture = makeFixture({ secrets: false });
    try {
      const result = await fixture.tool.execute({ mode: 'summary' });
      expect(result.success).toBe(true);
      const body = JSON.parse(result.output ?? '{}') as { providerAccounts?: { status?: string } };
      expect(body.providerAccounts?.status).toBe('unavailable');
    } finally { await fixture.cleanup(); }
  });

  test('a held source in a summary section rejects the call too, because the source changed mid-read', async () => {
    const fixture = makeFixture();
    const posture = await import('../../tools/agent-harness-setup-posture.ts');
    const spy = spyOn(posture, 'setupPostureCatalogStatus').mockRejectedValueOnce(new ToolInputProjectionError('held'));
    try {
      await expect(fixture.tool.execute({ mode: 'summary' })).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });

  test('a plain error in an early mode returns a tool error like the later modes', async () => {
    const fixture = makeFixture();
    const commands = await import('../../tools/agent-harness-command-catalog.ts');
    const spy = spyOn(commands, 'searchHarnessCommands').mockRejectedValueOnce(new Error('catalog broke'));
    try {
      const result = await fixture.tool.execute({ mode: 'commands', query: 'x' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('catalog broke');
    } finally { spy.mockRestore(); await fixture.cleanup(); }
  });
});

describe('UI surfaces say what they did', () => {
  test('a web configuration that cannot be read opens nothing and reports why, not "disabled"', async () => {
    const fixture = makeFixture();
    try {
      const realGet = fixture.configManager.get.bind(fixture.configManager);
      // The harness refuses a replaced configuration owner, and the settings snapshot reads the same key, so the one
      // manager is kept and only the read made directly by the cockpit route fails: the first caller outside this
      // test and the manager wrapper is the route.
      const readsDirectlyFromCockpitRoute = (): boolean => {
        const callers = (new Error().stack ?? '').split('\n').slice(1)
          .filter(frame => !frame.includes('agent-harness-outcome-honesty.test') && !frame.includes('(unknown)'));
        return callers[0]?.includes('agent-harness-browser-cockpit-route') === true;
      };
      const spy = spyOn(fixture.configManager, 'get').mockImplementation(((key: string) => {
        if (key === 'web.publicBaseUrl' && readsDirectlyFromCockpitRoute()) throw new Error('web settings are corrupt');
        return realGet(key as never);
      }) as never);
      try {
        const before = fixture.openedSurfaces.length;
        const { result, body } = await run(fixture, { mode: 'open_ui_surface', surfaceId: 'connected-browser-cockpit', explicitUserRequest: 'Open the cockpit.' });
        expect(result.success).toBe(false);
        expect(body.status).toBe('unavailable');
        expect(String(body.note)).toContain('web settings are corrupt');
        expect(String(body.note)).not.toContain('disabled');
        expect(fixture.openedSurfaces.length).toBe(before);
        const route = body.route as Record<string, unknown>;
        expect(route.workspaceCoverage).toBeUndefined();
        expect(route.mobile).toBeUndefined();
        expect(route.receipts).toBeUndefined();
        expect(JSON.stringify(route)).not.toContain('disabled');
      } finally { spy.mockRestore(); }
    } finally { await fixture.cleanup(); }
  });

  test('every Agent workspace category belongs to a browser cockpit lane', () => {
    const covered = new Set<string>(BROWSER_COCKPIT_EXPECTED_LANES.flatMap(lane => lane.categoryIds));
    expect(AGENT_WORKSPACE_CATEGORIES.map(category => category.id).filter(id => !covered.has(id))).toEqual([]);
  });

  test('an unknown Agent workspace area is refused and nothing is opened', async () => {
    const fixture = makeFixture();
    try {
      const before = fixture.openedSurfaces.length;
      const { body } = await run(fixture, { mode: 'open_ui_surface', surfaceId: 'agent-workspace', categoryId: 'typo', confirm: true, explicitUserRequest: 'Open it.' });
      expect(body.status).toBe('not_opened');
      expect(String(body.note)).toContain('Valid ids');
      expect(fixture.openedSurfaces.length).toBe(before);
    } finally { await fixture.cleanup(); }
  });

  test('a workspace alias such as "channels" still opens the area the workspace resolves it to', async () => {
    const fixture = makeFixture();
    try {
      const before = fixture.openedSurfaces.length;
      const { body } = await run(fixture, { mode: 'open_ui_surface', surfaceId: 'agent-workspace', categoryId: 'channels', confirm: true, explicitUserRequest: 'Open it.' });
      expect(body.status).toBe('opened');
      expect(fixture.openedSurfaces.length).toBe(before + 1);
    } finally { await fixture.cleanup(); }
  });

  test('a model id given as the picker target is refused, and a declined picker is not reported as opened', async () => {
    const fixture = makeFixture();
    try {
      const refused = await run(fixture, { mode: 'open_ui_surface', surfaceId: 'model-picker', target: 'gpt-5', confirm: true, explicitUserRequest: 'Open it.' });
      expect(refused.body.status).toBe('not_opened');
      expect(String(refused.body.note)).toContain('main, helper, tool or tts');

      Object.assign(fixture.context, { openModelPickerWithTarget: () => false });
      const declined = await run(fixture, { mode: 'open_ui_surface', surfaceId: 'model-picker', target: 'tool', confirm: true, explicitUserRequest: 'Open it.' });
      expect(declined.body.status).toBe('not_opened');
    } finally { await fixture.cleanup(); }
  });
});

describe('setup evidence is complete and honest', () => {
  test('a value containing a code fence stays inside one fenced block', () => {
    const value = 'before\n```\ninner\n```\nafter';
    const markdown = setupSmokeEvidenceMarkdown({
      capturedAt: '2026-01-01T00:00:00.000Z', explicitUserRequest: 'Save.',
      smokePlan: { status: 'blocked', checks: [], successCriteria: [], policy: 'p' } as never,
      summary: { ready: 0 } as never, blockedChecks: [], userRunChecks: [],
      evidenceFields: [{ id: 'notes', label: 'Operator notes', value }],
    });
    const open = markdown.indexOf('````text\n');
    expect(open).toBeGreaterThan(-1);
    const close = markdown.indexOf('\n````', open + 9);
    expect(markdown.slice(open + 9, close)).toBe(value);
  });

  test('an over-long value is saved with a visible truncation marker within the cap', () => {
    const saved = redactSetupSmokeEvidence('x'.repeat(9_000));
    expect(saved.length).toBeLessThanOrEqual(8_000);
    expect(saved).toContain('[truncated: ');
  });

  test('the truncation marker counts every character that was not saved, including the ones it displaces', () => {
    for (const length of [8_001, 9_000, 12_345, 100_000]) {
      const saved = redactSetupSmokeEvidence('x'.repeat(length));
      const match = /\n\[truncated: (\d+) more characters were not saved\]$/.exec(saved);
      expect(match).not.toBeNull();
      const keptCharacters = saved.length - match![0].length;
      expect(keptCharacters + Number(match![1])).toBe(length);
      expect(saved.length).toBeLessThanOrEqual(8_000);
    }
  });

  test('evidence field names the smoke does not keep are reported back, known ones are not', () => {
    expect(ignoredSetupSmokeEvidenceFields({ notes: 'kept', mystery: 'dropped' })).toEqual(['mystery']);
    expect(ignoredSetupSmokeEvidenceFields({ notes: 'kept' })).toEqual([]);
  });

  test('evidence older than the newest 100 artifacts is still found', () => {
    const rows = [
      ...Array.from({ length: 101 }, (_, index) => ({ id: `doc-${index}`, createdAt: 1_000 - index, metadata: { purpose: 'document' } })),
      { id: 'smoke-1', createdAt: 1, metadata: { purpose: 'agent-setup-smoke-evidence', result: 'blocked' } },
    ];
    const store = { list: (limit = 100) => rows.slice(0, limit) };
    expect(listEveryArtifact((limit) => store.list(limit)).map((row) => row.id)).toContain('smoke-1');
    const context = { platform: { artifactStore: store } } as never;
    expect(latestSetupSmokeEvidence(context).status).toBe('saved');
  });
});

describe('what the model is told is accurate', () => {
  test('an unrecognised host action is refused instead of read as status', async () => {
    const { createAgentHostTool } = await import('../../tools/agent-host-tool.ts');
    const { ToolRegistry } = await import('@goodvibes-jev/engine/platform/platform/tools');
    const calls: unknown[] = [];
    const tool = createAgentHostTool({
      commandRegistry: {} as never, commandContext: { workspace: {}, platform: {} } as never, toolRegistry: new ToolRegistry(),
      harnessTool: { definition: { name: 'agent_harness', description: 'fake', parameters: { type: 'object' } }, execute: async (args: unknown) => { calls.push(args); return { success: true, output: '{}' }; } },
    });
    const result = await tool.execute({ action: 'restart' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('restart');
    expect(calls).toEqual([]);
  });

  test('every mode named in a parameter description exists', () => {
    const modes = new Set<string>(AGENT_HARNESS_MODES);
    const named = Object.values(AGENT_HARNESS_PARAMETER_PROPERTIES)
      .flatMap((property) => String((property as { description?: unknown }).description ?? '').match(/\b(?:remote|run|set|reset|open|mark|clear|provision|channel|setup|policy)_[a-z_]+\b/g) ?? []);
    expect(named.filter((name) => !modes.has(name))).toEqual([]);
  });

  test('the command and cli_command routes a catalog hands out use declared parameters', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const declared = new Set(Object.keys(fixture.tool.definition.parameters.properties as Record<string, unknown>));
      const { result } = await run(fixture, { mode: 'command', command: 'help', includeParameters: true });
      const used = [...String(result.output).matchAll(/agent_harness mode:\\?"[a-z_]+\\?"((?: [A-Za-z_]+:\\?"[^"\\]*\\?")+)/g)]
        .flatMap((match) => [...match[1]!.matchAll(/ ([A-Za-z_]+):/g)].map((key) => key[1]!));
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((key) => !declared.has(key))).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  test('the sudo posture does not list stdin write as a missing contract when the process manager can write', async () => {
    const fixture = makeFixture();
    try {
      const posture = sudoExecutionPosture(fixture.context);
      expect(typeof fixture.context.workspace.processManager?.writeInput).toBe('function');
      expect(posture.missingContracts).not.toContain('platform ProcessManager stdin write');
      expect(posture.blockedRoutes.find((route) => route.id === 'stdin-password-write')?.reason).toContain('Policy only');
    } finally { await fixture.cleanup(); }
  });

  test('a process manager without stdin write offers no write route', async () => {
    const fixture = makeFixture();
    try {
      Object.assign(fixture.processManager, { writeInput: undefined });
      const { body } = await run(fixture, { mode: 'background_processes', includeParameters: true });
      const capabilities = body.capabilities as { readonly stdinWrite: Record<string, unknown>; readonly parity: readonly Record<string, unknown>[] };
      expect(capabilities.stdinWrite.status).toBe('unavailable');
      expect(capabilities.stdinWrite.modelRoute).toBeUndefined();
      expect(capabilities.parity.find(entry => entry.capability === 'process(write)')?.modelRoute).toBeUndefined();
    } finally { await fixture.cleanup(); }
  });

  test('a started process reports its directory relative to the workspace, not an absolute path', async () => {
    const fixture = makeFixture();
    try {
      const root = fixture.context.workspace.shellPaths!.workingDirectory;
      mkdirSync(join(root, 'sub'), { recursive: true });
      const { body } = await run(fixture, {
        mode: 'run_background_process', processAction: 'start', command: 'printf ready', cwd: 'sub',
        confirm: true, explicitUserRequest: 'Start a tracked command in a subdirectory.',
      });
      expect(body.status).toBe('started');
      expect(body.cwd).toBe('sub');
      expect(JSON.stringify(body)).not.toContain(root);
    } finally { await fixture.cleanup(); }
  });

  test('the cockpit onboarding marker names its scope and never a file path', async () => {
    const fixture = makeFixture();
    try {
      const { body } = await run(fixture, { mode: 'ui_surface', surfaceId: 'connected-browser-cockpit', includeParameters: true });
      const find = (value: unknown): Record<string, unknown> | undefined => {
        if (Array.isArray(value)) { for (const entry of value) { const hit = find(entry); if (hit) return hit; } return undefined; }
        if (typeof value !== 'object' || value === null) return undefined;
        const record = value as Record<string, unknown>;
        if (typeof record.agentOnboardingCompletion === 'object' && record.agentOnboardingCompletion !== null) return record.agentOnboardingCompletion as Record<string, unknown>;
        for (const entry of Object.values(record)) { const hit = find(entry); if (hit) return hit; }
        return undefined;
      };
      const marker = find(body);
      expect(marker).toBeDefined();
      expect(marker!.scope).toBe('user');
      expect('path' in marker!).toBe(false);
    } finally { await fixture.cleanup(); }
  });

  test('a service posture probe that failed names its cause instead of reading as unavailable in general', () => {
    const probe = connectedHostServiceProbe(null, 'socket closed by peer');
    expect(probe.status).toBe('not-probed');
    expect(probe.issues.join(' ')).toContain('socket closed by peer');
    expect(connectedHostServiceProbe(null).issues.join(' ')).not.toContain('failed');
  });

  test('native auth that is ready without a readable token file routes to verification, not token provisioning', () => {
    const authPosture: SetupConnectedHostAuthPosture = {
      owner: 'connected-host',
      nativeIntake: { status: 'ready', detail: 'paired owner verified' },
      operatorToken: { present: false, usable: false, path: '~/.goodvibes/daemon/operator-token' },
      compatibilityAuth: { userStorePath: 'users', userStorePresent: false, bootstrapCredentialPath: 'bootstrap', bootstrapCredentialPresent: false, users: 0, sessions: 0 },
      routes: { reviewCommand: '/auth review', connectedHostStatus: 'host action:"status"', pairingPosture: 'p', qrPairingRoute: 'q', manualTokenRoute: 'm',
        provisionTokenRoute: 'provision', tokenProvisioningOwner: 'o', tokenProvisioningSource: 's' },
    };
    const item: SetupPlanItem = { id: 'connected-host-auth', label: 'Connected-host auth', status: 'ready', priority: 12, blocksAutonomy: true,
      reason: 'r', nextAction: 'n', userRoute: 'u', modelRoute: 'host action:"status" includeParameters:true', authPosture };
    expect(connectedHostAuthNeedsVerificationOnly(authPosture)).toBe(true);
    const decision = primarySetupRepairDecision(item);
    expect(decision.id).toBe('verify-connected-host-auth');
    expect(decision.requiresConfirmation).toBeUndefined();
    expect(decision.reason).not.toContain('token provisioning is the narrow confirmed repair');
    // A lingering compatibility bootstrap credential keeps the token repair in play.
    const lingering: SetupConnectedHostAuthPosture = { ...authPosture, compatibilityAuth: { ...authPosture.compatibilityAuth, bootstrapCredentialPresent: true } };
    expect(connectedHostAuthNeedsVerificationOnly(lingering)).toBe(false);
    expect(primarySetupRepairDecision({ ...item, authPosture: lingering }).id).toBe('provision-connected-host-token');
  });

  test('the host bootstrap never installs a private workspace package from the registry', () => {
    const privateNames = ['tui', 'daemon', 'agent'].map((name) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', '..', name, 'package.json'), 'utf8')) as { name: string; private?: boolean })
      .filter((manifest) => manifest.private === true).map((manifest) => manifest.name);
    expect(privateNames.length).toBeGreaterThan(0);
    const plan = connectedHostBootstrapPlan({ collectionIssues: [] } as never, { status: 'unreachable' } as never);
    const commands = plan.steps.flatMap((step) => step.commands);
    expect(commands.filter((command) => privateNames.some((name) => command.includes(name)))).toEqual([]);
    expect(commands).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
  });

  test('a settings page about payments offers no model route for the person-only card prompt', async () => {
    const fixture = makeFixture();
    try {
      const { body } = await run(fixture, { mode: 'settings', prefix: 'payments.' });
      const related = (body.relatedCommands ?? []) as readonly { command: string; modelRoute?: string }[];
      const card = related.find((entry) => entry.command === '/payments card');
      expect(card).toBeDefined();
      expect(card!.modelRoute).toBeUndefined();
    } finally { await fixture.cleanup(); }
  });

  test('a described model route is never cut off mid-argument', () => {
    const long = `agent_harness mode:"workspace_actions" query:"${'review packet '.repeat(30)}" categoryId:"documents"`;
    expect(long.length).toBeGreaterThan(220);
    for (const includeParameters of [false, true]) {
      const step = describeReviewPacketWizardStep({
        id: 's', label: 'Step', status: 'current', detail: 'd', userRoute: 'u', modelRoute: long, actionId: 'a', backtrackRoute: long,
      }, includeParameters);
      expect(step.modelRoute).toBe(long);
      expect(step.backtrackRoute).toBe(long);
      const lane = describeDocumentOpsLane({
        id: 'documents', label: 'Documents', status: 'ready', outcome: 'o', current: 'c', next: 'n', userRoute: 'u', modelRoute: long, signals: [], actionIds: [],
      }, includeParameters);
      expect(lane.modelRoute).toBe(long);
      const lane2: Parameters<typeof describePersonalOpsQueueItem>[0] = { id: 'inbox', label: 'Inbox', status: 'ready', outcome: 'o', current: 'c', next: 'n', userRoute: 'u', modelRoute: 'm', signals: [] };
      const item = describePersonalOpsQueueItem(lane2, { id: 'r', label: 'R', status: 'ready', summary: 's', userRoute: 'u', modelRoute: long }, includeParameters);
      expect(item.modelRoute).toBe(long);
      expect(item.inspectRoute).toBe(long);
    }
  });

  test('no workspace action listing, at either detail level, cuts a modelRoute short', async () => {
    const fixture = makeFixture();
    try {
      for (const includeParameters of [true, false]) {
        const { body } = await run(fixture, { mode: 'workspace_actions', includeParameters, limit: 1000 });
        const actions = (body.actions ?? []) as readonly { id: string; modelRoute: string }[];
        expect(actions.length).toBeGreaterThan(100);
        expect(actions.filter((action) => action.modelRoute.endsWith('...')).map((action) => action.id)).toEqual([]);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('every workspace action that names a model execution tool routes to that same tool', async () => {
    const fixture = makeFixture();
    try {
      const { body } = await run(fixture, { mode: 'workspace_actions', includeParameters: true, limit: 1000 });
      const actions = (body.actions ?? []) as readonly { id: string; modelRoute: string; editorKind?: string; modelExecution?: { tool?: string } }[];
      const withTool = actions.filter((action) => action.editorKind && typeof action.modelExecution?.tool === 'string');
      expect(withTool.length).toBeGreaterThan(10);
      // A first-class route with its own action (`research action:"..."`) is another entry point to the same effect.
      const disagree = withTool.filter((action) => {
        const tool = action.modelExecution!.tool!;
        return !(action.modelRoute === tool || action.modelRoute.startsWith(`${tool} `) || action.modelRoute.includes(' action:"'));
      });
      expect(disagree.map((action) => `${action.id}: ${action.modelRoute} vs ${action.modelExecution!.tool}`)).toEqual([]);
      const route = (id: string) => actions.find((action) => action.id === id)?.modelRoute;
      expect(route('document-reviewer-readiness')).toBe('agent_harness mode:"run_workspace_action"');
      expect(route('document-diff-handoffs')).toBe('agent_model_compare');
    } finally { await fixture.cleanup(); }
  });

  test('paths under the home directory are shown relative to it', () => {
    expect(homeRelativePath('/home/ann/.goodvibes/.env', '/home/ann')).toBe('~/.goodvibes/.env');
    expect(homeRelativePath('/srv/other/file', '/home/ann')).toBe('/srv/other/file');
    expect(homeRelativePath('Agent host-bound pairing store', '/home/ann')).toBe('Agent host-bound pairing store');
  });
});

describe('remote mutations without their ids', () => {
  test.each([
    ['remote_pair_approve', 'requestId'],
    ['remote_pair_reject', 'requestId'],
    ['remote_peers_invoke', 'peerId'],
    ['remote_work_cancel', 'workId'],
  ] as const)('%s is refused naming the missing field, before any admission is needed', async (mode, field) => {
    const fixture = makeFixture();
    try {
      const result = await fixture.tool.execute({ mode });
      expect(result.success).toBe(false);
      expect(result.error).toContain(field);
      expect(result.error).not.toContain('admission');
    } finally { await fixture.cleanup(); }
  });
});
