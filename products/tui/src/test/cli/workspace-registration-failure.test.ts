import { expect, test } from 'bun:test';
import { selfRecordWorkspaceRegistration } from '../../cli/tui-startup.ts';

const offer = { root: '/project', status: 'unknown' as const, coveredBy: null, viaWorktreeLink: false, broad: false, offerRegister: true, reason: 'unknown' };

test('a registry that cannot be read or written does not become an unhandled rejection', async () => {
  const unreadable = { evaluate: async () => { throw new Error('registry unreadable'); }, register: async () => { throw new Error('unreachable'); } };
  await expect(selfRecordWorkspaceRegistration(unreadable)).resolves.toBeUndefined();
  const unwritable = { evaluate: async () => offer, register: async () => { throw new Error('permission denied'); } };
  await expect(selfRecordWorkspaceRegistration(unwritable)).resolves.toBeUndefined();
});
