import type { InboundCapabilityReason } from '../../platform/src/platform/email/inbound/capability-types.ts';

/**
 * Every member of `InboundCapabilityReason`, listed here rather than derived
 * from production.
 *
 * A list read from the production table would "cover" a reason silently added
 * to both without anyone deciding whether `notice-only` can serve it. Typing
 * the keys as `Record<InboundCapabilityReason, true>` makes the compiler
 * demand an entry for every member, so a new reason breaks the typecheck of
 * this file until it is listed (and so reaches every loop below).
 */
const REASON_TABLE: Readonly<Record<InboundCapabilityReason, true>> = {
  'idle-push': true,
  'polling-configured': true,
  'polling-no-idle': true,
  'polling-idle-refused': true,
  'polling-capability-unknown': true,
  'reconnecting': true,
  'server-unavailable': true,
  'credentials-missing': true,
  'credentials-rejected': true,
  'mailbox-unreadable': true,
  'uidvalidity-missing': true,
  'mailbox-position-unknown': true,
  'fetch-refused': true,
  'gmail-metadata-only': true,
  'gmail-metadata-notice-only': true,
  'fetch-unreadable': true,
  'local-store-unwritable': true,
  'watcher-stopped-unexpectedly': true,
  'bodies-unfetchable': true,
  'bodies-unproven': true,
};
export const ALL_REASONS: readonly InboundCapabilityReason[] = Object.keys(REASON_TABLE) as InboundCapabilityReason[];
