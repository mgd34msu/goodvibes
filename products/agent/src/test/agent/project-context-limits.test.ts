import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { MAX_PROJECT_CONTEXT_FILE_CHARS, buildProjectContextPrompt, discoverProjectContextFiles } from '../../agent/project-context-files.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function workspace() {
  const root = makeProjectTempDir('goodvibes-agent-project-context-limits');
  const home = join(root, 'home');
  const work = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(work, '.git'), { recursive: true });
  return { root, paths: createShellPathService({ workingDirectory: work, homeDirectory: home }) };
}

describe('project context files are bounded', () => {
  test('an oversized AGENTS.md is cut, flagged truncated, and the prompt says so', () => {
    const { root, paths } = workspace();
    try {
      writeFileSync(join(paths.workingDirectory, 'AGENTS.md'), `${'Prefer short answers. '.repeat(5_000)}END-MARKER`);
      const file = discoverProjectContextFiles(paths).files.find((entry) => entry.kind === 'agents')!;
      expect(file.truncated).toBe(true);
      expect(file.body).toHaveLength(MAX_PROJECT_CONTEXT_FILE_CHARS);
      const prompt = buildProjectContextPrompt(paths) ?? '';
      expect(prompt).not.toContain('END-MARKER');
      expect(prompt).toContain('AGENTS.md truncated for prompt safety.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a file under the cap is loaded whole and not flagged', () => {
    const { root, paths } = workspace();
    try {
      writeFileSync(join(paths.workingDirectory, 'AGENTS.md'), 'Short and sweet.');
      const file = discoverProjectContextFiles(paths).files.find((entry) => entry.kind === 'agents')!;
      expect(file.truncated).toBe(false);
      expect(file.body).toBe('Short and sweet.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a file far past the read limit is blocked with a reason instead of being read', () => {
    const { root, paths } = workspace();
    try {
      writeFileSync(join(paths.workingDirectory, 'AGENTS.md'), 'x'.repeat(2_000_000));
      const snapshot = discoverProjectContextFiles(paths);
      expect(snapshot.files.some((entry) => entry.kind === 'agents')).toBe(false);
      expect(snapshot.blocked.find((entry) => entry.kind === 'agents')?.reason).toContain('over the');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a symlink that resolves outside the workspace is blocked, one that stays inside is loaded', () => {
    const { root, paths } = workspace();
    try {
      const outside = join(root, 'outside.md');
      writeFileSync(outside, 'Instructions from somewhere else entirely.');
      symlinkSync(outside, join(paths.workingDirectory, 'AGENTS.md'));
      writeFileSync(join(paths.workingDirectory, 'real.md'), 'Inside the workspace.');
      symlinkSync(join(paths.workingDirectory, 'real.md'), join(paths.workingDirectory, 'CLAUDE.md'));

      const snapshot = discoverProjectContextFiles(paths);
      expect(snapshot.blocked.find((entry) => entry.kind === 'agents')?.reason).toContain('outside the workspace');
      expect(snapshot.files.some((entry) => entry.body.includes('somewhere else'))).toBe(false);
      expect(snapshot.files.find((entry) => entry.kind === 'claude')?.body).toBe('Inside the workspace.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
