// Proves: A secret reference, which can arrive in a repository or an imported file, cannot choose the program that runs or the server a token is sent to, and resolves only from the store it names.
// Red when: A reference to the local store falls back to the environment, a reference's own fields choose the program, data directory, session, server or token, or a failing provider's partial output reaches the error or is used as the credential.
/**
 * A secret reference resolves only from the store it names, and only through
 * the program, server and token variable the owner's own settings name. A
 * reference is data that can arrive in a repository or an imported file, so
 * nothing in it may choose a program to run or a server to hand a token to.
 * A reference that fails to resolve, or is mistyped, yields no credential:
 * neither the provider's output nor the reference text is used in its place.
 *
 * The password-manager programs are outside the product; the command runner
 * records what the resolver asked to run and answers as the program would.
 */
import { describe, expect, test } from 'bun:test';
import { resolveSecretRef, type SecretCommandRunner, type SecretProviderHostConfig } from '../platform/src/platform/config/secret-refs.ts';
import { resolveSecretInput } from '../platform/src/platform/config/secret-ref-refusal.ts';

interface Ran { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }

function recordingRunner(stdout: string, exitCode = 0): { readonly runner: SecretCommandRunner; readonly ran: Ran[] } {
  const ran: Ran[] = [];
  const runner: SecretCommandRunner = async (command, args, options) => {
    ran.push({ command, args: [...args], env: { ...(options?.env ?? {}) } });
    return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'provider unavailable' };
  };
  return { runner, ran };
}

const OWNER: SecretProviderHostConfig = {
  onePassword: { cli: '/opt/owner/op' },
  bitwarden: { cli: '/opt/owner/bw' },
  bitwardenSecretsManager: { cli: '/opt/owner/bws', serverUrl: 'https://owner-vault.example' },
};

describe('a reference resolves from the store it names', () => {
  test('an env reference reads the environment; a local reference reads only the local store', async () => {
    const previous = process.env['GV_SECRET_REF_FIXTURE'];
    process.env['GV_SECRET_REF_FIXTURE'] = 'from-environment';
    try {
      expect((await resolveSecretRef('goodvibes://secrets/env/GV_SECRET_REF_FIXTURE')).value).toBe('from-environment');
      const local = await resolveSecretRef('goodvibes://secrets/goodvibes/GV_SECRET_REF_FIXTURE', {
        resolveLocalSecret: async (key) => (key === 'GV_SECRET_REF_FIXTURE' ? 'from-local-store' : null),
      });
      expect(local.value).toBe('from-local-store');
      // With no local store there is no answer: the environment variable of the same name is not read instead.
      await expect(resolveSecretRef('goodvibes://secrets/goodvibes/GV_SECRET_REF_FIXTURE')).rejects.toThrow();
      expect(await resolveSecretInput('goodvibes://secrets/goodvibes/GV_SECRET_REF_FIXTURE')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env['GV_SECRET_REF_FIXTURE'];
      else process.env['GV_SECRET_REF_FIXTURE'] = previous;
    }
  });
});

describe('a reference cannot choose the program, server or token variable', () => {
  test('1Password: the owner\'s program runs, whatever program the reference names', async () => {
    const { runner, ran } = recordingRunner('op-secret');
    const value = await resolveSecretInput('goodvibes://secrets/1password?vault=V&item=I&field=F&cli=%2Ftmp%2Fplanted', { runCommand: runner, providers: OWNER });
    expect(value).toBe('op-secret');
    expect(ran.map((call) => call.command)).toEqual(['/opt/owner/op']);
    expect(JSON.stringify(ran)).not.toContain('/tmp/planted');
  });

  test('Bitwarden: the owner\'s program runs and no data directory or session variable comes from the reference', async () => {
    const previous = process.env['GV_PLANTED_SESSION'];
    process.env['GV_PLANTED_SESSION'] = 'planted-session-token';
    try {
      const { runner, ran } = recordingRunner('bw-secret');
      const value = await resolveSecretInput(
        'goodvibes://secrets/bitwarden/item-1/password?cli=%2Ftmp%2Fplanted&appDataDir=%2Ftmp%2Fplanted-data&sessionEnv=GV_PLANTED_SESSION&syncBeforeRead=false',
        { runCommand: runner, providers: OWNER },
      );
      expect(value).toBe('bw-secret');
      expect(ran.length).toBeGreaterThan(0);
      for (const call of ran) expect(call.command).toBe('/opt/owner/bw');
      const sent = JSON.stringify(ran);
      expect(sent).not.toContain('/tmp/planted');
      expect(sent).not.toContain('planted-session-token');
    } finally {
      if (previous === undefined) delete process.env['GV_PLANTED_SESSION'];
      else process.env['GV_PLANTED_SESSION'] = previous;
    }
  });

  test('Bitwarden Secrets Manager: the token goes only to the owner\'s server, through the owner\'s program', async () => {
    const previous = process.env['GV_PLANTED_TOKEN'];
    process.env['GV_PLANTED_TOKEN'] = 'planted-access-token';
    try {
      const { runner, ran } = recordingRunner(JSON.stringify({ value: 'bws-secret' }));
      const value = await resolveSecretInput(
        'goodvibes://secrets/bws/secret-123?serverUrl=https%3A%2F%2Fattacker.example&cli=%2Ftmp%2Fplanted&accessTokenEnv=GV_PLANTED_TOKEN&configFile=%2Ftmp%2Fplanted.conf',
        { runCommand: runner, providers: OWNER },
      );
      expect(value).toBe('bws-secret');
      expect(ran).toHaveLength(1);
      expect(ran[0]!.command).toBe('/opt/owner/bws');
      const serverAt = ran[0]!.args.indexOf('--server-url');
      expect(ran[0]!.args[serverAt + 1]).toBe('https://owner-vault.example');
      const sent = JSON.stringify(ran);
      expect(sent).not.toContain('attacker.example');
      expect(sent).not.toContain('/tmp/planted');
      expect(sent).not.toContain('planted-access-token');
    } finally {
      if (previous === undefined) delete process.env['GV_PLANTED_TOKEN'];
      else process.env['GV_PLANTED_TOKEN'] = previous;
    }
  });
});

describe('a failed or mistyped reference yields no credential', () => {
  test('a provider that fails yields nothing, and its output never reaches the error', async () => {
    const { runner } = recordingRunner('half-printed-secret', 2);
    const failure = await resolveSecretRef({ source: 'exec', command: 'secret-tool' }, { runCommand: runner }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBeDefined();
    expect(failure).not.toContain('half-printed-secret');
    expect(await resolveSecretInput({ source: 'exec', command: 'secret-tool' }, { runCommand: runner })).toBeNull();
  });
});
