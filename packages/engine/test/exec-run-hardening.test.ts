// What the exec tool does when a wait runs out, when a file operation fails or
// reaches outside the project, how much it keeps of a noisy command, which
// environment it withholds, and what its sandbox plan grants.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../platform/src/platform/tools/exec/runtime.ts';
import { execCommandText } from '../platform/src/platform/tools/exec/schema.ts';
import { executeFileOperations } from '../platform/src/platform/tools/exec/file-ops.ts';
import { formatResult } from '../platform/src/platform/tools/exec/result-format.ts';
import { resolveCredentialEnvScrub, scrubCredentialEnv } from '../platform/src/platform/tools/exec/credential-env.ts';
import { sandboxWorkspaceRefusal, type ExecRunPolicy } from '../platform/src/platform/tools/exec/policy.ts';
import {
  brokerSandboxEscalation,
  resolveRuntimeSandboxPlan,
  type ExecSandboxPlan,
  type ExecSandboxRuntime,
} from '../platform/src/platform/tools/exec/sandbox.ts';
import { detectPtyAvailability, probePtyHost, runInteractiveCommand, type ExecInteractionRuntime } from '../platform/src/platform/tools/exec/interactive.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { requireLiveHost } from './_helpers/exec-containment-proof.ts';

useToolReadings([
  ['"lastLine":"Continue? [y/n]:"', { awaitingInput: true }],
], [...EXEC_GATE_TABLE, ['git fetch', { mutates: false, outward: true, needsNetwork: true }]]);

const roots: string[] = [];
const managers: ProcessManager[] = [];
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-exec-hardening-')));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function execTool(root: string, options: Partial<Parameters<typeof createExecTool>[1]> = {}) {
  const manager = new ProcessManager();
  managers.push(manager);
  return createExecTool(manager, {
    overflowHandler: new OverflowHandler({ baseDir: root }),
    defaultWorkingDirectory: root,
    credentialEnvScrub: { enabled: false },
    ...options,
  });
}

const parse = (output: string | undefined): Record<string, unknown> => JSON.parse(output ?? '{}') as Record<string, unknown>;

describe('an until wait that runs out is a result, not a failed call', () => {
  test('the pattern never appears: timed_out with what was printed', async () => {
    const root = tempRoot();
    const result = await execTool(root).execute({ commands: [{ cmd: 'echo started; sleep 30', until: { pattern: 'READY', timeout_ms: 300 } }] });
    const output = parse(result.output);
    expect(result.success).toBe(false);
    expect(output.timed_out).toBe(true);
    expect(String(output.stdout)).toContain('started');
  });

  test('earlier commands of the batch keep their results', async () => {
    const root = tempRoot();
    const result = await execTool(root).execute({ commands: [
      { cmd: 'echo first' },
      { cmd: 'sleep 30', until: { pattern: 'READY', timeout_ms: 300 } },
    ] });
    const commands = parse(result.output).commands as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(2);
    expect(String(commands[0]!.stdout)).toContain('first');
    expect(commands[1]!.timed_out).toBe(true);
  });
});

