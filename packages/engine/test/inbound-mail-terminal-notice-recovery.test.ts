import { describe, expect, test } from 'bun:test';
import {
  createInboundTerminalFailureAnnouncer,
  type InboundMailTerminalFailure,
  type InboundCapabilityVerdict,
} from '../platform/src/platform/email/inbound/index.ts';
import type { StructuredNotice } from '../platform/src/platform/email/inbound-notice.ts';

const HEALTHY: InboundCapabilityVerdict = { state: 'healthy', reason: 'idle-push', detail: 'pushing', fix: '' };

function failure(): InboundMailTerminalFailure {
  return {
    account: 'primary',
    mailbox: 'INBOX',
    reason: 'credentials-rejected',
    detail: 'refused',
    fix: 'Store a current mail password.',
    at: '2026-07-27T12:00:00.000Z',
    notice: null,
  };
}

describe('the stopped-mail announcer across a recovery', () => {
  test('a send from before the recovery does not clear the marker of the send after it', async () => {
    const resolvers: Array<(value: { delivered: boolean }) => void> = [];
    const sends: StructuredNotice[] = [];
    const announcer = createInboundTerminalFailureAnnouncer({
      log: () => {},
      send: (notice) => {
        sends.push(notice);
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    });

    announcer.terminalFailure(failure()); // send A
    announcer.stateChanged({ account: 'primary', mailbox: 'INBOX', from: null, to: HEALTHY, at: '2026-07-27T12:10:00.000Z' });
    announcer.terminalFailure(failure()); // send B, same key
    expect(sends).toHaveLength(2);

    resolvers[0]?.({ delivered: false }); // A settles late
    await Promise.resolve();
    await Promise.resolve();

    announcer.terminalFailure(failure()); // hourly re-probe while B is still pending
    expect(sends).toHaveLength(2);
  });
});
