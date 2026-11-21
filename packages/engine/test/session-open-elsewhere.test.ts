// Proves: The same session open in two terminals: each saves the whole file and one overwrites the other's turns.
// Red when: The session lock check stops seeing a session another process holds, so a second terminal opens or claims it, or the lock sweep removes a held lock; or the session store lets a second process open, save over or delete a session file another process holds.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSurface } from '../platform/src/platform/runtime/session-surface.ts';
import { claimSessionHere, closeSessionHere, isSessionOpenElsewhere, sweepClosedSessionLocks } from '../platform/src/platform/runtime/session-open-lock.ts';
import { SessionManager } from '../platform/src/platform/sessions/manager.ts';

const PLATFORM = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'runtime');
const SESSIONS = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'sessions');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a session another process has open is refused here, survives the lock sweep, and is free once that process dies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-session-open-'));
  roots.push(root);
  const where = { workingDirectory: join(root, 'project'), homeDirectory: join(root, 'home') };
  const tui = createSessionSurface({ surfaceRoot: 'tui', ...where });
  const agent = createSessionSurface({ surfaceRoot: 'agent', ...where });
  const session = 'c0ffee01';

  // The first terminal: another process with the session open.
  const script = join(root, 'holder.ts');
  writeFileSync(script, [
    `import { createSessionSurface } from ${JSON.stringify(join(PLATFORM, 'session-surface.ts'))};`,
    `import { openSessionHere } from ${JSON.stringify(join(PLATFORM, 'session-open-lock.ts'))};`,
    `openSessionHere(createSessionSurface({ surfaceRoot: 'tui', workingDirectory: process.argv[2]!, homeDirectory: process.argv[3]! }), process.argv[4]!);`,
    "console.log('held');",
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  const holder = Bun.spawn(['bun', script, where.workingDirectory, where.homeDirectory, session], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('held');
    reader.releaseLock();

    expect(isSessionOpenElsewhere(tui, session)).toBe(true);
    expect(await claimSessionHere(tui, session)).toBe(false);
    sweepClosedSessionLocks(tui);
    expect(isSessionOpenElsewhere(tui, session)).toBe(true);
    // The other app's session of the same name is a different session.
    expect(isSessionOpenElsewhere(agent, session)).toBe(false);

    holder.kill('SIGKILL');
    await holder.exited;
    expect(await claimSessionHere(tui, session)).toBe(true);
  } finally {
    holder.kill('SIGKILL');
    closeSessionHere(tui, session);
  }
});

test('the session file another process has open is not opened, saved over or deleted here; once it dies it is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-session-store-'));
  roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const meta = { title: 'grinder research', model: 'm', provider: 'p', timestamp: 1 };

  // The first terminal saved the conversation, so it has the session open for writing.
  const script = join(root, 'writer.ts');
  writeFileSync(script, [
    `import { SessionManager } from ${JSON.stringify(join(SESSIONS, 'manager.ts'))};`,
    `new SessionManager(process.argv[2]!, { sessionsDir: process.argv[3]! }).save('one', [{ role: 'user', content: 'turn written in the first terminal' }], ${JSON.stringify(meta)});`,
    "console.log('saved');",
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  const holder = Bun.spawn(['bun', script, root, sessionsDir], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('saved');
    reader.releaseLock();
    const file = join(sessionsDir, 'one.jsonl');
    const written = readFileSync(file, 'utf-8');

    // The second terminal, over the same sessions folder.
    const here = new SessionManager(root, { sessionsDir });
    const code = (act: () => unknown): unknown => { try { act(); return 'done'; } catch (error) { return (error as { code?: unknown }).code; } };
    expect(code(() => here.openForWriting('one'))).toBe('SESSION_OPEN_ELSEWHERE');
    expect(code(() => here.save('one', [{ role: 'user', content: 'turn written in the second terminal' }], meta))).toBe('SESSION_OPEN_ELSEWHERE');
    expect(code(() => here.delete('one'))).toBe('SESSION_OPEN_ELSEWHERE');
    expect(readFileSync(file, 'utf-8')).toBe(written);

    holder.kill('SIGKILL');
    await holder.exited;
    expect(code(() => here.openForWriting('one'))).toBe('done');
    expect(code(() => here.save('one', [{ role: 'user', content: 'turn written in the second terminal' }], meta))).toBe('done');
    expect(readFileSync(file, 'utf-8')).toContain('turn written in the second terminal');
    here.closeForWriting();
  } finally {
    holder.kill('SIGKILL');
  }
});
