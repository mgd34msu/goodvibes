import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ProfileGatewayInvoke, ProfileGatewayResult } from '../../agent/owner-profile-gateway.ts';
import { createAgentProfileTool, registerAgentProfileTool } from '../../tools/agent-profile-tool.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function admittedWrite(invoke: ProfileGatewayInvoke, args: Record<string, unknown>) {
  const directory = makeProjectTempDir('agent-profile-failures'); directories.push(directory);
  const result = await admitLocalState(registry => registerAgentProfileTool(registry, { invoke }), 'profile', args, { directory });
  return { success: result.success, text: 'output' in result && typeof result.output === 'string' ? result.output : 'error' in result && typeof result.error === 'string' ? result.error : '' };
}

describe('profile tool failures say what is known', () => {
  test('a write that throws after it was sent reports an unknown outcome, not a held authority', async () => {
    const calls: string[] = [];
    const result = await admittedWrite(async methodId => { calls.push(methodId); throw new Error('disk fault'); }, { action: 'append', section: 'preferences', text: 'Likes tea' });
    expect(calls).toEqual(['profile.append']);
    expect(result.success).toBe(false);
    expect(result.text).toContain('outcome unknown'); expect(result.text).toContain('disk fault');
    expect(result.text).toContain('Read the profile'); expect(result.text).not.toContain('held');
  });
  test('a read that throws names its cause instead of claiming authority is missing', async () => {
    const tool = createAgentProfileTool({ invoke: async () => { throw new Error('no connected host configured'); } });
    const result = await tool.execute({ action: 'read' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('no connected host configured');
    expect(result.output).not.toContain('authority or source is unavailable');
  });
});

describe('profile tool paths', () => {
  test('status prints the profile location without the home directory or account name', async () => {
    const home = homedir();
    const invoke: ProfileGatewayInvoke = async (): Promise<ProfileGatewayResult> => ({ ok: true, route: 'in-process', data: { kind: 'loaded', path: `${home}/.goodvibes/profile.md`, exists: true } });
    const result = await createAgentProfileTool({ invoke }).execute({ action: 'status' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('path ~/.goodvibes/profile.md');
    expect(result.output).not.toContain(home);
  });
  test('an unreadable-profile reason that embeds the absolute path is shortened on read and status', async () => {
    const home = homedir();
    const path = `${home}/.goodvibes/profile.md`;
    const reason = `Your profile could not be read: EACCES (${path})`;
    const readInvoke: ProfileGatewayInvoke = async (): Promise<ProfileGatewayResult> => ({ ok: true, route: 'in-process', data: { state: { kind: 'unavailable', path, reason }, sections: [] } });
    const read = await createAgentProfileTool({ invoke: readInvoke }).execute({ action: 'read' });
    expect(read.output).toContain('EACCES (~/.goodvibes/profile.md)');
    expect(read.output).not.toContain(home);
    const statusInvoke: ProfileGatewayInvoke = async (): Promise<ProfileGatewayResult> => ({ ok: true, route: 'in-process', data: { kind: 'unavailable', path, exists: false, reason } });
    const status = await createAgentProfileTool({ invoke: statusInvoke }).execute({ action: 'status' });
    expect(status.output).toContain('EACCES (~/.goodvibes/profile.md)');
    expect(status.output).not.toContain(home);
  });
  test('a path outside the home directory shows only its file name', async () => {
    const invoke: ProfileGatewayInvoke = async (): Promise<ProfileGatewayResult> => ({ ok: true, route: 'in-process', data: { kind: 'loaded', path: '/srv/accounts/someone/profile.md', exists: true } });
    const result = await createAgentProfileTool({ invoke }).execute({ action: 'status' });
    expect(result.output).toContain('path profile.md');
    expect(result.output).not.toContain('someone');
  });
});

describe('profile tool registration', () => {
  test('registering again is harmless, but a different tool named profile is a named failure', () => {
    const invoke: ProfileGatewayInvoke = async (): Promise<ProfileGatewayResult> => ({ ok: true, route: 'in-process', data: {} });
    const own = new ToolRegistry();
    registerAgentProfileTool(own, { invoke }); registerAgentProfileTool(own, { invoke });
    expect(own.list().filter(tool => tool.definition.name === 'profile')).toHaveLength(1);

    const other = new ToolRegistry();
    other.register({ definition: { name: 'profile', description: 'Trips and dates', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['record_trip', 'note'] } } } },
      execute: async () => ({ success: true, output: '' }) });
    expect(() => registerAgentProfileTool(other, { invoke })).toThrow("a different tool named 'profile'");
  });
});
