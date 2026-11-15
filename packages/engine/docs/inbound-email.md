# Inbound email

The daemon composes an inbound-mail supervisor for the configured email account.
Its source can use IMAP or Gmail, with persisted cursors, received-message records,
and verification expectations. Arrival is untrusted input; the watcher cannot
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
these change. Changing the mailbox user, the folder or
`surfaces.email.inbound.accounts` needs a daemon restart, and the inbound status
says so. A notice route that keeps failing to deliver is reported as degraded
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
