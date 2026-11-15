import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentVibeTool, registerAgentVibeTool } from '../../tools/agent-vibe-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempContext(): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-vibe-boundaries');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { workspace: { shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: home }) } } as CommandContext;
}

describe('vibe show', () => {
  test('refuses a file that is not a VIBE.md location, and returns none of its text', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    const other = join(shellPaths.workingDirectory, 'notes.txt');
    writeFileSync(other, 'private project notes');
    const result = await createAgentVibeTool(context).execute({ action: 'show', path: other });
    expect(result.success).toBe(false);
    expect(result.error).toContain('only reads a VIBE.md');
    expect(JSON.stringify(result)).not.toContain('private project notes');
  });

  test('refuses a path outside the workspace', async () => {
    const context = tempContext();
    const outside = join(context.workspace.shellPaths!.homeDirectory, '.ssh-config');
    writeFileSync(outside, 'Host example');
    const result = await createAgentVibeTool(context).execute({ action: 'show', path: outside });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Host example');
  });

  test('still shows the project VIBE.md and labels the text as content, not instructions', async () => {
    const context = tempContext();
    writeFileSync(join(context.workspace.shellPaths!.workingDirectory, 'VIBE.md'), 'Be concise.');
    const result = await createAgentVibeTool(context).execute({ action: 'show', scope: 'project' });
    expect(result.success).toBe(true);
    const body = JSON.parse(result.output!) as { body: string; truncated: boolean; policy: { boundary: string } };
    expect(body.body).toBe('Be concise.');
    expect(body.truncated).toBe(false);
    expect(body.policy.boundary).toContain('not instructions');
  });

  test('caps and labels a very long body', async () => {
    const context = tempContext();
    writeFileSync(join(context.workspace.shellPaths!.workingDirectory, 'VIBE.md'), 'x'.repeat(30_000));
    const result = await createAgentVibeTool(context).execute({ action: 'show', scope: 'project' });
    const body = JSON.parse(result.output!) as { body: string; truncated: boolean; bodyCharacters: number };
    expect(body.truncated).toBe(true);
    expect(body.body.length).toBe(20_000);
    expect(body.bodyCharacters).toBe(30_000);
  });
});

describe('vibe action words', () => {
  test.each([['mode'], ['action']] as const)('an unknown %s is refused with the valid actions, not read as status', async (field) => {
    const result = await createAgentVibeTool(tempContext()).execute({ [field]: 'delete' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown VIBE.md action "delete"');
    expect(result.error).toContain('import_persona');
  });

  test('no action still means status', async () => {
    const result = await createAgentVibeTool(tempContext()).execute({});
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).action).toBe('vibe_status');
  });
});

describe('vibe held calls', () => {
  test('a call with no recorded admission is reported as held, with the cause and the next step', async () => {
    const result = await createAgentVibeTool(tempContext()).execute({ action: 'init', scope: 'project' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('held');
    expect(result.error).toContain('not caused by your arguments');
    expect(result.error).toContain('do not retry');
  });
});

describe('vibe import_persona', () => {
  test('refuses a file that is not a VIBE.md location and makes no persona of it', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    const other = join(shellPaths.workingDirectory, 'notes.md');
    writeFileSync(other, 'private project notes');
    const result = await admitLocalState(registry => registerAgentVibeTool(registry, context), 'vibe', {
      action: 'import_persona', path: other, review: true, use: true,
    }, { directory: shellPaths.workingDirectory });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private project notes');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().personas).toHaveLength(0);
  });

  test('a failure after the persona was created names the persona and the step that failed', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), ['---', 'name: Half Vibe', '---', 'Be brief.'].join('\n'));
    const original = AgentPersonaRegistry.prototype.setActive;
    AgentPersonaRegistry.prototype.setActive = function setActive(): never { throw new Error('active store is read-only'); };
    try {
      const result = await admitLocalState(registry => registerAgentVibeTool(registry, context), 'vibe', {
        action: 'import_persona', scope: 'project', review: true, use: true,
      }, { directory: shellPaths.workingDirectory });
      expect(result.success).toBe(false);
      expect(result.error).toContain('activate step failed');
      expect(result.error).toContain('active store is read-only');
      expect(result.error).toContain('do not import again');
    } finally { AgentPersonaRegistry.prototype.setActive = original; }
    const personas = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().personas;
    expect(personas).toHaveLength(1);
    expect(personas[0]!.reviewState).toBe('reviewed');
  });
});