describe('file operations stay inside the project and report what they did', () => {
  test('an absolute destination outside the project root is refused', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'data');
    const result = await execTool(root).execute({ file_ops: [{ op: 'copy', source: 'a.txt', destination: join(outside, 'x.txt') }], commands: [{ cmd: 'true' }] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the project root/);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  test('an absolute source outside the project root is refused for a move', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, 'key'), 'secret');
    const result = await execTool(root).execute({ file_ops: [{ op: 'move', source: join(outside, 'key'), destination: 'key' }], commands: [{ cmd: 'true' }] });
    expect(result.success).toBe(false);
    expect(existsSync(join(outside, 'key'))).toBe(true);
    expect(existsSync(join(root, 'key'))).toBe(false);
  });

  test('deleting the project root or .git is refused', async () => {
    const root = tempRoot();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'keep.txt'), 'x');
    const tool = execTool(root);
    const wholeRoot = await tool.execute({ file_ops: [{ op: 'delete', source: '.', recursive: true }], commands: [{ cmd: 'true' }] });
    expect(wholeRoot.error).toMatch(/refusing to delete the project root/);
    const git = await tool.execute({ file_ops: [{ op: 'delete', source: '.git', recursive: true }], commands: [{ cmd: 'true' }] });
    expect(git.error).toMatch(/refusing to delete inside '\.git'/);
    expect(existsSync(join(root, 'keep.txt'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(true);
  });

  test('deleting the root or .git is refused when the project root is reached through a symlink', async () => {
    const real = tempRoot();
    mkdirSync(join(real, '.git'));
    const link = join(tempRoot(), 'linked');
    symlinkSync(real, link);
    const tool = execTool(link);
    const wholeRoot = await tool.execute({ file_ops: [{ op: 'delete', source: '.', recursive: true }], commands: [{ cmd: 'true' }] });
    expect(wholeRoot.error).toMatch(/refusing to delete the project root/);
    const git = await tool.execute({ file_ops: [{ op: 'delete', source: '.git', recursive: true }], commands: [{ cmd: 'true' }] });
    expect(git.error).toMatch(/refusing to delete inside '\.git'/);
    expect(existsSync(join(real, '.git'))).toBe(true);
  });

  test('deleting .git through a symlink inside the project that points at the root is refused', async () => {
    const root = tempRoot();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'sub'));
    symlinkSync(root, join(root, 'l'));
    symlinkSync(root, join(root, 'sub', 'up'));
    const tool = execTool(root);
    for (const source of ['l/.git', 'sub/up/.git']) {
      const result = await tool.execute({ file_ops: [{ op: 'delete', source, recursive: true }], commands: [{ cmd: 'true' }] });
      expect(result.error).toMatch(/refusing to delete inside '\.git'/);
    }
    expect(existsSync(join(root, '.git'))).toBe(true);
  });

  test('when the second operation fails the first is listed, the failing index is named, and no command runs', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'data');
    const result = await execTool(root).execute({
      file_ops: [{ op: 'move', source: 'a.txt', destination: 'b.txt' }, { op: 'move', source: 'missing.txt', destination: 'c.txt' }],
      commands: [{ cmd: 'touch ran' }],
    });
    const output = parse(result.output);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^file_ops failed:/);
    expect(result.error).toMatch(/1 of 2 file_ops applied/);
    expect((output.file_ops as Array<{ op: string }>).map((operation) => operation.op)).toEqual(['move']);
    expect(output.failed_op_index).toBe(1);
    expect(output.commands_run).toBe(false);
    expect(existsSync(join(root, 'b.txt'))).toBe(true);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  test('a session that requires the boundary refuses file operations and changes nothing', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'data');
    const result = await execTool(root, { containment: { posture: 'required', reason: 'hosted conversational turn' } })
      .execute({ file_ops: [{ op: 'delete', source: 'a.txt' }], commands: [{ cmd: 'true' }] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_ops refused/);
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });

  test('update_imports follows a move through explicit extensions and fixes the moved file\'s own imports', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src/a'), { recursive: true });
    mkdirSync(join(root, 'src/b'), { recursive: true });
    writeFileSync(join(root, 'src/a/x.ts'), "import { y } from './y.js';\nimport { z } from '../z';\nexport const x = y + z;\n");
    writeFileSync(join(root, 'src/a/y.ts'), 'export const y = 1;\n');
    writeFileSync(join(root, 'src/z.ts'), 'export const z = 2;\n');
    writeFileSync(join(root, 'src/c.ts'), "import { x } from './a/x.js';\nimport { y } from './a/y.js';\nexport { x, y };\n");
    writeFileSync(join(root, 'src/d.ts'), "export * from './a/x';\n");
    const outcome = await executeFileOperations([{ op: 'move', source: 'src/a/x.ts', destination: 'src/b/x.ts', update_imports: true }], root);
    expect(outcome.fileOpError).toBeUndefined();
    expect(readFileSync(join(root, 'src/c.ts'), 'utf8')).toBe("import { x } from './b/x.js';\nimport { y } from './a/y.js';\nexport { x, y };\n");
    expect(readFileSync(join(root, 'src/d.ts'), 'utf8')).toBe("export * from './b/x';\n");
    expect(readFileSync(join(root, 'src/b/x.ts'), 'utf8')).toBe("import { y } from '../a/y.js';\nimport { z } from '../z';\nexport const x = y + z;\n");
  });

  test('a failure after a move still rewrites the importers of the file that did move', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'user.ts'), "import { x } from './x';\n");
    const outcome = await executeFileOperations([
      { op: 'move', source: 'x.ts', destination: 'moved.ts', update_imports: true },
      { op: 'delete', source: 'missing.ts' },
    ], root);
    expect(outcome.fileOpError).toMatch(/^file_ops failed:/);
    expect(outcome.fileOpFailedIndex).toBe(1);
    expect(readFileSync(join(root, 'user.ts'), 'utf8')).toBe("import { x } from './moved';\n");
  });

  test('update_imports that changes nothing says so', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'solo.ts'), 'export const solo = 1;\n');
    const outcome = await executeFileOperations([{ op: 'move', source: 'solo.ts', destination: 'moved.ts', update_imports: true }], root);
    expect(outcome.fileOpWarnings?.join(' ')).toMatch(/update_imports changed nothing/);
  });
});

