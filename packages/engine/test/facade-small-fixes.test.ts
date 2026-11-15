import { expect, test } from 'bun:test';
import { handleInteractiveApprovalAction } from '../platform/src/platform/daemon/facade-approval-action.js';
import { isCompiledBinaryInvocation, resolveDaemonExecInvocation } from '../platform/src/platform/daemon/daemon-exec-invocation.js';

test('an approval click whose body cannot be read is refused instead of approved without its note', async () => {
  let resolved = 0;
  const refusal = Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const response = await handleInteractiveApprovalAction({
    broker: { claimApproval: async () => null, cancelApproval: async () => null, resolveApproval: async () => { resolved++; return null; } },
    parseBody: async () => refusal, actor: () => 'owner', record: (_req, _path, value) => value,
  }, 'approval-1', 'approve', new Request('http://daemon.test/api/approvals/approval-1/approve', { method: 'POST', body: '{' }));
  expect(response.status).toBe(400);
  expect(resolved).toBe(0);
});

test('a compiled binary does not pass its embedded entry path to the service unit as an argument', () => {
  const signals = { execPath: '/usr/local/bin/goodvibes-daemon', argv: ['/usr/local/bin/goodvibes-daemon', '/$bunfs/root/goodvibes-daemon', '--port', '3421'] };
  expect(isCompiledBinaryInvocation(signals)).toBe(true);
  expect(resolveDaemonExecInvocation(signals, '/project')).toEqual({ command: signals.execPath, args: ['--port', '3421'], fromCompiledBinary: true });
  const bare = { execPath: '/usr/local/bin/goodvibes-daemon', argv: ['/usr/local/bin/goodvibes-daemon', '--install-service'] };
  expect(resolveDaemonExecInvocation(bare, '/project').args).toEqual(['--install-service']);
});
