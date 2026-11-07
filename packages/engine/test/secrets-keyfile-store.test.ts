import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager, SecretStoreUnreadableError } from '../sdk/src/platform/config/secrets.js';

describe('SecretsManager keyfile-encrypted store', () => {
  const scratchDirs: string[] = [];
  function makeScratch(): { home: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), 'gv-secrets-keyfile-'));
    scratchDirs.push(root);
    const home = join(root, 'home'), project = join(root, 'project');
    mkdirSync(home, { recursive: true }); mkdirSync(project, { recursive: true });
    return { home, project };
  }
  function makeManager(dirs: { home: string; project: string }): SecretsManager {
    return new SecretsManager({ projectRoot: dirs.project, globalHome: dirs.home, surfaceRoot: 'testsurface', policy: 'require_secure' });
  }
  function userStorePath(home: string): string { return join(home, '.goodvibes', 'testsurface', 'secrets.enc'); }
  afterEach(() => { for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  test('writes the versioned envelope with a private random keyfile', async () => {
    const dirs = makeScratch(); const manager = makeManager(dirs);
    await manager.set('API_TOKEN', 'current-value', { scope: 'user', medium: 'secure' });
    expect(await manager.get('API_TOKEN')).toBe('current-value');
    const envelope = JSON.parse(readFileSync(userStorePath(dirs.home), 'utf8'));
    expect(envelope.version).toBe(2); expect(envelope.keyId).toBeUndefined();
    expect(readFileSync(join(dirs.home, '.goodvibes', 'secrets.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the same keyfile and store remain readable after moving the home directory', async () => {
    const dirs = makeScratch();
    await makeManager(dirs).set('API_TOKEN', 'portable-value', { scope: 'user', medium: 'secure' });
    const moved = dirs.home + '-moved'; renameSync(dirs.home, moved);
    expect(await makeManager({ ...dirs, home: moved }).get('API_TOKEN')).toBe('portable-value');
  });

  test.each([undefined, 99])('unsupported format %s refuses reads and writes without modifying the file', async version => {
    const dirs = makeScratch(); const manager = makeManager(dirs);
    await manager.set('API_TOKEN', 'preserve-me', { scope: 'user', medium: 'secure' });
    const path = userStorePath(dirs.home); const envelope = JSON.parse(readFileSync(path, 'utf8'));
    if (version === undefined) delete envelope.version; else envelope.version = version;
    const before = JSON.stringify(envelope); writeFileSync(path, before);
    const reader = makeManager(dirs);
    expect(await reader.get('API_TOKEN')).toBeNull();
    await expect(reader.set('NEW_KEY', 'value', { scope: 'user', medium: 'secure' })).rejects.toBeInstanceOf(SecretStoreUnreadableError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a tampered keyfile-format store refuses writes and keeps its bytes', async () => {
    const dirs = makeScratch(); const manager = makeManager(dirs);
    await manager.set('API_TOKEN', 'value-one', { scope: 'user', medium: 'secure' });
    const path = userStorePath(dirs.home); const envelope = JSON.parse(readFileSync(path, 'utf8')) as { data: string };
    envelope.data = envelope.data.replace(/^../, envelope.data.startsWith('00') ? '11' : '00');
    const before = JSON.stringify(envelope); writeFileSync(path, before);
    const reader = makeManager(dirs);
    expect(await reader.get('API_TOKEN')).toBeNull();
    await expect(reader.set('API_TOKEN', 'value-two', { scope: 'user', medium: 'secure' })).rejects.toBeInstanceOf(SecretStoreUnreadableError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a missing store file is a legitimately empty store and accepts writes', async () => {
    const manager = makeManager(makeScratch()); expect(await manager.get('API_TOKEN')).toBeNull();
    await manager.set('API_TOKEN', 'fresh', { scope: 'user', medium: 'secure' });
    expect(await manager.get('API_TOKEN')).toBe('fresh');
  });

  test('inspect reports an unsupported store as existing and unreadable', async () => {
    const dirs = makeScratch(); const path = userStorePath(dirs.home);
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify({ iv: '00', tag: '00', data: 'unrecognized' }));
    const review = await makeManager(dirs).inspect(); const location = review.locations.find(entry => entry.path === path);
    expect(location?.exists).toBe(true); expect(location?.readable).toBe(false);
    expect(review.warnings.some(warning => warning.includes(path))).toBe(true);
  });

  test('keyfile, store file and keyfile directory carry restrictive permissions', async () => {
    const dirs = makeScratch(); await makeManager(dirs).set('API_TOKEN', 'value', { scope: 'user', medium: 'secure' });
    expect(statSync(join(dirs.home, '.goodvibes', 'secrets.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dirs.home, '.goodvibes')).mode & 0o777).toBe(0o700);
    expect(statSync(userStorePath(dirs.home)).mode & 0o777).toBe(0o600);
  });

  test('plaintext writes also land with owner-only file permissions', async () => {
    const dirs = makeScratch();
    const manager = new SecretsManager({ projectRoot: dirs.project, globalHome: dirs.home, surfaceRoot: 'testsurface', policy: 'plaintext_allowed' });
    await manager.set('API_TOKEN', 'value', { scope: 'user', medium: 'plaintext' });
    expect(statSync(join(dirs.home, '.goodvibes', 'testsurface.secrets.json')).mode & 0o777).toBe(0o600);
  });

  test('current-format secret updates preserve neighboring values', async () => {
    const dirs = makeScratch(); const manager = makeManager(dirs);
    await manager.set('KEEP_ME', 'still-here', { scope: 'user', medium: 'secure' });
    await manager.set('REPLACE_ME', 'old', { scope: 'user', medium: 'secure' });
    await manager.set('REPLACE_ME', 'new', { scope: 'user', medium: 'secure' });
    const reader = makeManager(dirs); expect(await reader.get('KEEP_ME')).toBe('still-here');
    expect(await reader.get('REPLACE_ME')).toBe('new');
  });
});

/**
 * The daemon tier: a third scope with a third directory behind it.
 *
 * The property under test is that the scope is a real storage location and not
 * a label, a daemon-scoped write must be readable by a manager rooted in a
 * different project directory and a different surface, because that is exactly
 * what "the daemon has one home whichever product launched it" means.
 */
describe('SecretsManager daemon scope', () => {
  const scratchDirs: string[] = [];

  function makeScratch(): { home: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), 'gv-secrets-daemon-'));
    scratchDirs.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    return { home, project };
  }

  function makeManager(
    dirs: { home: string; project: string },
    surfaceRoot = 'testsurface',
    projectRoot = dirs.project,
  ): SecretsManager {
    return new SecretsManager({
      projectRoot,
      globalHome: dirs.home,
      surfaceRoot,
      policy: 'require_secure',
    });
  }

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('a daemon-scoped write lands in the daemon home, not in a surface silo', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs);
    await manager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-group-token', { scope: 'daemon' });

    const daemonStore = join(dirs.home, '.goodvibes', 'daemon', 'secrets.enc');
    expect(existsSync(daemonStore)).toBe(true);
    expect(existsSync(join(dirs.home, '.goodvibes', 'testsurface', 'secrets.enc'))).toBe(false);
    expect(existsSync(join(dirs.project, '.goodvibes', 'testsurface', 'secrets.enc'))).toBe(false);
    expect(statSync(daemonStore).mode & 0o777).toBe(0o600);
    // The value is encrypted at rest like every other tier.
    expect(readFileSync(daemonStore, 'utf-8')).not.toContain('xoxb-group-token');
  });

  test('a credential a daemon-owned config path names goes to the daemon tier without being asked', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs);
    // No scope named. `surfaces.slack.botToken` is daemon-owned, so this is.
    await manager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-derived');
    // A model-provider key is daemon-needed too, and by a different route: the
    // DAEMON runs the model, so a key only one client can read means the daemon
    // cannot answer at all. It is declared in credential-scope-registry.ts,
    // derived from the provider catalog rather than hand-listed.
    await manager.set('ANTHROPIC_API_KEY', 'sk-personal');
    // A name nothing derives and nothing declares keeps the historical default.
    await manager.set('MY_OWN_SCRATCH_KEY', 'value');

    const records = await manager.listDetailed();
    const stored = (key: string): string | undefined =>
      records.find((record) => record.key === key && record.source !== 'env')?.scope;
    expect(stored('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('daemon');
    expect(stored('ANTHROPIC_API_KEY')).toBe('daemon');
    expect(stored('MY_OWN_SCRATCH_KEY')).toBe('project');
  });

  test('the daemon tier is read by another surface and another project directory', async () => {
    const dirs = makeScratch();
    await makeManager(dirs, 'tui').set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-one-home', { scope: 'daemon' });

    const elsewhere = join(dirs.project, 'nested', 'checkout');
    mkdirSync(elsewhere, { recursive: true });
    const otherProduct = makeManager(dirs, 'agent', elsewhere);
    expect(await otherProduct.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('xoxb-one-home');
  });

  test('a stale surface-silo copy does not beat the daemon tier', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs);
    await manager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-stale', { scope: 'project' });
    await manager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-current', { scope: 'daemon' });
    expect(await manager.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('xoxb-current');
  });

  test('deleting at daemon scope leaves the other tiers alone', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs);
    await manager.set('SHARED_NAME', 'from-user', { scope: 'user' });
    await manager.set('SHARED_NAME', 'from-daemon', { scope: 'daemon' });
    await manager.delete('SHARED_NAME', { scope: 'daemon' });
    expect(await manager.get('SHARED_NAME')).toBe('from-user');
  });

  test('an explicit daemon home overrides the default location', async () => {
    const dirs = makeScratch();
    const daemonHome = join(dirs.home, 'elsewhere', 'daemon-home');
    const manager = new SecretsManager({
      projectRoot: dirs.project,
      globalHome: dirs.home,
      surfaceRoot: 'testsurface',
      policy: 'require_secure',
      daemonHome,
    });
    await manager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-moved', { scope: 'daemon' });
    expect(existsSync(join(daemonHome, 'secrets.enc'))).toBe(true);
    expect(existsSync(join(dirs.home, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(false);
    expect(await manager.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('xoxb-moved');
  });
});
