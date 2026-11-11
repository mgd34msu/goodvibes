import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('only failed Ubuntu22 sandbox package installs use the signed fallback before unchanged real host checks', () => {
  const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { 'runs-on'?: string; steps?: Array<{ name?: string; if?: string; run?: string }>;
      strategy?: { matrix: { include?: Array<{ platform: string; runner: string }>; lane?: string[] } } }>;
  };
  const matches = Object.entries(workflow.jobs).flatMap(([job, value]) => (value.steps ?? []).filter(step => step.run?.includes('ubuntu22_sandbox_prerequisites.py')).map(step => ({ job, value, step })));
  expect(matches.map(match => match.job)).toEqual(['daemon-native', 'daemon-native-execution', 'exec-containment-proof']);
  for (const { step } of matches) {
    expect(step.run).toContain('if verify_host; then\n  exit 0\nfi');
    expect(step.run).toContain('if ! sudo -n timeout --signal=KILL 90s apt-get');
    expect(step.run).toMatch(/then\n  python3 \.github\/scripts\/ubuntu22_sandbox_prerequisites\.py bubblewrap(?: util-linux)?\nfi\nverify_host\n/);
    expect(step.run).not.toMatch(/--error-on=any update|allow-unauthenticated|trusted=yes|resolv\.conf|sysctl|apparmor/);
  }
  expect(matches[0]!.value['runs-on']).toBe('ubuntu-22.04');
  expect(matches[1]!.step.if).toBe("matrix.platform == 'linux'");
  expect(matches[1]!.value.strategy?.matrix.include?.filter(value => value.platform === 'linux').map(value => value.runner)).toEqual(['ubuntu-22.04-arm']);
  expect(matches[2]!.value['runs-on']).toBe('ubuntu-22.04');
  expect(matches[2]!.value.strategy?.matrix.lane).toEqual(['tools', 'direct-exec', 'repl', 'graph-runtime', 'agent-posture', 'repair', 'repair-runtime']);
});

test('the actual fallback CLI preserves signed acquisition, finite failures, no retry, package scope and owned cleanup', () => {
  const source = String.raw`
import contextlib, io, json, pathlib, runpy, subprocess, sys, tempfile
from unittest.mock import patch
helper = sys.argv[1]
original_read = pathlib.Path.read_text
original_is_file = pathlib.Path.is_file
cases = [('amd64', 'success', ('bubblewrap', 'util-linux')), ('arm64', 'success', ('bubblewrap', 'util-linux')),
         ('amd64', 'success', ('bubblewrap',)), ('amd64', 'signature', ('bubblewrap',)),
         ('arm64', 'integrity', ('bubblewrap',)), ('amd64', 'cleanup', ('bubblewrap',)),
         ('amd64', 'missing-keyring', ('bubblewrap',)), ('amd64', 'other-os', ('bubblewrap',)),
         ('amd64', 'success', ('unapproved-package',))]
for arch, scenario, packages in cases:
    calls = []
    def read(path, *args, **kwargs):
        if str(path) == '/etc/os-release':
            return 'ID=ubuntu\nVERSION_CODENAME=' + ('noble' if scenario == 'other-os' else 'jammy') + '\n'
        return original_read(path, *args, **kwargs)
    def is_file(path):
        return scenario != 'missing-keyring' if str(path) == '/usr/share/keyrings/ubuntu-archive-keyring.gpg' else original_is_file(path)
    def process(argv, stdout, stderr, check):
        assert check is False
        calls.append(argv)
        code, output = 0, ''
        if 'dpkg' in argv:
            output = arch + '\n'
        elif 'apt-get' in argv:
            assert argv[:5] == ['sudo', '-n', 'timeout', '--signal=KILL', '90s']
            options = argv[argv.index('apt-get') + 1:]
            assert 'Acquire::AllowInsecureRepositories=false' in options
            assert 'Acquire::AllowDowngradeToInsecureRepositories=false' in options
            assert 'APT::Get::AllowUnauthenticated=false' in options
            assert 'Dir::Etc::sourceparts=-' in options
            assert 'Acquire::Retries=0' in options
            source_path = next(value.split('=', 1)[1] for value in options if value.startswith('Dir::Etc::sourcelist='))
            mirror = 'https://mirrors.edge.kernel.org/ubuntu' if arch == 'amd64' else 'https://mirrors.mit.edu/ubuntu-ports'
            assert original_read(pathlib.Path(source_path)) == ''.join('deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ' + mirror + ' ' + suite + ' main\n' for suite in ('jammy', 'jammy-updates', 'jammy-security'))
            if 'update' in options:
                assert options[-2:] == ['--error-on=any', 'update']
                if scenario == 'signature': code, output = 100, 'GPG error private-sentinel'
            else:
                assert options[-len(packages):] == list(packages)
                assert options[options.index('install'):options.index('install') + 3] == ['install', '--yes', '--no-install-recommends']
                if scenario == 'integrity': code, output = 100, 'Hash Sum mismatch private-sentinel'
        elif 'rm' in argv:
            assert argv[argv.index('rm'):] == ['rm', '-rf', '--', argv[-1]]
            assert pathlib.Path(argv[-1]).name == 'lists'
            if scenario == 'cleanup': code = 1
        else:
            raise AssertionError('Unexpected process: no DNS, proxy or host security changes allowed')
        stdout.write(output.encode())
        return subprocess.CompletedProcess(argv, code)
    with tempfile.TemporaryDirectory() as root, patch.dict('os.environ', {'RUNNER_TEMP': root}), patch.object(pathlib.Path, 'read_text', read), patch.object(pathlib.Path, 'is_file', is_file), patch.object(subprocess, 'run', process), patch.object(sys, 'argv', [helper, *packages]):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try: runpy.run_path(helper, run_name='__main__')
            except SystemExit as error: exit_code = error.code
        result = json.loads(output.getvalue())
        assert 'private-sentinel' not in output.getvalue()
        accepted = scenario == 'success' and packages[0] == 'bubblewrap'
        assert exit_code == (0 if accepted else 1)
        apt_calls = [call for call in calls if 'apt-get' in call]
        if accepted:
            assert result['aptVerified'] is True and len(apt_calls) == 2
        elif scenario == 'signature':
            assert result['aptVerified'] is False and len(apt_calls) == 1
            assert result['apt']['observations'][0]['kind'] == 'signature-refused'
        elif scenario == 'integrity':
            assert result['aptVerified'] is False and len(apt_calls) == 2
            assert result['apt']['observations'][-1]['kind'] == 'integrity-refused'
        else:
            assert 'error' in result
        if apt_calls:
            assert 'rm' in calls[-1]
        assert list(pathlib.Path(root).iterdir()) == []
print('9 actual CLI protocol controls passed without invoking APT or sudo.')
`;
  const result = spawnSync('python3', ['-c', source, resolve(import.meta.dir, '../.github/scripts/ubuntu22_sandbox_prerequisites.py')], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('9 actual CLI protocol controls passed without invoking APT or sudo.');
});