describe('a command entry runs the text it shows', () => {
  const b64 = (text: string): string => Buffer.from(text).toString('base64');

  test('cmd and cmd_base64 that disagree are refused before any file operation or command', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'data');
    const result = await execTool(root).execute({
      file_ops: [{ op: 'move', source: 'a.txt', destination: 'b.txt' }],
      commands: [{ cmd: 'ls', cmd_base64: b64('touch hidden') }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/both cmd and cmd_base64/);
    expect(existsSync(join(root, 'hidden'))).toBe(false);
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });

  test('execCommandText decodes base64, accepts matching text and refuses malformed base64', () => {
    expect(execCommandText({ cmd_base64: b64('echo hi') })).toBe('echo hi');
    expect(execCommandText({ cmd: 'echo hi', cmd_base64: b64('echo hi') })).toBe('echo hi');
    expect(execCommandText({ cmd: 'echo hi' })).toBe('echo hi');
    expect(() => execCommandText({ cmd_base64: '***not base64***' })).toThrow(/not valid base64/);
    expect(() => execCommandText({})).toThrow(/either cmd or cmd_base64/);
  });
});

describe('progress files and noisy output', () => {
  const progressFiles = (root: string): string[] => {
    const directory = join(root, '.goodvibes', '.overflow');
    return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('-progress.txt')) : [];
  };

  test('quick commands with no timeout leave no progress files behind', async () => {
    const root = tempRoot();
    const tool = execTool(root);
    for (let i = 0; i < 3; i++) expect((await tool.execute({ commands: [{ cmd: 'echo hi' }] })).success).toBe(true);
    expect(progressFiles(root)).toEqual([]);
  });

  test('a progress file the caller asked for is kept and named', async () => {
    const root = tempRoot();
    const output = parse((await execTool(root).execute({ commands: [{ cmd: 'echo hi', progress: true }] })).output);
    expect(progressFiles(root)).toHaveLength(1);
    expect(String(output.progress_file)).toContain('-progress.txt');
  });

  test('a workspace where the progress file cannot be created still runs the command', async () => {
    const root = tempRoot();
    writeFileSync(join(root, '.goodvibes'), 'a file, not a directory');
    const result = await execTool(root).execute({ commands: [{ cmd: 'echo hi' }] });
    expect(result.success).toBe(true);
    expect(parse(result.output).progress_file).toBeUndefined();
  });

  test('an until pattern is still found after far more output than the window it is tested against', async () => {
    const root = tempRoot();
    const result = await execTool(root).execute({ commands: [{ cmd: 'head -c 300000 /dev/zero | tr "\\0" "a"; echo; echo READY', until: { pattern: 'READY', timeout_ms: 20_000 } }] });
    expect(result.success).toBe(true);
    expect(parse(result.output).stdout_truncated).toBe(true);
  });

  test('a timed-out noisy command is cut like a finished one', async () => {
    const root = tempRoot();
    const result = await execTool(root).execute({ commands: [{ cmd: 'head -c 200000 /dev/zero | tr "\\0" "a"; sleep 30', progress: true, timeout_ms: 1500 }] });
    const output = parse(result.output);
    expect(output.timed_out).toBe(true);
    expect(output.stdout_truncated).toBe(true);
    expect(String(output.stdout).length).toBeLessThan(120_000);
  });
});

describe('result shaping keeps what explains or acts on a result', () => {
  test('count_only keeps the handle of a detached process and the reason a zero exit failed', () => {
    const shaped = formatResult({ cmd: 'sleep 600', exit_code: 0, stdout: '', stderr: '', success: true, process_id: 'bg_1', pid: 4321 }, 'count_only');
    expect(shaped.process_id).toBe('bg_1');
    expect(shaped.pid).toBe(4321);
    const expectation = formatResult({ cmd: 'true', exit_code: 0, stdout: '', stderr: '', success: false, expectation_error: "stdout_contains: 'ok' not found" }, 'count_only');
    expect(expectation.expectation_error).toContain('not found');
  });

  test('every verbosity carries timed_out, retries and warnings', () => {
    for (const verbosity of ['count_only', 'minimal', 'standard'] as const) {
      const shaped = formatResult({ cmd: 'x', exit_code: null, stdout: '', stderr: '', success: false, timed_out: true, retries: 2, warnings: ['w'] }, verbosity);
      expect(shaped.timed_out).toBe(true);
      expect(shaped.retries).toBe(2);
      expect(shaped.warnings).toEqual(['w']);
    }
  });
});

