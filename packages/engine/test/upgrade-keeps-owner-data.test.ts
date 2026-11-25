// Proves: Starting this release on the previous release's home loses or refuses the owner's approvals, remembered rules, budget, admin password, calendar connection or decision policy.
// Red when: A store's one-time carry-forward stops running or runs again: answered approvals left in approvals.json, remembered rules left in the per-program files, a ledger with unmarked amounts refused, the generated password file deleted at another user's sign-in, the calendar connection left under its earlier keys or not readable from the one Google connection, or a policy saved under an older name read as the default.
/**
 * Each row writes the previous release's form of one store into a scratch home
 * (the shapes 3.3.1 wrote), opens the real store as the daemon opens it, and
 * reads the owner's data back: the old form is gone only once the new form is
 * on disk, and a second open writes nothing (the carry-forward runs once).
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.ts';
import { SecretsManager, resolveSecretWriteScope } from '../platform/src/platform/config/secrets.ts';
import { UserPermissionRuleStore, ownerPermissionRulesPath, previousOwnerPermissionRuleFiles } from '../platform/src/platform/permissions/user-rule-store.ts';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.ts';
import { readPaymentsServiceConfig } from '../platform/src/platform/payments/payments-config.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { CalendarTokenStore, carryGoogleCalendarConnectionForward } from '../platform/src/platform/calendar/oauth-token-store.ts';
import { runDaemonBootGuarantees, releaseDaemonActivityLog } from '../platform/src/platform/daemon/facade-boot-guarantees.ts';
import { syntheticCredential } from '../platform/src/platform/utils/fixture-credentials.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = Date.now();
const DAY = new Date(NOW).toISOString().slice(0, 10);
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** A 3.3.1 home: the daemon's settings (a budget currency, a policy under its 3.2.0 name) and the owner's files. */
function home331() {
  const root = mkdtempSync(join(tmpdir(), 'gv-upgrade-331-'));
  roots.push(root);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  const daemonSettings = join(home, '.goodvibes', 'daemon', 'settings.json');
  write(daemonSettings, { judgment: { policy: 'Default - On' }, payments: { currency: 'EUR' } });
  const config = () => new ConfigManager({ configDir: join(home, '.goodvibes', 'tui'), workingDir: workspace, homeDir: home, surfaceRoot: 'goodvibes',
    daemonTierPath: daemonSettings, ownsDaemonTier: true });
  return { root, home, workspace, daemonSettings, config };
}

/** An approval as 3.3.1 kept it in approvals.json. */
function approval331(id: string, status: 'approved' | 'cancelled') {
  return {
    id, callId: `call-${id}`, sessionId: 'user-session', createdAt: NOW - 1000, updatedAt: NOW - 500, expiresAt: NOW + 3_600_000,
    audit: [{ id: `apra-${id}`, action: 'created', actor: 'approval-broker', actorSurface: 'service', createdAt: NOW - 1000 }],
    resolvedAt: NOW - 500, resolvedBy: 'shared-token', status,
    request: { callId: `call-${id}`, tool: 'exec', args: {}, category: 'execute',
      analysis: { classification: 'shell', riskLevel: 'high', summary: 'Execute shell command', reasons: [], target: 'echo hi', targetKind: 'command', surface: 'shell' } },
    metadata: { raisedVia: 'approvals.raise', raisedByPrincipal: 'shared-token', raisedByPrincipalKind: 'token', raisedBySurface: 'web',
      argumentsDigest: 'sha256:cacf52f1979d498258d9a4ccc880fda906ad947596a7022edeeaca1bac07c87f' },
    decision: { remember: false, approved: status === 'approved' },
  };
}

/** A remembered rule as 3.3.1 kept it in a program's own permission-rules.json. */
function rule331(id: string, command: string) {
  return { rule: { type: 'prefix', id, origin: 'user', effect: 'allow', toolPattern: 'exec', commandPrefixes: [`${command} `], exactCommands: [command],
    exactCommandMatch: 'command-class', description: `allow the ${command} command class` }, tier: 'command-class', tool: 'exec', createdAt: NOW - 1000 };
}

