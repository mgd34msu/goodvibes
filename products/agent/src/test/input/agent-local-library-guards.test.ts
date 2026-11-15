import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentSkillsRuntimeCommands } from '../../input/commands/agent-skills-runtime.ts';
import { registerPersonasRuntimeCommands } from '../../input/commands/personas-runtime.ts';
import { runCalendarRuntimeCommand } from '../../input/commands/calendar-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function rig() {
  const root = makeProjectTempDir('goodvibes-agent-library-guards');
  const workspace = join(root, 'workspace');
  const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: root });
  const out: string[] = [];
  const registry = new CommandRegistry();
  registerAgentSkillsRuntimeCommands(registry);
  registerPersonasRuntimeCommands(registry);
  const context = (invokedByModel: boolean): CommandContext => ({
    print: (text: string) => out.push(text),
    workspace: { shellPaths },
    ...(invokedByModel ? { invokedByModel: true } : {}),
  }) as unknown as CommandContext;
  return { root, workspace, shellPaths, out, registry, owner: context(false), model: context(true) };
}

const CREATE = ['create', '--name', 'Inbox Triage', '--description', 'Prioritize messages.', '--procedure', 'Summarize senders.'];

describe('/skills update', () => {
  test('changing one kind of requirement keeps the other kind', async () => {
    const { registry, owner, shellPaths } = rig();
    await registry.execute('skills', [...CREATE, '--requires-env', 'OLD_TOKEN', '--requires-command', 'gh'], owner);
    await registry.execute('skills', ['update', 'inbox-triage', '--requires-env', 'NEW_TOKEN'], owner);
    const skill = AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!;
    expect(skill.requirements.map((r) => `${r.kind}:${r.name}`).sort()).toEqual(['command:gh', 'env:NEW_TOKEN']);
    await registry.execute('skills', ['update', 'inbox-triage', '--requires-command', 'jq'], owner);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.requirements.map((r) => `${r.kind}:${r.name}`).sort()).toEqual(['command:jq', 'env:NEW_TOKEN']);
  });

  test('an empty value for one flag clears only that kind', async () => {
    const { registry, owner, shellPaths } = rig();
    await registry.execute('skills', [...CREATE, '--requires-env', 'OLD_TOKEN', '--requires-command', 'gh'], owner);
    await registry.execute('skills', ['update', 'inbox-triage', '--requires-env='], owner);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.requirements.map((r) => `${r.kind}:${r.name}`)).toEqual(['command:gh']);
  });
});

describe('review is the owner\'s gesture', () => {
  test('a model-run /skills review leaves the skill unreviewed; the owner can review it', async () => {
    const { registry, owner, model, shellPaths } = rig();
    await registry.execute('skills', CREATE, owner);
    await expect(registry.execute('skills', ['review', 'inbox-triage'], model)).rejects.toMatchObject({ code: 'OWNER_REVIEW_REQUIRED' });
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.reviewState).not.toBe('reviewed');
    await registry.execute('skills', ['review', 'inbox-triage'], owner);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.reviewState).toBe('reviewed');
  });

  test('a model cannot enable an unreviewed skill but can enable a reviewed one', async () => {
    const { registry, owner, model, shellPaths } = rig();
    await registry.execute('skills', CREATE, owner);
    await expect(registry.execute('skills', ['enable', 'inbox-triage'], model)).rejects.toThrow('has not been reviewed');
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.enabled).toBe(false);
    await registry.execute('skills', ['review', 'inbox-triage'], owner);
    await registry.execute('skills', ['enable', 'inbox-triage'], model);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('inbox-triage')!.enabled).toBe(true);
  });

  test('a model-run /skills bundle review is refused', async () => {
    const { registry, owner, model, shellPaths } = rig();
    await registry.execute('skills', CREATE, owner);
    await registry.execute('skills', ['bundle', 'create', '--name', 'Ops', '--description', 'Ops skills', '--skills', 'inbox-triage'], owner);
    await expect(registry.execute('skills', ['bundle', 'review', 'ops'], model)).rejects.toMatchObject({ code: 'OWNER_REVIEW_REQUIRED' });
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).getBundle('ops')!.reviewState).not.toBe('reviewed');
  });

  test('a model-run /personas review is refused', async () => {
    const { registry, owner, model, out, shellPaths } = rig();
    await registry.execute('personas', ['create', '--name', 'Researcher', '--description', 'Careful.', '--body', 'Be careful.'], owner);
    const id = AgentPersonaRegistry.fromShellPaths(shellPaths).list()[0]!.id;
    await registry.execute('personas', ['review', id], model);
    expect(out.at(-1)).toContain('Refused');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).get(id)!.reviewState).not.toBe('reviewed');
  });
});

