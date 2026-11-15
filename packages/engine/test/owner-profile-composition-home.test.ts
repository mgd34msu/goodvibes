/**
 * owner-profile-composition-home.test.ts, a runtime with an injected home
 * reads the profile under THAT home.
 *
 * The defect: `composeOwnerProfile` resolved the profile path through
 * `profile.path` → `--daemon-home` → `GOODVIBES_DAEMON_HOME` → the LOGIN user's
 * home, and nothing in that chain could see the home the runtime was actually
 * constructed with. A runtime given a scratch home, a test suite, an isolated
 * daemon, a second instance, therefore opened the profile of whoever was
 * logged in. That is how the daemon test suite came to read the owner's real
 * birthdays.
 *
 * The composition now takes `homeDir` and threads it into the resolver's own
 * `homeDir` option, in the position the login home occupied.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { redactDiagnosticText } from '../platform/src/platform/utils/redaction.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { composeOwnerProfile } from '../platform/src/platform/control-plane/routes/owner-profile-composition.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.ts';

// Profile writes ask the content-derivation reading whenever the process
// ledger holds untrusted text; another test file's reads must not reach these.
beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

/** The `profile.*` slice the composition reads, with everything at its default. */
function configFor(overrides: Record<string, unknown> = {}): {
  get(key: string): never;
  attachProfileFallback(reader: unknown): void;
} {
  const values: Record<string, unknown> = {
    'profile.path': '',
    'profile.enabled': true,
    'profile.reloadThrottleMs': 1000,
    'profile.autonomousWrites': false,
    'profile.discloseWrites': true,
    'profile.discloseClosedTierReads': false,
    'profile.consumerFallback': true,
    'profile.injectOpenTier': true,
    ...overrides,
  };
  return {
    get: ((key: string): unknown => values[key]) as (key: string) => never,
    attachProfileFallback: (): void => undefined,
  };
}

/** Write a profile document under `<home>/.goodvibes/daemon/`. */
function seedProfile(home: string, marker: string): string {
  const dir = join(home, '.goodvibes', 'daemon');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, `# Owner profile\n\n## Identity\nname: ${marker}\n`, 'utf-8');
  return path;
}

describe('owner-profile composition honours an injected home', () => {
  let savedDaemonHome: string | undefined;

  beforeEach(() => {
    savedDaemonHome = process.env['GOODVIBES_DAEMON_HOME'];
    delete process.env['GOODVIBES_DAEMON_HOME'];
  });

  afterEach(() => {
    if (savedDaemonHome === undefined) delete process.env['GOODVIBES_DAEMON_HOME'];
    else process.env['GOODVIBES_DAEMON_HOME'] = savedDaemonHome;
  });

  test('with the env unset, the profile resolves under the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home');
    const expected = seedProfile(home, 'injected-home-owner');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor(),
      homeDir: home,
    });

    try {
      expect(composed.store.path).toBe(expected);
      expect(composed.store.get('identity.name')?.value).toBe('injected-home-owner');
    } finally {
      composed.dispose();
    }
  });

  test('without an injected home, the tree GOODVIBES_HOME names wins over the login home', () => {
    const treeHome = makeProjectTempDir('gv-profile-tree-home');
    const expected = seedProfile(treeHome, 'tree-owner');
    const savedTree = process.env['GOODVIBES_HOME'];
    process.env['GOODVIBES_HOME'] = treeHome;
    try {
      const composed = composeOwnerProfile(new GatewayMethodCatalog(), { configManager: configFor() });
      try {
        expect(composed.store.path).toBe(expected);
        expect(composed.store.get('identity.name')?.value).toBe('tree-owner');
      } finally {
        composed.dispose();
      }
    } finally {
      if (savedTree === undefined) delete process.env['GOODVIBES_HOME'];
      else process.env['GOODVIBES_HOME'] = savedTree;
    }
  });

  test('an explicit profile.path still wins over the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home-override');
    seedProfile(home, 'not-this-one');
    const elsewhere = join(makeProjectTempDir('gv-profile-elsewhere'), 'chosen-profile.md');
    mkdirSync(join(elsewhere, '..'), { recursive: true });
    writeFileSync(elsewhere, '# Owner profile\n', 'utf-8');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor({ 'profile.path': elsewhere }),
      homeDir: home,
    });

    try {
      expect(composed.store.path).toBe(elsewhere);
    } finally {
      composed.dispose();
    }
  });

  test('--daemon-home still wins over the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home-loses');
    seedProfile(home, 'not-this-one');
    const daemonHome = makeProjectTempDir('gv-profile-daemon-home');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor(),
      daemonHome,
      homeDir: home,
    });

    try {
      expect(composed.store.path.startsWith(daemonHome)).toBe(true);
    } finally {
      composed.dispose();
    }
  });
});

describe('owner-profile composition registers the account identity for egress redaction', () => {
  // `redactSensitiveData` masks all text it cannot prove safe, registered or not, so
  // it cannot show the registration. The diagnostic path masks only what is known.
  const account = userInfo().username;
  const inHome = join(homedir(), 'work', 'notes.txt');
  const named = `signed in as ${account} today`;

  test('the running account\'s home and login name are masked while composed, and visible again after dispose', () => {
    expect(redactDiagnosticText(inHome)).toBe(inHome);
    expect(redactDiagnosticText(named)).toBe(named);

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), { configManager: configFor(), homeDir: makeProjectTempDir('gv-profile-identity') });
    try {
      expect(redactDiagnosticText(inHome)).not.toContain(homedir());
      expect(redactDiagnosticText(inHome)).toContain('[REDACTED]');
      expect(redactDiagnosticText(named)).toBe('signed in as [REDACTED] today');
    } finally {
      composed.dispose();
    }

    expect(redactDiagnosticText(inHome)).toBe(inHome);
    expect(redactDiagnosticText(named)).toBe(named);
  });
});
