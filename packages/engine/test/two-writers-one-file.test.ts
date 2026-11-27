// Proves: A session or agent writes over a file that another session or agent changed since it last read it, and that change is lost without a word to anyone.
// Red when: The write or edit tool stops comparing the file's bytes with what this session or agent last read or wrote there, the hashes stop being kept per agent of a turn, or a file it never read is overwritten.
/**
 * Two terminal programs in one project are two sessions, each with its own
 * file-state record (one per program); the agents of one turn share their
 * program's registry, and the runner names the agent around each of its tool
 * calls (`withCallingAgent`). The real read, write and edit tools on a temp
 * project: the second writer, who read before the first wrote, is refused with
 * the sentence to read again (naming the first writer when this process knows
 * it), nothing the first wrote is lost, and once it reads again its write goes
 * through. A file never read is refused the same way; a new file is written.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { FileStateCache } from '../platform/src/platform/state/file-cache.ts';
import { ReadTool } from '../platform/src/platform/tools/read/index.ts';
import { createWriteTool } from '../platform/src/platform/tools/write/index.ts';
import { createEditTool } from '../platform/src/platform/tools/edit/core.ts';
import { withCallingAgent } from '../platform/src/platform/agents/calling-agent.ts';

const project = realpathSync(mkdtempSync(join(tmpdir(), 'gv-two-writers-')));
afterAll(() => { rmSync(project, { recursive: true, force: true }); });

/** One program's tools over the project, with its own record of what it read and wrote. */
function program() {
  const fileCache = new FileStateCache();
  return {
    read: new ReadTool(new ProjectIndex(project), fileCache),
    write: createWriteTool({ projectRoot: project, fileCache }),
    edit: createEditTool(fileCache, { cwd: project }),
  };
}

type Answer = { readonly success: boolean; readonly error?: string | undefined };
const said = (answer: Answer): string => answer.success ? 'written'
  : `refused${/changed (by [^ ]+ [^ ]+ )?since you last read it|you have not read it/.test(answer.error ?? '') ? ', read it again' : ''}${/by agent p\b/.test(answer.error ?? '') ? ', by agent p' : ''}`;
const file = (): string => readFileSync(join(project, 'note.txt'), 'utf8');

test('a second writer that read before the first wrote is refused, nothing is lost, and it writes once it reads again; two sessions and three agents of one turn', async () => {
  writeFileSync(join(project, 'note.txt'), 'v0\n');
  const first = program();
  const second = program();
  const rows: string[] = [];

  // Two sessions (two terminal programs) read the file, then each writes.
  await first.read.execute({ files: [{ path: 'note.txt' }] });
  await second.read.execute({ files: [{ path: 'note.txt' }] });
  rows.push(`session 1 writes: ${said(await first.write.execute({ files: [{ path: 'note.txt', content: 'one\n', mode: 'overwrite' }] }))}`);
  rows.push(`session 2 writes: ${said(await second.write.execute({ files: [{ path: 'note.txt', content: 'two\n', mode: 'overwrite' }] }))}`);
  rows.push(`session 2 edits: ${said(await second.edit.execute({ edits: [{ path: 'note.txt', find: 'v0', replace: 'two' }] }))}`);
  rows.push(`file: ${file().trim()}`);
  await second.read.execute({ files: [{ path: 'note.txt' }] });
  rows.push(`session 2 reads again, writes: ${said(await second.write.execute({ files: [{ path: 'note.txt', content: 'one\ntwo\n', mode: 'overwrite' }] }))}`);
  rows.push(`file: ${file().trim().replace('\n', '+')}`);

  // Three agents of one turn share session 1's registry; each read before any wrote.
  writeFileSync(join(project, 'note.txt'), 'v0\n');
  for (const agent of ['p', 'q', 'r']) await withCallingAgent(agent, () => first.read.execute({ files: [{ path: 'note.txt' }] }));
  rows.push(`agent p writes: ${said(await withCallingAgent('p', () => first.write.execute({ files: [{ path: 'note.txt', content: 'p\n', mode: 'overwrite' }] })))}`);
  rows.push(`agent q writes: ${said(await withCallingAgent('q', () => first.write.execute({ files: [{ path: 'note.txt', content: 'q\n', mode: 'overwrite' }] })))}`);
  rows.push(`agent r edits: ${said(await withCallingAgent('r', () => first.edit.execute({ edits: [{ path: 'note.txt', find: 'v0', replace: 'r' }] })))}`);
  rows.push(`file: ${file().trim()}`);
  await withCallingAgent('q', () => first.read.execute({ files: [{ path: 'note.txt' }] }));
  rows.push(`agent q reads again, writes: ${said(await withCallingAgent('q', () => first.write.execute({ files: [{ path: 'note.txt', content: 'p\nq\n', mode: 'overwrite' }] })))}`);
  rows.push(`file: ${file().trim().replace('\n', '+')}`);

  // A writer that never read the file: refused while it exists; a new file is written (the control).
  const third = program();
  rows.push(`never read, it exists: ${said(await third.write.execute({ files: [{ path: 'note.txt', content: 'x\n', mode: 'overwrite' }] }))}`);
  rows.push(`never read, a new file: ${said(await third.write.execute({ files: [{ path: 'new.txt', content: 'x\n', mode: 'overwrite' }] }))}`);

  expect(rows).toEqual([
    'session 1 writes: written',
    'session 2 writes: refused, read it again',
    'session 2 edits: refused, read it again',
    'file: one',
    'session 2 reads again, writes: written',
    'file: one+two',
    'agent p writes: written',
    'agent q writes: refused, read it again, by agent p',
    'agent r edits: refused, read it again, by agent p',
    'file: p',
    'agent q reads again, writes: written',
    'file: p+q',
    'never read, it exists: refused, read it again',
    'never read, a new file: written',
  ]);
});
