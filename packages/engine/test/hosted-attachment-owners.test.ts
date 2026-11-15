import { describe, expect, test } from 'bun:test';
import { HostedSessionAttachments } from '../platform/src/platform/hosted-sessions/attachments.js';

describe('who owns a hosted session', () => {
  test('identified attachers own it; others, and unidentified callers, are not owners; an unclaimed session has no owner to protect', () => {
    const open = new HostedSessionAttachments();
    open.renew('c1', 0, 1000);
    expect(open.ownedByOthers('anyone')).toBe(false);
    const claimed = new HostedSessionAttachments();
    claimed.renew('c1', 0, 1000, 'alice');
    expect(claimed.ownedByOthers('alice')).toBe(false);
    expect(claimed.ownedByOthers('mallory')).toBe(true);
    expect(claimed.ownedByOthers(undefined)).toBe(true);
    claimed.delete('c1');
    expect(claimed.ownedByOthers('mallory')).toBe(false);
  });
});
