import { expect, spyOn, test } from 'bun:test';
import { buildLocalhostFetchApproval } from '../platform/src/platform/runtime/permissions/localhost-fetch-approval.ts';
import { admitSandboxEscalation } from '../platform/src/platform/runtime/permissions/autonomous-sandbox-escalation.ts';
import { withExternalOperationSource } from '../platform/src/platform/permissions/external-operation-scope.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';

test('a localhost approval that cannot be saved is refused with the write failure logged', async () => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    const approval = buildLocalhostFetchApproval({
      requestApproval: async () => ({ approved: true }) as never,
      configManager: {
        get: () => false,
        set: () => { throw new Error('settings are read-only'); },
      } as never,
    });
    expect(await approval({ url: 'http://localhost:3000/', host: 'localhost' })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('read-only');
  } finally {
    warn.mockRestore();
  }
});

test('an autonomous admission that throws is refused with its cause logged', async () => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    const host = {
      signal: new AbortController().signal,
      config: { onDidInvalidate: () => () => {} },
      workspaceTrust: { prepareAutonomousConstraint: async () => { throw new Error('trust store unreadable'); } },
    };
    const operation = { sourceOf: () => ({}), assertCurrent: () => {} };
    const result = await withExternalOperationSource(operation as never, () =>
      admitSandboxEscalation(host as never, { command: 'ls', workingDirectory: '/tmp' } as never,
        { assertCurrent: () => {} } as never));
    expect(result).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).toContain('trust store unreadable');
  } finally {
    warn.mockRestore();
  }
});
