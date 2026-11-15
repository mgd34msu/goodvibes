import { describe, expect, mock, test } from 'bun:test';
import { handleRemoteCancelCommand } from '../../input/commands/remote-runtime.ts';

describe('/remote cancel scope', () => {
  test('cancels only the named agent when several remote connections are active', async () => {
    const printed: string[] = [];
    const cancel = mock((agentId: string) => agentId === 'agent-remote-01');
    await handleRemoteCancelCommand(
      'agent-remote-01',
      [{ agentId: 'agent-local-02' }, { agentId: 'agent-remote-01' }, { agentId: 'agent-local-03' }],
      { print: (text: string) => { printed.push(text); } },
      { cancel },
      undefined,
    );

    expect(cancel.mock.calls).toEqual([['agent-remote-01']]);
    expect(printed.join('\n')).toContain('Cancelled remote agent agent-remote-01');
  });

  test('an agent that is not an active connection is refused without cancelling anything', async () => {
    const printed: string[] = [];
    const cancel = mock(() => true);
    await handleRemoteCancelCommand(
      'agent-unknown',
      [{ agentId: 'agent-local-02' }],
      { print: (text: string) => { printed.push(text); } },
      { cancel },
      undefined,
    );

    expect(cancel).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('Unknown remote connection: agent-unknown');
  });
});
