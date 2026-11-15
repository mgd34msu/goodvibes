/** The canonical full-message read. */
import { withEmailReadConnection } from './email-read-connection.js';
import type { EmailMessageRead } from './email-read-results.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';

export async function readEmailMessage(
  deps: EmailServiceDeps,
  config: EmailConfig,
  uid: number,
  recordIngest: (messages: readonly { readonly from: string; readonly text: string }[], assertCurrent: () => void) => void,
): Promise<EmailMessageRead> {
  // The account lifetime and mailbox-wide ordering precede ANY credential/I/O
  // await, so config/secret changes while connecting cannot bless an old read.
  const sourceRead = deps.replySubjectSourceOwner?.beginRead(config);
  const read = await withEmailReadConnection(deps, config, sourceRead, undefined,
    (client) => client.readMessageDetail(uid));
  const current = (): void => sourceRead?.assertCurrent();
  current();
  if (read.outcome === 'read') {
    recordIngest([{ from: read.detail.from, text: `${read.detail.subject}\n${read.detail.bodyText}`.trim() }], current);
    current();
    return read;
  }
  if (read.outcome === 'gone') return { outcome: 'gone' };
  return {
    outcome: 'unreadable',
    problems: read.problems.map((problem) => ({ uid: problem.uid, detail: problem.detail })),
  };
}
