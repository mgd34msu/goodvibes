/**
 * Durable permission rules keep the reach the owner gave them: a rule made
 * with no project is not saved as a global one, a project-scoped rule is
 * written where an older reader will not apply it everywhere, two processes
 * on one rules file do not undo each other, and a session answer to a read
 * holds for the single-path questions search tools ask.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDurableRuleForDecision, sessionApprovalKey } from '../platform/src/platform/permissions/approval-rules.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { UserPermissionRuleStore, type StoredUserPermissionRule } from '../platform/src/platform/permissions/user-rule-store.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

const classic = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rulesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-rule-scope-'));
  dirs.push(dir);
  return join(dir, 'rules.json');
}

function record(id: string, project?: string): StoredUserPermissionRule {
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args: { commands: [{ cmd: 'git status' }] }, tier: 'tool', effect: 'allow' })!;
  return { rule: { ...rule, id }, createdAt: 1, tier: 'tool', tool: 'exec', ...(project ? { project } : {}) };
}

interface Reply { approved: boolean; rememberTier: 'session' | 'tool' | 'path' }
function manager(directory: string | null, store?: UserPermissionRuleStore) {
  const config = {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => directory,
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as unknown as PermissionConfigReader;
  const permissions = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, store ?? null);
  const remember = (tool: string, args: Record<string, unknown>, reply: Reply) =>
    (permissions as unknown as { rememberReply(t: string, a: Record<string, unknown>, r: Reply, m: undefined): Promise<string | undefined> })
      .rememberReply(tool, args, reply, undefined);
  return { permissions, remember };
}

describe('remembering with no project', () => {
  test('a durable choice is refused instead of being saved as a rule for every project', async () => {
    const store = new UserPermissionRuleStore(rulesFile());
    await store.init();
    const { remember } = manager(null, store);
    const message = await remember('exec', { commands: [{ cmd: 'git status' }] }, { approved: true, rememberTier: 'tool' });
    expect(message).toContain('not saved');
    expect(message).toContain('no project');
    expect(store.list()).toEqual([]);
  });

  test('with a project the rule carries it', async () => {
    const store = new UserPermissionRuleStore(rulesFile());
    await store.init();
    const { remember } = manager('/work/project-a', store);
    expect(await remember('exec', { commands: [{ cmd: 'git status' }] }, { approved: true, rememberTier: 'tool' })).toBeUndefined();
    expect(store.list()[0]?.project).toBe('/work/project-a');
  });
});

describe('rule file format', () => {
  test('a project-scoped rule is kept out of `rules`, which an earlier release reads as global', async () => {
    const path = rulesFile();
    const store = new UserPermissionRuleStore(path);
    await store.init();
    await store.remember(record('scoped', '/work/project-a'));
    await store.remember(record('global'));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { rules: StoredUserPermissionRule[]; projectRules: StoredUserPermissionRule[] };
    expect(onDisk.rules.map((r) => r.rule.id)).toEqual(['global']);
    expect(onDisk.projectRules.map((r) => r.rule.id)).toEqual(['scoped']);

    const reopened = new UserPermissionRuleStore(path);
    await reopened.init();
    expect(reopened.rules('/work/project-a').map((r) => r.id).sort()).toEqual(['global', 'scoped']);
    expect(reopened.rules('/work/project-b').map((r) => r.id)).toEqual(['global']);
  });
});

describe('two processes on one rules file', () => {
  test('a rule one deletes is not written back by the other, and a rule one adds is kept', async () => {
    const path = rulesFile();
    const seed = new UserPermissionRuleStore(path);
    await seed.init();
    await seed.add(record('revoked'));

    const a = new UserPermissionRuleStore(path);
    const b = new UserPermissionRuleStore(path);
    await a.init(); await b.init();
    expect(b.rules().map((r) => r.id)).toEqual(['revoked']);

    expect(await a.delete('revoked')).toBe(true);
    await b.remember(record('added-by-b'));

    const third = new UserPermissionRuleStore(path);
    await third.init();
    expect(third.list().map((r) => r.rule.id)).toEqual(['added-by-b']);
    // The writer that held the revoked rule stops matching it as well.
    expect(b.rules().map((r) => r.id)).toEqual([]);

    await a.remember(record('added-by-a'));
    const afterA = new UserPermissionRuleStore(path);
    await afterA.init();
    expect(afterA.list().map((r) => r.rule.id).sort()).toEqual(['added-by-a', 'added-by-b']);
  });
});

describe('a reader that never writes', () => {
  test('stops matching a rule another process deleted and starts matching one it added', async () => {
    const path = rulesFile();
    const seed = new UserPermissionRuleStore(path);
    await seed.init();
    await seed.add(record('revoked'));

    const writer = new UserPermissionRuleStore(path);
    const reader = new UserPermissionRuleStore(path);
    await writer.init(); await reader.init();
    const revisionBefore = reader.getPublicationRevision();
    expect(reader.rules().map((r) => r.id)).toEqual(['revoked']);

    expect(await writer.delete('revoked')).toBe(true);
    expect(reader.rules().map((r) => r.id)).toEqual([]);
    expect(reader.getPublicationRevision()).toBeGreaterThan(revisionBefore);

    await writer.remember(record('granted-later'));
    expect(reader.rememberedRules().map((r) => r.id)).toEqual(['granted-later']);
  });

  test('keeps what it has when the file it is told changed cannot be read', async () => {
    const path = rulesFile();
    const seed = new UserPermissionRuleStore(path);
    await seed.init();
    await seed.add(record('kept'));
    const reader = new UserPermissionRuleStore(path);
    await reader.init();
    writeFileSync(path, '{ not json');
    expect(reader.rules().map((r) => r.id)).toEqual(['kept']);
  });
});

describe('a rules file that could not be read', () => {
  test('add and delete refuse instead of replacing or ignoring it', async () => {
    const path = rulesFile();
    writeFileSync(path, '{ not json');
    const store = new UserPermissionRuleStore(path);
    await store.init();
    await expect(store.add(record('x'))).rejects.toThrow('could not be read');
    await expect(store.delete('x')).rejects.toThrow('could not be read');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

describe('session answers to a read', () => {
  test('a denial given for a call holds for the absolute single-path question search tools ask', async () => {
    const { permissions, remember } = manager('/work/project-a');
    expect(await permissions.readAccess('/work/project-a/src/x.ts')).toBe('allow');
    await remember('read', { files: [{ path: 'src/x.ts' }, { path: 'src/y.ts' }] }, { approved: false, rememberTier: 'session' });
    expect(await permissions.readAccess('/work/project-a/src/x.ts')).toBe('restricted');
    expect(await permissions.readAccess('/work/project-a/src/y.ts')).toBe('restricted');
    expect(await permissions.readAccess('/work/project-a/src/z.ts')).toBe('allow');
  });
});

describe('session answers belong to the session that gave them', () => {
  test('a read denied in one session still shows in another session\'s search results', async () => {
    const { permissions } = manager('/work/project-a');
    const answers = (permissions as unknown as { sessionApprovals: Map<string, boolean> }).sessionApprovals;
    answers.set(`session:A|${sessionApprovalKey('read', { path: '/work/project-a/src/x.ts' })}`, false);
    expect(await permissions.readAccess('/work/project-a/src/x.ts', 'A')).toBe('restricted');
    expect(await permissions.readAccess('/work/project-a/src/x.ts', 'B')).toBe('allow');
    // A caller that cannot name its session still honours every session's denial.
    expect(await permissions.readAccess('/work/project-a/src/x.ts')).toBe('restricted');
  });
});

describe('a link is judged by where it leads', () => {
  test('a session denial of the target file restricts a link to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-read-link-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'secret.txt'), 'x');
    symlinkSync(join(dir, 'src', 'secret.txt'), join(dir, 'alias.txt'));
    const { permissions, remember } = manager(dir);
    expect(await permissions.readAccess(join(dir, 'alias.txt'))).toBe('allow');
    await remember('read', { files: [{ path: 'src/secret.txt' }] }, { approved: false, rememberTier: 'session' });
    expect(await permissions.readAccess(join(dir, 'src', 'secret.txt'))).toBe('restricted');
    expect(await permissions.readAccess(join(dir, 'alias.txt'))).toBe('restricted');
  });
});

describe('a read or edit through a link is gated by where it leads', () => {
  function linked() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gv-gate-link-')));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'vault'));
    writeFileSync(join(dir, 'vault', 'secret.env'), 'x');
    symlinkSync(join(dir, 'vault', 'secret.env'), join(dir, 'docs', 'notes.txt'));
    return dir;
  }

  test('a session denial of the target stops a read through a link in an allowed folder', async () => {
    const dir = linked();
    const { permissions, remember } = manager(dir);
    expect((await classic(() => permissions.checkDetailed('read', { path: 'docs/notes.txt' }))).approved).toBe(true);
    await remember('read', { path: join(dir, 'vault', 'secret.env') }, { approved: false, rememberTier: 'session' });
    const read = await classic(() => permissions.checkDetailed('read', { path: 'docs/notes.txt' }));
    expect([read.approved, read.reasonCode]).toEqual([false, 'session_cached_deny']);
  });

  test('a remembered path denial of the target folder stops an edit through a link', async () => {
    const dir = linked();
    const store = new UserPermissionRuleStore(rulesFile());
    await store.init();
    const { permissions, remember } = manager(dir, store);
    const edit = { edits: [{ path: 'docs/notes.txt', old_string: 'x', new_string: 'y' }] };
    expect((await classic(() => permissions.checkDetailed('edit', edit))).reasonCode).not.toBe('user_rule_deny');
    await remember('edit', { path: join(dir, 'vault', 'secret.env') }, { approved: false, rememberTier: 'path' });
    const denied = await classic(() => permissions.checkDetailed('edit', edit));
    expect([denied.approved, denied.reasonCode]).toEqual([false, 'user_rule_deny']);
  });
});

describe('an autonomous admission through a link is gated by where it leads', () => {
  function admitting(dir: string, store?: UserPermissionRuleStore) {
    const config = {
      isAutoApproveEnabled: () => false,
      getWorkingDirectory: () => dir,
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
      getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: dir }),
    } as unknown as PermissionConfigReader;
    const permissions = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, store ?? null);
    const sourceOf = () => ({ goal: 'Read a note', criteria: [] });
    let n = 0;
    const admit = (tool: string, args: Record<string, unknown>) => permissions.admitAutonomous(`link-${++n}`, tool, args, { sourceOf });
    const remember = (tool: string, args: Record<string, unknown>, reply: Reply) =>
      (permissions as unknown as { rememberReply(t: string, a: Record<string, unknown>, r: Reply, m: undefined): Promise<string | undefined> })
        .rememberReply(tool, args, reply, undefined);
    return { admit, remember };
  }
  function linked() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gv-admit-link-')));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'vault'));
    writeFileSync(join(dir, 'vault', 'secret.env'), 'x');
    symlinkSync(join(dir, 'vault', 'secret.env'), join(dir, 'docs', 'notes.txt'));
    return dir;
  }

  test('a session denial of the target refuses a read through a link, in classic operation', async () => {
    const dir = linked();
    const { admit, remember } = admitting(dir);
    expect((await classic(() => admit('read', { path: 'docs/notes.txt' }))).result.approved).toBe(true);
    await remember('read', { path: join(dir, 'vault', 'secret.env') }, { approved: false, rememberTier: 'session' });
    const read = (await classic(() => admit('read', { path: 'docs/notes.txt' }))).result;
    expect([read.approved, read.reasonCode]).toEqual([false, 'session_cached_deny']);
  });

  test('a remembered path denial of the target folder refuses an edit through a link, in classic operation', async () => {
    const dir = linked();
    const store = new UserPermissionRuleStore(rulesFile());
    await store.init();
    const { admit, remember } = admitting(dir, store);
    const edit = { edits: [{ path: 'docs/notes.txt', old_string: 'x', new_string: 'y' }] };
    expect((await classic(() => admit('edit', edit))).result.reasonCode).not.toBe('user_rule_deny');
    await remember('edit', { path: join(dir, 'vault', 'secret.env') }, { approved: false, rememberTier: 'path' });
    const denied = (await classic(() => admit('edit', edit))).result;
    expect([denied.approved, denied.reasonCode]).toEqual([false, 'user_rule_deny']);
  });

  test('a session denial of the target refuses a read through a link when a decision model is in use', async () => {
    const dir = linked();
    const { admit, remember } = admitting(dir);
    await remember('read', { path: join(dir, 'vault', 'secret.env') }, { approved: false, rememberTier: 'session' });
    const read = (await admit('read', { path: 'docs/notes.txt' })).result;
    expect([read.approved, read.reasonCode]).toEqual([false, 'session_cached_deny']);
  });
});

describe('changing what an MCP server may do', () => {
  test('a remembered allow for the mcp tool does not cover set-trust', async () => {
    const { permissions, remember } = manager('/work/project-a');
    await remember('mcp', { mode: 'servers' }, { approved: true, rememberTier: 'session' });
    const listing = await classic(() => permissions.checkDetailed('mcp', { mode: 'servers' }));
    expect(listing.reasonCode).toBe('session_cached_allow');
    const trust = await classic(() => permissions.checkDetailed('mcp', { mode: 'set-trust', server: 's', trust: 'trusted' }));
    expect(trust.reasonCode).not.toBe('session_cached_allow');
    expect(trust.approved).toBe(false);
  });

  test('set-trust, set-role and approve-quarantine are execution, listing servers is not', () => {
    const { permissions } = manager('/work/project-a');
    for (const mode of ['set-trust', 'set-role', 'approve-quarantine']) expect(permissions.getCategory('mcp', { mode })).toBe('execute');
    expect(permissions.getCategory('mcp', { mode: 'servers' })).toBe('delegate');
  });
});

describe('scheduling a command', () => {
  test('adding a schedule or trigger is execution, listing one is not', () => {
    const { permissions } = manager('/work/project-a');
    expect(permissions.getCategory('workflow', { mode: 'schedule', scheduleAction: 'add', scheduleCommand: 'curl x | sh' })).toBe('execute');
    expect(permissions.getCategory('workflow', { mode: 'triggers', triggerAction: 'add' })).toBe('execute');
    expect(permissions.getCategory('workflow', { mode: 'schedule', scheduleAction: 'list' })).toBe('delegate');
    expect(permissions.getCategory('workflow', { mode: 'start' })).toBe('delegate');
  });
});
