// Proves: The same session open in two terminals: each saves the whole file and one overwrites the other's turns.
// Red when: The session lock check stops seeing a session another process holds, so a second terminal opens or claims it, or the lock sweep removes a held lock.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSurface } from '../platform/src/platform/runtime/session-surface.ts';
import { claimSessionHere, closeSessionHere, isSessionOpenElsewhere, sweepClosedSessionLocks } from '../platform/src/platform/runtime/session-open-lock.ts';

const PLATFORM = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'runtime');
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
