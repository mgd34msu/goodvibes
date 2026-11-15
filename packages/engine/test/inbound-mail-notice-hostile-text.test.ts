/**
 * Text a sender controls, rendered into a notice the owner reads on a phone.
 *
 * Covers characters that reorder what is read, a host that carries a port
 * (which clients linkify), card shapes in the free-text outcome fields, and
 * channel names that are not channels.
 */

import { describe, expect, test } from 'bun:test';
import {
  noticeChannelForSurface,
  renderNoticeForChannel,
} from '../platform/src/platform/email/inbound-notice-channels.ts';
import { receiptTimestamp, renderInboundMailNotice } from '../platform/src/platform/email/inbound-notice.ts';
import type { InboundOutcome, StructuredNotice } from '../platform/src/platform/email/inbound-notice.ts';
import { useSecurityReadings } from './helpers/security-readings.ts';

useSecurityReadings();

const ZERO_WIDTH_SPACE = '​';
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
const CARD = '4111111111111111';

async function produce(subject: string, outcome: InboundOutcome): Promise<StructuredNotice> {
  return renderInboundMailNotice({
    senderDisplay: 'someone@sender.test',
    subject,
    deliveredTo: null,
    outcome,
    links: [],
    receivedAt: receiptTimestamp(new Date('2026-07-28T09:00:00.000Z')),
  });
}

function everySpanText(notice: StructuredNotice): string {
  return notice.fields.flatMap((field) => field.value.map((span) => span.text)).join('\n');
}

describe('direction-override characters in a sender-written field', () => {
  test.each(['‮', '‪', '⁦', '⁩', '‏'])('%j does not reach the notice', async (mark) => {
    const notice = await produce(`invoice ${mark}fdp.exe`, { kind: 'inert' });
    expect(everySpanText(notice)).not.toMatch(BIDI);
    expect(everySpanText(notice)).toContain('invoice');
  });
});

describe('a host with a port', () => {
  test('is defanged on every channel that renders it', () => {
    const notice: StructuredNotice = {
      title: [{ kind: 'literal', text: 'Mail' }],
      fields: [{ label: 'Subject', value: [{ kind: 'untrusted', text: 'open evil.example:8080/verify now' }] }],
    };
    for (const channel of ['telegram', 'discord', 'slack', 'ntfy', 'unmapped']) {
      expect(renderNoticeForChannel(notice, channel)).toContain(`evil.example${ZERO_WIDTH_SPACE}:8080/verify`);
    }
  });
});

describe('free-text outcome fields', () => {
  test('a card shape in the purpose never reaches the owner', async () => {
    const notice = await produce('s', {
      kind: 'matched-expectation',
      purpose: `pay with ${CARD}`,
      serviceDomain: 'example.com',
    });
    expect(everySpanText(notice)).not.toContain(CARD);
  });

  test('a card shape in the missing capability never reaches the owner', async () => {
    const notice = await produce('s', { kind: 'capability-degraded', missingCapability: `read ${CARD}` });
    expect(everySpanText(notice)).not.toContain(CARD);
  });
});

describe('a channel or surface name that is a property of every object', () => {
  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('%s falls back to the neutral rendering', (name) => {
    const notice: StructuredNotice = {
      title: [{ kind: 'literal', text: 'Mail' }],
      fields: [{ label: 'Subject', value: [{ kind: 'untrusted', text: '*bold* @everyone' }] }],
    };
    const plain = renderNoticeForChannel(notice, 'plain');
    expect(renderNoticeForChannel(notice, name)).toBe(plain);
    expect(noticeChannelForSurface(name)).toBe('plain');
  });
});
