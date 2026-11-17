# Inbound email

The daemon composes an inbound-mail supervisor for each account in
`surfaces.email.inbound.accounts`. The first is the daemon's own mailbox
(`surfaces.email.*`), read over IMAP or Gmail. Each further account is read over
IMAP with the connection `surfaces.email.inbound.mailboxes` gives it, for example
`{"signups":{"host":"imap.example.com","user":"signups@example.com"}}` (optional
`port`, `secure`, `mailbox` and `passwordRef`; without `passwordRef` the password is
the secret `GOODVIBES_EMAIL_INBOUND_<ACCOUNT>_PASSWORD`). All mailboxes share the
persisted cursors (one per account), received-message records, verification
expectations and notice route, and are started and stopped together. The inbound
health entry and `email.inbound.status` name each further mailbox's state, and an
account with no usable entry is named with what to fix. Arrival is untrusted input; the watcher cannot
start an agent or a session merely because a message arrived.

The composition in `platform/src/platform/daemon/facade-inbound-mail.ts` reads
`surfaces.email.inbound.*` settings and stores its state through the daemon's
user-path resolver. `facade-builtin-channels.ts` supplies the adopted Gmail reader
and includes inbound email in the runtime's health reporting. An enabled mailbox
that cannot be composed is reported as unavailable.

Capability checks distinguish a readable mailbox from a connection that exists
but cannot supply the required content. A verification expectation can fail with
`capability-lost` or expire without a matching message; these outcomes are reported.

Settings changes take effect without a restart for the IMAP host, port and TLS
setting, `surfaces.email.inbound.enabled` and `surfaces.email.inbound.source`, and
for a corrected credential or Google grant. A mailbox that stopped because of a
refused credential, an unreadable mailbox or a failed start is tried again when
these change. Adding, changing or removing a further account (in
`surfaces.email.inbound.accounts` or `surfaces.email.inbound.mailboxes`) takes
effect without a restart. Changing the first mailbox's user, its folder or the
first account name needs a daemon restart, and the inbound status says so. A notice route that keeps failing to deliver is reported as degraded
while the message waits to be retried. Switching notices off
(`surfaces.email.inbound.notice.mode` set to `none`) drops a recorded notice
refusal instead of hiding it, so switching them back on does not bring back a
refusal nobody has seen since. Stopping inbound mail waits at most fifteen
seconds for a start that is still in flight (a recovery sweep or a Google
lookup); a slower start finishes in the background and releases what it
builds, because the mailbox is no longer wanted by then.

The complete design and implementation history
preserves the authority model, protocol decisions, test plan, reproduced defects,
and their dated dispositions. Its historical findings are not a claim that every
listed defect remains present or that all have been resolved. The
recorded inbound-mail review
retains the supporting review evidence and corrections.