describe('the credential scrub', () => {
  test('withholds secret keys, passwords, tokens, DSNs and URLs that embed a password; keeps the rest', async () => {
    const { env, withheld } = await scrubCredentialEnv({
      SECRET_KEY: 'a', JWT_SECRET_KEY: 'b', ENCRYPTION_KEY: 'c', SIGNING_KEY: 'd', STRIPE_KEY: 'e', DB_PASSWD: 'f', MYSQL_PWD: 'g',
      GITHUB_PAT: 'h', SENTRY_DSN: 'i', REDIS_URL: 'redis://cache', MIRROR: 'https://user:hunter2@mirror.example/path',
      PWD: '/work', OLDPWD: '/before', DESKTOP_SESSION: 'plasma', PATH: '/usr/bin', REGISTRY: 'https://registry.example/path',
    }, resolveCredentialEnvScrub());
    expect(withheld).toEqual(['DB_PASSWD', 'ENCRYPTION_KEY', 'GITHUB_PAT', 'JWT_SECRET_KEY', 'MIRROR', 'MYSQL_PWD', 'REDIS_URL', 'SECRET_KEY', 'SENTRY_DSN', 'SIGNING_KEY', 'STRIPE_KEY']);
    expect(Object.keys(env).sort()).toEqual(['DESKTOP_SESSION', 'OLDPWD', 'PATH', 'PWD', 'REGISTRY']);
  });

  test('the allowlist still overrides', async () => {
    const { env } = await scrubCredentialEnv({ STRIPE_KEY: 'e' }, resolveCredentialEnvScrub({ allowlist: ['stripe_key'] }));
    expect(env.STRIPE_KEY).toBe('e');
  });
});