describe('skill standard files', () => {
  test('exporting twice needs --overwrite, and with it the second export rewrites the file', async () => {
    const { registry, owner, model, workspace, out } = rig();
    await registry.execute('skills', CREATE, owner);
    await registry.execute('skills', ['export-standard', 'inbox-triage', 'out', '--yes'], owner);
    const file = join(workspace, 'out', 'inbox-triage', 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    await registry.execute('skills', ['update', 'inbox-triage', '--procedure', 'Summarize senders, then rank them.'], owner);
    await registry.execute('skills', ['export-standard', 'inbox-triage', 'out', '--yes'], owner);
    expect(out.at(-1)).toContain('already exists');
    await registry.execute('skills', ['export-standard', 'inbox-triage', 'out', '--overwrite', '--yes'], owner);
    expect(out.at(-1)).toContain('Exported skill to');
    expect(readFileSync(file, 'utf-8')).toContain('then rank them');
    // The model is held to the workspace for both directions.
    await registry.execute('skills', ['export-standard', 'inbox-triage', '../escaped', '--yes'], model);
    expect(out.at(-1)).toContain('outside the workspace');
    expect(existsSync(join(workspace, '..', 'escaped'))).toBe(false);
  });

  test('a relative destination is resolved against the workspace, not the process directory', async () => {
    const { registry, owner, workspace } = rig();
    await registry.execute('skills', CREATE, owner);
    await registry.execute('skills', ['export-standard', 'inbox-triage', 'nested/out', '--yes'], owner);
    expect(existsSync(join(workspace, 'nested', 'out', 'inbox-triage', 'SKILL.md'))).toBe(true);
  });

  test('a model-run import of a file outside the workspace is refused', async () => {
    const { registry, model, out } = rig();
    await registry.execute('skills', ['import-standard', '/etc/hostname', '--yes'], model);
    expect(out.at(-1)).toContain('outside the workspace');
  });
});

describe('/calendar import and export paths', () => {
  function calendarContext(invokedByModel: boolean, root: string, workspace: string) {
    const out: string[] = [];
    const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: root });
    const ctx = {
      print: (text: string) => out.push(text),
      workspace: { shellPaths },
      platform: { secretsManager: { get: async () => null, set: async () => {}, delete: async () => {} } },
      ...(invokedByModel ? { invokedByModel: true } : {}),
    } as unknown as CommandContext;
    return { ctx, out };
  }

  test('a model-run export outside the workspace is refused and writes nothing', async () => {
    const { root, workspace } = rig();
    const { ctx, out } = calendarContext(true, root, workspace);
    await runCalendarRuntimeCommand(['export', '--dest', '../exported.ics', '--yes'], ctx);
    expect(out.join('\n')).toContain('outside the workspace');
    expect(existsSync(join(workspace, '..', 'exported.ics'))).toBe(false);
  });

  test('an owner export resolves a relative destination against the workspace', async () => {
    const { root, workspace } = rig();
    const { ctx, out } = calendarContext(false, root, workspace);
    await runCalendarRuntimeCommand(['export', '--dest', 'calendar.ics', '--yes'], ctx);
    expect(out.join('\n')).toContain(`Exported calendar to ${join(workspace, 'calendar.ics')}`);
    expect(existsSync(join(workspace, 'calendar.ics'))).toBe(true);
  });

  test('an import preview names the workspace-resolved file it read', async () => {
    const { root, workspace } = rig();
    const { ctx, out } = calendarContext(false, root, workspace);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'weekly.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:w1\r\nSUMMARY:Weekly\r\nDTSTART:20260706T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
    await runCalendarRuntimeCommand(['import', 'weekly.ics'], ctx);
    const preview = out.join('\n');
    expect(preview).toContain('Calendar import preview');
    expect(preview).toContain(join(workspace, 'weekly.ics'));
    expect(preview).toContain('events found 1');
    expect(preview).toContain('rerun with --yes');
  });
});
