import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GATE_PRESETS } from '@goodvibes-jev/engine/platform/platform/gate';
import { buildCliStatusSnapshot, renderCliStatus } from '../../cli/status.ts';
import { PERMISSION_MODE_OPTIONS } from '../../input/onboarding/onboarding-wizard-constants.ts';
import { handleDoctorSubcommand } from '../../cli/doctor.ts';
import type { GoodVibesCliOutputFormat } from '@goodvibes-jev/engine/terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeOptions(root: string, subcommand: string, args: string[], outputFormat: GoodVibesCliOutputFormat = 'text') {
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  return { configManager, subcommand, args, workingDirectory: root, homeDirectory: root, outputFormat };
}

describe('goodvibes doctor subcommands', () => {
  let root = '';
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    root = makeProjectTempDir('gv-doctor');
    previous = installJudgmentPort(fakePort((wireName, question, state) => {
      const name = wireName.includes('__') ? wireName.slice(wireName.indexOf('__') + 2) : wireName;
      const input = state as { tool?: string; arguments?: unknown; workingDirectory?: string };
      const read = { mutates: 0.01, outward: 0.01, secrets: 0.01, kind: 'read', family: 'generic', irreversible: 0.01, beyondProject: 0.01, weakensSecurity: 0.01, catastrophic: 0.01, cardDetails: 0.01 };
      const write = { ...read, mutates: 0.99, kind: 'write', family: 'file-mutation' };
      const remove = { ...read, mutates: 0.99, kind: 'shell', family: 'shell-destructive', irreversible: 0.99, obfuscated: 0.01 };
      const fixtures: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
        'read:{"path":"./src/x.ts"}': read,
        'write:{"path":"./src/x.ts"}': write,
        'write:{"path":"./a.ts"}': write,
        'exec:{"command":"rm -rf build"}': remove,
        'exec:{"command":"fixture-post"}': { ...read, mutates: 0.99, outward: 0.99, kind: 'shell', family: 'network-egress', obfuscated: 0.01, cardDetails: 0.5 },
        'exec:{"command":"rm -rf /tmp/x"}': { ...remove, beyondProject: 0.99 },
      };
      const facts = input.workingDirectory === root ? fixtures[`${input.tool}:${JSON.stringify(input.arguments)}`] : undefined;
      const reading = facts && Object.hasOwn(facts, name) ? facts[name] : undefined;
      if (reading === undefined) throw new Error(`Unexpected doctor fixture question: ${name}`);
      return typeof reading === 'string' ? choiceAnswer(question, reading, 0.99) : noulAnswer(reading);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });

  test('unknown subcommand returns null so the classic doctor renders', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'nonsense', []));
    expect(result).toBeNull();
  });

  test('explanation fixtures reject unlisted arguments instead of guessing their meaning', async () => {
    await expect(handleDoctorSubcommand(makeOptions(root, 'explain', ['read', './unlisted.ts']))).rejects.toThrow('Unexpected doctor fixture');
  });

  test('routing lists the conversation role and its config keys', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'routing', []));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('Conversation (main model)');
    expect(result!.output).toContain('provider.model');
    expect(result!.output).toContain('Helper');
    expect(result!.output).toContain('Tool LLM');
  });

  test('explain: read tool in prompt mode is ALLOWED without a prompt', async () => {
    const opts = makeOptions(root, 'explain', ['read', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'safe-owner');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('safe-owner');
  });

  test('explain: ordinary write in safe-owner runs without approval', async () => {
    const opts = makeOptions(root, 'explain', ['write', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'safe-owner');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('DECIDED HERE');
  });

  test('explain: a shell command in plan mode is DENIED with the plan-mode reason', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'plan');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: DENY');
    expect(result!.output).toContain('plan_mode');
    // A bare shell command is routed through the exec tool.
    expect(result!.output).toContain('exec');
  });

  test('explain: safe-owner asks for critical outside-project destruction', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x']);
    opts.configManager.set('permissions.mode', 'safe-owner');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ASK');
    expect(result!.output).toContain('user_prompt');
    expect(result!.output).toContain('CRITICAL');
  });

  test('YOLO verdict agrees with status and onboarding', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x'], 'json');
    opts.configManager.set('permissions.mode', 'yolo');
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.permissionEvaluated).toBe(true);
    const status = JSON.parse(renderCliStatus(opts));
    expect(status.auth.permissionLabel).toBe('YOLO');
    const option = PERMISSION_MODE_OPTIONS.find(option => option.id === 'yolo')!;
    expect(option.label).toBe(status.auth.permissionLabel);
    expect(option.hint).toBe(status.auth.permissionDetail);
  });

  test('legacy auto-approve status and execution both report YOLO', async () => {
    const opts = makeOptions(root, 'explain', ['fixture-post'], 'json');
    opts.configManager.set('permissions.mode', 'safe-owner');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.permissionEvaluated).toBe(true);
    const snapshot = buildCliStatusSnapshot(opts);
    expect(snapshot.auth.permissionLabel).toBe('YOLO');
    expect(snapshot.auth.permissionDetail).toBe(GATE_PRESETS.yolo.summary);
    expect(snapshot.findings.some(f => f.id === 'auto-approve-permissions' && f.severity === 'risk')).toBe(true);
  });

  test('auto-approve override is reported instead of promising the underlying preset will ask', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x'], 'json');
    opts.configManager.set('permissions.mode', 'yolo');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.permissionEvaluated).toBe(true);
    const snapshot = buildCliStatusSnapshot(opts);
    expect(snapshot.auth.permissionLabel).toBe('YOLO');
    expect(snapshot.auth.permissionDetail).toBe(GATE_PRESETS.yolo.summary);
    expect(snapshot.findings.find(f => f.id === 'allow-all-permissions')?.impact).not.toContain('critical calls still ask');
  });

  test('explain: allow-all permits a below-critical destructive project call', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'yolo');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
  });

  test('YOLO mode is attributed to execution policy rather than a stakes reading', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'yolo');
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.reasonCode).toBe('mode_allow_all');
    const text = (await handleDoctorSubcommand({ ...opts, outputFormat: 'text' }))!.output;
    expect(text).toContain('DECIDED HERE');
  });

  test('YOLO remains unrestricted when old per-tool deny settings are present', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'safe-owner');
    opts.configManager.set('permissions.tools.exec', 'deny');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.reasonCode).toBe('mode_allow_all');
    expect(actual.because).not.toContain('permissions.tools.exec is set to "allow"');
  });

  test('explain: json output carries the authoritative verdict and layers', async () => {
    const opts = makeOptions(root, 'explain', ['write', './a.ts'], 'json');
    opts.configManager.set('permissions.mode', 'safe-owner');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const parsed = JSON.parse(result!.output) as { verdict: string; sourceLayer: string; reasonCode: string };
    expect(parsed.verdict).toBe('ALLOW');
  });

  test('hooks: lists registered hooks with their source and flags an unknown event point', async () => {
    const hooksPath = join(root, 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        'Pre:tool:*': [{ name: 'guard', match: 'Pre:tool:*', type: 'command', command: 'echo hi' }],
        'Pre:bogus:thing': [{ name: 'bad', match: 'Pre:bogus:thing', type: 'command', command: 'echo x' }],
      },
    }), 'utf-8');
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', hooksPath);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(1);
    expect(result!.output).toContain('[PASS] Pre:tool:*');
    expect(result!.output).toContain('[FAIL] Pre:bogus:thing');
    expect(result!.output).toContain(hooksPath);
    expect(result!.output).toContain('not a recognized hook event point');
  });

  test('hooks: reports an absent hooks file honestly', async () => {
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', join(root, 'nope.json'));
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('no hooks file present');
  });
});
