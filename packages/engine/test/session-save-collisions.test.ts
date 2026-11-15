/**
 * Saving a session never silently replaces a different saved conversation,
 * and the session store keeps what other processes and long meta lines need.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '../platform/src/platform/sessions/manager.js';
import { createSessionWorkflowCommands, type SessionWorkflowContext } from '../terminal-shell/src/session-workflow-commands.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-save-'));
  dirs.push(dir);
  return dir;
}

function harness(sm: SessionManager, sessionId: string, title: string, content: string) {
  const printed: string[] = [];
  const { handleSessionWorkflowCommand } = createSessionWorkflowCommands<SessionWorkflowContext>(() => sm, {
    headingSuffix: '', detailSeparator: ': ', postureSeparator: '=', confirmDelete: true, reviewSeparator: ' ', reviewDetailSeparator: ' ',
    field: (_view, key, value) => `${key}: ${value}`,
    renamed: (name) => `renamed ${name}`,
    deleted: (name) => `deleted ${name}`,
    failed: (action, error) => `${action} failed: ${String(error)}`,
    captureSession: () => ({ messages: [{ role: 'user', content }], metadata: {} }),
    copySidecars: () => {},
    beforeSwitch: () => {},
    afterSwitch: () => {},
    saved: (name, sanitizedName) => `Session saved ${name} as ${sanitizedName}`,
    forked: (id) => `forked ${id}`,
    productCommand: async () => false,
  });
  const ctx = {
    print: (message: string) => { printed.push(message); },
    renderRequest: () => {},
    session: {
      runtime: { sessionId, model: 'm', provider: 'p' },
      conversationManager: { title, getMessageCount: () => 1, branchState: () => ({ branches: {}, currentBranch: 'main' }) },
    },
  } as unknown as SessionWorkflowContext;
  return { printed, ctx, run: (args: string[]) => handleSessionWorkflowCommand(args, ctx) };
}

const contentOf = (sm: SessionManager, id: string) => (sm.load(id).messages[0] as { content: string }).content;

describe('/session save', () => {
  test('refuses to replace a different conversation whose name sanitizes to the same id', async () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    await harness(sm, 'first-conversation', 'one', 'first').run(['save', 'My Notes']);
    const second = harness(sm, 'second-conversation', 'two', 'second');
    await second.run(['save', 'my-notes']);

    expect(contentOf(sm, 'my-notes')).toBe('first');
    expect(second.ctx.session.runtime.sessionId).toBe('second-conversation');
    expect(second.printed.join('\n')).toContain('a different saved session already uses the id my-notes');
    expect(second.printed.join('\n')).toContain('/session save my-notes --yes');
  });

  test('saving the same conversation again overwrites its own file', async () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    const first = harness(sm, 'first-conversation', 'one', 'first');
    await first.run(['save', 'notes']);
    expect(first.ctx.session.runtime.sessionId).toBe('notes');
    await first.run(['save', 'notes']);
    expect(first.printed.at(-1)).toContain('Session saved');
  });

  test('--yes replaces the existing session deliberately', async () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    await harness(sm, 'first-conversation', 'one', 'first').run(['save', 'notes']);
    await harness(sm, 'second-conversation', 'two', 'second').run(['save', 'notes', '--yes']);
    expect(contentOf(sm, 'notes')).toBe('second');
  });

  test('a name with no file-name characters is refused instead of sharing one fallback file', async () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    await harness(sm, 'first-conversation', 'one', 'first').run(['save', '設計']);
    const second = harness(sm, 'second-conversation', 'two', 'second');
    await second.run(['save', '会議']);

    expect(sm.list()).toHaveLength(0);
    expect(second.printed.join('\n')).toContain('Cannot save as "会議"');
  });

  test('an untitled-in-ASCII conversation saved without a name keeps its own id', async () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    await harness(sm, 'first-conversation', '設計', 'first').run(['save']);
    await harness(sm, 'second-conversation', '会議', 'second').run(['save']);
    expect(contentOf(sm, 'first-conversation')).toBe('first');
    expect(contentOf(sm, 'second-conversation')).toBe('second');
  });
});

describe('SessionManager', () => {
  test('a user save stays user when its meta line is longer than 8 KB', () => {
    const sm = new SessionManager('/unused', { sessionsDir: sessionsDir() });
    const title = 'x'.repeat(20_000);
    sm.save('long', [], { title, model: 'm', provider: 'p', timestamp: 1, saveSource: 'user' });
    sm.save('long', [], { title, model: 'm', provider: 'p', timestamp: 2, saveSource: 'auto' });
    expect(sm.getMeta('long')?.saveSource).toBe('user');
  });

  test("construction leaves a live process's in-flight temp file alone and removes a dead one's", () => {
    const dir = sessionsDir();
    const parent = process.ppid;
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const live = join(dir, `.tmp-${parent}-${Date.now()}`);
    const orphan = join(dir, `.tmp-${dead}-${Date.now()}`);
    const stale = join(dir, `.tmp-${parent}-1`);
    writeFileSync(live, 'partial');
    writeFileSync(orphan, 'partial');
    writeFileSync(stale, 'partial');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);

    new SessionManager('/unused', { sessionsDir: dir });

    expect(existsSync(live)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });
});