test('every kind of owner data a 3.3.1 home holds is read by this release, carried forward once, and never lost', async () => {
  const h = home331();
  const rows: Record<string, unknown> = {};

  // Approvals: 3.3.1's snapshot file beside the log the daemon opens.
  {
    const legacy = join(h.workspace, '.goodvibes', 'tui', 'control-plane', 'approvals.json');
    write(legacy, { approvals: [approval331('approval-answered', 'approved'), approval331('approval-cancelled', 'cancelled')] });
    const open = async () => { const broker = new ApprovalBroker({ storePath: `${legacy}l` }); await broker.start(); return broker; };
    const first = await open();
    const log = read(`${legacy}l`);
    const second = await open();
    rows['approvals'] = {
      kept: first.listApprovals().map((record) => `${record.id}:${record.status}`).sort(),
      newFormHolds: ['approval-answered', 'approval-cancelled'].every((id) => log?.includes(id) === true), oldFormGone: !existsSync(legacy),
      secondOpen: { same: read(`${legacy}l`) === log, kept: second.listApprovals().length },
    };
  }

  // Remembered rules: each program's file, merged into the shared one.
  {
    const config = h.config();
    const [tuiRules, agentRules] = previousOwnerPermissionRuleFiles(config);
    write(tuiRules!, { version: 1, rules: [rule331('rule-echo', 'echo')] });
    write(agentRules!, { version: 1, rules: [rule331('rule-git', 'git')] });
    const open = async () => {
      const store = new UserPermissionRuleStore(ownerPermissionRulesPath(config), { previousFiles: previousOwnerPermissionRuleFiles(config) });
      await store.awaitReady();
      return store;
    };
    const first = await open();
    const shared = read(ownerPermissionRulesPath(config));
    const second = await open();
    rows['rules'] = {
      kept: first.list().map((record) => record.rule.id).sort(),
      newFormHolds: ['rule-echo', 'rule-git'].every((id) => shared?.includes(id) === true), oldFormGone: !existsSync(tuiRules!) && !existsSync(agentRules!),
      secondOpen: { same: read(ownerPermissionRulesPath(config)) === shared, kept: second.list().length },
    };
  }

  // Budget: 3.3.1's ledger, amounts with no currency, in the daemon's control-plane folder.
  {
    const config = h.config();
    const ledger = join(h.home, '.goodvibes', 'daemon', 'control-plane', 'payments-budget.json');
    write(ledger, { version: 2,
      spend: [{ purchaseId: 'purchase-1', atMs: NOW - 1000, itemMinorUnits: 500, overageMinorUnits: 0, toleranceMinorUnits: 0, timezone: 'UTC', dayKey: DAY }],
      reservations: [{ id: 'purchase-2', dayKey: DAY, itemMinorUnits: 300, overageMinorUnits: 0, toleranceMinorUnits: 0, createdAtMs: NOW - 1000,
        expiresAtMs: NOW + 3_600_000, timezone: 'UTC', retainUntilSettled: true }] });
    const open = () => new DurableBudgetLedger(ledger, () => NOW, undefined, undefined, undefined, undefined, () => readPaymentsServiceConfig(config).budgetCurrency);
    const first = open();
    const onDisk = read(ledger);
    const second = open();
    // A refused ledger answers nothing; read it only when it opened, so a refusal shows in the row.
    const state = first.stopped() === null ? first.state() : { spend: [], reservations: [] };
    rows['budget'] = {
      stopped: first.stopped(),
      kept: [...state.spend.map((record) => `${record.purchaseId}:${record.itemMinorUnits}:${record.currency}`), ...state.reservations.map((record) => `${record.id}:${record.itemMinorUnits}:${record.currency}`)],
      newFormHolds: (JSON.parse(onDisk ?? '{}') as { spend?: { currency?: string }[] }).spend?.[0]?.currency,
      secondOpen: { same: read(ledger) === onDisk, stopped: second.stopped() },
    };
  }

  // The generated admin password: 3.3.1's user store (no bootstrap mark) and its credential file; another user signs in.
  {
    const users = join(h.home, '.goodvibes', 'tui', 'auth-users.json'), credential = join(h.home, '.goodvibes', 'tui', 'auth-bootstrap.txt');
    const generated = 'generated-admin-password-fixture';
    write(users, { version: 1, users: [
      { username: 'admin', passwordHash: 'dF6S06HPkXJL8esbnD4TSQ==:1024:1:1:QTh0smiLJIl4r31rQS1R/mwCgBbUqI8IEN3s6vRthY7BCRiulooQ0+ZbeF7SZqrtBybneDLjYsjWqtbb74n0xQ==', roles: ['admin'] },
      { username: 'sam', passwordHash: 'elQ2Oxi18EZhU6FfCoUWKg==:1024:1:1:OsSBQsgJwVetyv03cWNquk5XSMMKSqrt3s9feO+lKtBHaXRC/z0jbH9JzMWBTI51ZUZHOb7PrUrZjbuTXY4GXA==', roles: ['admin'] },
    ] });
    write(credential, `GoodVibes bootstrap auth\nusername=admin\npassword=${generated}\n`);
    // The daemon's sign-in: a user who is not the generated one signs in, then the stale-file check runs (operator-login.ts).
    const signInAsSam = () => {
      const auth = new UserAuthManager({ bootstrapFilePath: users, bootstrapCredentialPath: credential, scryptParams: { N: 1024, r: 1, p: 1 } });
      const signedIn = auth.authenticate('sam', 'sam-password-fixture');
      return { signedIn: signedIn.ok, retired: auth.retireStaleBootstrapCredential(), auth };
    };
    const first = signInAsSam();
    const marked = read(users);
    const second = signInAsSam();
    rows['admin password'] = {
      firstSignIn: { signedIn: first.signedIn, retired: first.retired },
      kept: read(credential)?.includes(`password=${generated}`) === true && second.auth.authenticate('admin', generated).ok === true,
      newFormHolds: (JSON.parse(marked ?? '{}') as { users?: { username: string; bootstrap?: boolean }[] }).users?.find((user) => user.username === 'admin')?.bootstrap,
      secondOpen: { same: read(users) === marked, retired: second.retired },
    };
  }

  // The calendar connection: 3.3.1 kept a Google connection made with /calendar connect under its own
  // token record with the account under a key beside it; the daemon's start moves it into the one Google
  // connection (its refresh token and account), where /calendar and the daemon's calendar read it.
  {
    // The store as the daemon's start reads it (facade-boot-guarantees.ts), each write filed where the daemon reads it.
    const store = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: h.home, projectRoot: h.workspace });
    const secrets = {
      get: async (key: string) => (await store.getStored(key))?.reveal('store-write') ?? null,
      set: (key: string, value: string) => store.set(key, value, { scope: resolveSecretWriteScope(key) }),
      delete: (key: string) => store.delete(key),
    };
    const tokenKey = daemonSecretKeyFor('calendar.google.tokens'), accountKey = daemonSecretKeyFor('calendar.google.account');
    const grantKey = daemonSecretKeyFor('google.oauth.refreshToken'), oneAccountKey = daemonSecretKeyFor('google.oauth.account');
    const refreshToken = syntheticCredential('1//', 'upgrade-refresh', 40);
    const account = { provider: 'google', accountId: 'google:owner', label: 'owner@example.com', scopes: ['calendar.readonly'], connectedAt: NOW - 1000 };
    await secrets.set(tokenKey, JSON.stringify({ accessToken: syntheticCredential('ya29.', 'upgrade-access', 40), refreshToken, tokenType: 'Bearer', expiresAt: NOW + 3_600_000 }));
    await secrets.set(accountKey, JSON.stringify(account));
    const carried = await carryGoogleCalendarConnectionForward(secrets);
    const first = await new CalendarTokenStore({ secrets, clock: () => NOW }).loadAccount('google');
    const stored = { grant: await secrets.get(grantKey), account: await secrets.get(oneAccountKey) };
    const carriedAgain = await carryGoogleCalendarConnectionForward(secrets);
    const second = await new CalendarTokenStore({ secrets, clock: () => NOW }).loadAccount('google');
    rows['calendar'] = {
      kept: first?.accountId, carried,
      newFormHolds: stored.grant === refreshToken, oldFormGone: (await secrets.get(tokenKey)) === null && (await secrets.get(accountKey)) === null,
      secondOpen: { carried: carriedAgain, same: (await secrets.get(grantKey)) === stored.grant && (await secrets.get(oneAccountKey)) === stored.account, kept: second?.accountId },
    };
  }

  // The decision policy: saved under its 3.2.0 name, which 3.3.1 read but never rewrote; the daemon's boot writes the current name.
  {
    const config = h.config();
    const boot = async (manager: ConfigManager) => {
      await runDaemonBootGuarantees(manager, { secretsManager: new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: h.home, projectRoot: h.workspace }),
        shellPaths: { workingDirectory: h.workspace, homeDirectory: h.home } });
      releaseDaemonActivityLog(manager);
    };
    const kept = config.get('judgment.policy');
    await boot(config);
    const onDisk = read(h.daemonSettings);
    const again = h.config();
    await boot(again);
    rows['decision policy'] = {
      kept, newFormHolds: onDisk?.includes('"Decision Model Only"') === true, oldFormGone: onDisk?.includes('Default - On') === false,
      secondOpen: { same: read(h.daemonSettings) === onDisk, kept: again.get('judgment.policy') },
    };
  }

  expect(rows).toEqual({
    approvals: { kept: ['approval-answered:approved', 'approval-cancelled:cancelled'], newFormHolds: true, oldFormGone: true, secondOpen: { same: true, kept: 2 } },
    rules: { kept: ['rule-echo', 'rule-git'], newFormHolds: true, oldFormGone: true, secondOpen: { same: true, kept: 2 } },
    budget: { stopped: null, kept: ['purchase-1:500:EUR', 'purchase-2:300:EUR'], newFormHolds: 'EUR', secondOpen: { same: true, stopped: null } },
    'admin password': { firstSignIn: { signedIn: true, retired: false }, kept: true, newFormHolds: true, secondOpen: { same: true, retired: false } },
    calendar: { kept: 'google:owner', carried: 'moved', newFormHolds: true, oldFormGone: true, secondOpen: { carried: 'nothing', same: true, kept: 'google:owner' } },
    'decision policy': { kept: 'Decision Model Only', newFormHolds: true, oldFormGone: true, secondOpen: { same: true, kept: 'Decision Model Only' } },
  });
});
