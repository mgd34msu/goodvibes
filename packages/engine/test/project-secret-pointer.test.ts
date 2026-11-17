/**
 * A repository's own secret store cannot read the owner's credentials. A
 * pointer stored there is followed only to another key of the same project
 * store, never into the owner's store or environment, and a confirmation
 * (`/secrets trust`) holds only for the value that was confirmed.
 *
 * Real secret store and confirmation record over a temp home and a temp repository.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';

let dir: string;
let home: string;
let projectFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-project-secret-'));
  home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.goodvibes'), { recursive: true });
  mkdirSync(join(home, '.goodvibes'), { recursive: true });
  projectFile = join(repo, '.goodvibes', 'agent.secrets.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const open = () => new SecretsManager({
  projectRoot: join(dir, 'repo'), globalHome: home, surfaceRoot: 'agent', policy: 'plaintext_allowed', plaintextProjectFilePath: projectFile,
});
const repository = (values: Record<string, string>) => writeFileSync(projectFile, JSON.stringify(values));

test('a confirmed project pointer never resolves to the owner\'s own credential', async () => {
  const secrets = open();
  await secrets.set('GV_OWNER_FIXTURE_KEY', 'owner-credential', { scope: 'user' });
  repository({ GV_REPO_FIXTURE_TOKEN: 'goodvibes://secrets/goodvibes/GV_OWNER_FIXTURE_KEY' });
  const confirmed = secrets.confirmProjectSecret('GV_REPO_FIXTURE_TOKEN');
  expect(confirmed.map((entry) => entry.pointsAt)).toEqual(['goodvibes://secrets/goodvibes/GV_OWNER_FIXTURE_KEY']);
  expect(await secrets.get('GV_REPO_FIXTURE_TOKEN')).toBeNull();
  expect(secrets.resolveLocalCredentialSnapshot('GV_REPO_FIXTURE_TOKEN').state).not.toBe('resolved');
});

test('a confirmation holds only for the value confirmed; a pointer inside the project store still resolves', async () => {
  const secrets = open();
  repository({ GV_REPO_FIXTURE_A: 'goodvibes://secrets/goodvibes/GV_REPO_FIXTURE_B', GV_REPO_FIXTURE_B: 'repo-value' });
  secrets.confirmProjectSecret('GV_REPO_FIXTURE_A');
  secrets.confirmProjectSecret('GV_REPO_FIXTURE_B');
  expect(await secrets.get('GV_REPO_FIXTURE_A')).toBe('repo-value');
  repository({ GV_REPO_FIXTURE_A: 'goodvibes://secrets/goodvibes/GV_REPO_FIXTURE_B', GV_REPO_FIXTURE_B: 'changed-by-a-pull' });
  const reopened = open();
  expect(await reopened.get('GV_REPO_FIXTURE_B')).toBeNull();
  expect(await reopened.get('GV_REPO_FIXTURE_A')).toBeNull();
});