describe('the sandbox', () => {
  const sandbox = (egressAllowlist: string[], requestEscalation?: ExecSandboxRuntime['requestEscalation']): ExecSandboxRuntime => ({
    config: { enabled: true, egressAllowlist, workspaceWritable: [] },
    availability: { available: true, backend: 'bubblewrap', bwrapPath: '/usr/bin/bwrap', reason: 'fixture', networkIsolationGuaranteed: true },
    featureEnabled: true,
    ...(requestEscalation ? { requestEscalation } : {}),
  });

  test('a working_dir outside the project root is refused when the command would be sandboxed', async () => {
    const root = tempRoot();
    const result = await execTool(root, { sandbox: sandbox([]) }).execute({ working_dir: '/', commands: [{ cmd: 'ls' }] });
    const output = parse(result.output);
    expect(result.success).toBe(false);
    expect(output.denied).toBe(true);
    expect(String(output.stderr)).toMatch(/outside this session's project root/);
  });

  test('a directory inside the project root is not refused', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'sub'));
    const plan: ExecSandboxPlan = { sandboxed: true, argvPrefix: [], boundary: '', network: 'disabled', escalationsGranted: [] };
    const policy: ExecRunPolicy = { sandbox: null, interaction: null, containment: null, workspaceRoot: root };
    expect(sandboxWorkspaceRefusal(policy, 'ls', plan, join(root, 'sub'))).toBeNull();
    expect(sandboxWorkspaceRefusal(policy, 'ls', plan, root)).toBeNull();
    expect(sandboxWorkspaceRefusal(policy, 'ls', plan, '/')?.denied).toBe(true);
    expect(sandboxWorkspaceRefusal(policy, 'ls', plan, join(root, '..'))?.denied).toBe(true);
  });

  test('network is shared only for a command line whose every command is on the allowlist', async () => {
    const root = tempRoot();
    const runtime = sandbox(['git']);
    const listed = await resolveRuntimeSandboxPlan(runtime, 'git fetch origin', root, root);
    expect(listed?.network).toBe('enabled');
    expect(listed?.argvPrefix).not.toContain('--unshare-net');
    const carried = await resolveRuntimeSandboxPlan(runtime, 'git status; curl http://x.example', root, root);
    expect(carried?.network).toBe('disabled');
    expect(carried?.argvPrefix).toContain('--unshare-net');
  });

  test('network stays off when an unlisted program rides along inside a listed command line', async () => {
    const root = tempRoot();
    const runtime = sandbox(['git']);
    for (const command of ['git fetch & node exfil.js', 'git "$(node b)"', 'git -c x=$(node b) a', 'git a >(node b)', 'git a <(node b)', 'git fetch <<EOF\n$(node b)\nEOF', 'git fetch <<-EOF\n`node b`\nEOF']) {
      const plan = await resolveRuntimeSandboxPlan(runtime, command, root, root);
      expect(plan?.network, command).toBe('disabled');
    }
    const listedOnly = await resolveRuntimeSandboxPlan(runtime, 'git fetch 2>&1 && git pull &> /dev/null', root, root);
    expect(listedOnly?.network).toBe('enabled');
    const quotedHeredoc = await resolveRuntimeSandboxPlan(runtime, "git fetch <<'EOF'\n$(node b)\nEOF", root, root);
    expect(quotedHeredoc?.network).toBe('enabled');
  });

  test('an unlisted command is not asked about: approval could not open the network for it', async () => {
    const root = tempRoot();
    let asked = 0;
    const runtime = sandbox(['git'], async () => { asked++; return true; });
    const plan = await resolveRuntimeSandboxPlan(runtime, 'curl https://x.example', root, root);
    expect(plan?.network).toBe('disabled');
    await brokerSandboxEscalation(runtime, plan, 'curl https://x.example', root);
    expect(asked).toBe(0);
  });

  test('a listed command that needs no network is neither asked about nor given it', async () => {
    const root = tempRoot();
    let asked = 0;
    const runtime = sandbox(['git'], async () => { asked++; return true; });
    const plan = await resolveRuntimeSandboxPlan(runtime, 'git log', root, root);
    expect(plan?.network).toBe('disabled');
    expect(plan?.argvPrefix).toContain('--unshare-net');
    await brokerSandboxEscalation(runtime, plan, 'git log', root);
    expect(asked).toBe(0);
  });

  test('a wildcard allowlist does not give a command that needs no network the host network', async () => {
    const root = tempRoot();
    let asked = 0;
    const runtime = sandbox(['*'], async () => { asked++; return true; });
    const plan = await resolveRuntimeSandboxPlan(runtime, 'ls', root, root);
    expect(plan?.network).toBe('disabled');
    await brokerSandboxEscalation(runtime, plan, 'ls', root);
    expect(asked).toBe(0);
  });

  test('a listed command is asked about once, because approval grants the network', async () => {
    const root = tempRoot();
    let asked = 0;
    const runtime = sandbox(['git'], async () => { asked++; return true; });
    const plan = await resolveRuntimeSandboxPlan(runtime, 'git fetch origin', root, root);
    await brokerSandboxEscalation(runtime, plan, 'git fetch origin', root);
    expect(asked).toBe(1);
  });
});

const LIVE_PTY = detectPtyAvailability(probePtyHost());
requireLiveHost('PTY', LIVE_PTY.available);
describe.skipIf(!LIVE_PTY.available)('an interactive run with no timeout (live PTY)', () => {
  test('a prompt nobody answers ends the run with the prompt named', async () => {
    const interaction: ExecInteractionRuntime = { availability: LIVE_PTY, quietWindowMs: 100, unansweredPromptLimitMs: 400 };
    const result = await runInteractiveCommand({
      cmdStr: 'printf "Continue? [y/n]: " > /dev/tty; sleep 30', cwd: undefined, env: process.env as Record<string, string>,
      timeoutMs: 0, startTime: Date.now(), sandboxArgv: [], interaction,
    });
    expect(result.timed_out).toBe(true);
    expect(result.pending_prompt).toBe('Continue? [y/n]:');
    expect(result.stderr).toMatch(/Stopped: no timeout_ms was set/);
  }, 20_000);

  test('a prompt the command moved past does not end a later quiet stretch', async () => {
    const interaction: ExecInteractionRuntime = { availability: LIVE_PTY, quietWindowMs: 100, unansweredPromptLimitMs: 1000 };
    const result = await runInteractiveCommand({
      cmdStr: 'printf "Continue? [y/n]: " > /dev/tty; sleep 0.5; echo carried-on; sleep 2.5; echo finished',
      cwd: undefined, env: process.env as Record<string, string>,
      timeoutMs: 0, startTime: Date.now(), sandboxArgv: [], interaction,
    });
    expect(result.timed_out).not.toBe(true);
    expect(result.stdout).toContain('finished');
    expect(result.pending_prompt).toBeUndefined();
  }, 20_000);
});
