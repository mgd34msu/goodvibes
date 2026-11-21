import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import {
  STRING_SCHEMA,
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  objectSchema,
  bodyEnvelopeSchema,
  methodDescriptor,
} from './method-catalog-shared.js';

const EMAIL_INBOX_MESSAGE_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  from: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  date: STRING_SCHEMA,
  unread: BOOLEAN_SCHEMA,
  bodyPreview: STRING_SCHEMA,
  messageId: STRING_SCHEMA,
  /** The daemon's triage label for this message, when its inbox mirror holds a settled one. */
  triageLabel: { type: 'string', enum: ['spam', 'priority', 'normal'] },
  /** Whether privacy screening read it in the inbox mirror; `not-screened`: only code checked it, `screeningReason` says why. */
  screening: { type: 'string', enum: ['screened', 'not-screened'] },
  screeningReason: STRING_SCHEMA,
}, ['uid', 'from', 'subject', 'date', 'unread', 'bodyPreview', 'messageId']);

/**
 * A FETCH response on the returned page that the client could not read.
 *
 * Present only when there were any. A page can come back short for two
 * different reasons, a message expunged between the search and the fetch, or
 * an answer this client could not read, and `total` cannot tell them apart
 * because it counts the SEARCH match while the loss happens at the FETCH.
 */
const EMAIL_INBOX_UNREADABLE_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  detail: STRING_SCHEMA,
}, ['detail']);

const EMAIL_ATTACHMENT_SCHEMA = objectSchema({
  filename: STRING_SCHEMA,
  contentType: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
}, ['filename', 'contentType', 'sizeBytes']);

const EMAIL_MESSAGE_DETAIL_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  from: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  date: STRING_SCHEMA,
  messageId: STRING_SCHEMA,
  bodyText: STRING_SCHEMA,
  bodyHtml: STRING_SCHEMA,
  attachments: arraySchema(EMAIL_ATTACHMENT_SCHEMA),
  /** The mailbox generation the UID was read under; email.inbox.update needs it. */
  uidValidity: NUMBER_SCHEMA,
  /**
   * Body sections the message declares that could not be fetched, each with
   * why. Present only when one failed: the body fields are then empty for them
   * because they were not read, not because the message has no text.
   */
  bodyUnavailable: arraySchema(objectSchema({ section: STRING_SCHEMA, reason: STRING_SCHEMA }, ['section', 'reason'])),
}, ['uid', 'from', 'subject', 'date', 'messageId', 'bodyText']);

const EMAIL_DRAFT_SUMMARY_SCHEMA = objectSchema({
  uid: NUMBER_SCHEMA,
  to: STRING_SCHEMA,
  subject: STRING_SCHEMA,
  date: STRING_SCHEMA,
  inReplyTo: STRING_SCHEMA,
  body: STRING_SCHEMA,
}, ['uid', 'to', 'subject', 'date', 'inReplyTo', 'body']);

/**
 * Email operator methods, inbox read and outbound send through the standard
 * operator method protocol.
 *
 * These are SERVED. `registerEmailGatewayMethods`
 * (control-plane/routes/email.ts) attaches an in-process handler to each id
 * over an `EmailGatewayService`, the daemon composition supplies the
 * IMAP/SMTP-backed implementation from `platform/email`, and
 * the gateway REST arm serves each advertised http path with the same handler, so
 * the REST path and the methodId-invoke endpoint resolve identically.
 *
 * They did not used to be, and the consequence was not a 404 on an obscure
 * path. For a long time no /api/email surface existed at any prefix and no
 * handler was registered, so these carried `invokable: false` to say
 * "cataloged, not callable" rather than let a caller find out the hard way.
 * The reason was never the routing, the only IMAP/SMTP implementation lived
 * inside one product, so the daemon had nothing to call, and nothing the
 * daemon did unattended could send a message: not a schedule, not a trigger,
 * not a channel reply. Hoisting the service into the platform is what made serving
 * them possible.
 *
 * The route-reconcile regression gate (method-catalog-route-reconcile.ts,
 * exercised in test/capability-route-reconcile.test.ts) keeps the two halves
 * honest in both directions: a descriptor advertising an http path no route
 * serves reddens it, and so does one that quietly reappears unmarked.
 */
/**
 * An open verification expectation, as the disclosure verbs report it.
 *
 * `authority` is on the wire deliberately. It is the literal
 * `'evidence-only'` on every record, and carrying it means a consumer reads
 * the grant's scope from the record rather than assuming it from the fact
 * that a match occurred: satisfying an expectation establishes control of an
 * address and grants no command authority at all.
 */
const EMAIL_EXPECTATION_PROPERTIES = {
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  serviceDomain: STRING_SCHEMA,
  recipientAddress: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  openedAt: STRING_SCHEMA,
  expiresAt: STRING_SCHEMA,
  authority: STRING_SCHEMA,
  remainingMs: NUMBER_SCHEMA,
};
const EMAIL_EXPECTATION_REQUIRED = [
  'id', 'kind', 'serviceDomain', 'recipientAddress', 'purpose',
  'openedAt', 'expiresAt', 'authority',
];
const EMAIL_EXPECTATION_SCHEMA = objectSchema(EMAIL_EXPECTATION_PROPERTIES, EMAIL_EXPECTATION_REQUIRED);

/**
 * What opening an expectation answers: the expectation, plus whether any
 * mailbox is being read right now. An expectation registered while nothing
 * watches the mailbox can only run out, and the caller should learn that now.
 */
const EMAIL_EXPECTATION_OPENED_SCHEMA = objectSchema({
  ...EMAIL_EXPECTATION_PROPERTIES,
  watching: objectSchema({
    running: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['running', 'reason']),
}, [...EMAIL_EXPECTATION_REQUIRED, 'watching']);

/**
 * Where one expectation stands after a wait. `state` says which of the other
 * fields are present: `waiting` carries the open expectation (with remainingMs)
 * and `arrivals`; `arrived` the closed expectation, the message id, when, and the
 * `token` (a link with its host, or a code); `expired` and `capability-lost`
 * carry `detail` and `arrivals`; `cancelled` the expectation; `unknown` only the
 * `id` asked about. `watching` says whether a mailbox is being read right now.
 */
const EMAIL_EXPECTATION_WAIT_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['waiting', 'arrived', 'expired', 'capability-lost', 'cancelled', 'unknown'] },
  id: STRING_SCHEMA,
  expectation: EMAIL_EXPECTATION_SCHEMA,
  arrivals: arraySchema(objectSchema({
    messageId: STRING_SCHEMA,
    at: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['messageId', 'at', 'reason'])),
  messageId: STRING_SCHEMA,
  at: STRING_SCHEMA,
  token: objectSchema({
    kind: { type: 'string', enum: ['link', 'code'] },
    url: STRING_SCHEMA,
    linkHost: STRING_SCHEMA,
    code: STRING_SCHEMA,
  }, ['kind']),
  detail: STRING_SCHEMA,
  watching: objectSchema({
    running: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['running', 'reason']),
}, ['state']);

/**
 * One persisted cursor, disclosed.
 *
 * `position` is a STRING on both sources deliberately. A Gmail `historyId` is
 * a decimal uint64 that loses precision the moment it becomes a JS number, and
 * an IMAP position is two numbers rather than one, a single numeric field
 * could only be wrong for one of them.
 */
const EMAIL_INBOUND_CURSOR_SCHEMA = objectSchema({
  account: STRING_SCHEMA,
  mailbox: STRING_SCHEMA,
  source: STRING_SCHEMA,
  position: STRING_SCHEMA,
  updatedAt: STRING_SCHEMA,
  ageMs: NUMBER_SCHEMA,
}, ['account', 'mailbox', 'source', 'position', 'updatedAt', 'ageMs']);

/** An open expectation as the inbound status discloses it (§9.2). */
const EMAIL_INBOUND_EXPECTATION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  serviceDomain: STRING_SCHEMA,
  recipientAddress: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  openedAt: STRING_SCHEMA,
  expiresAt: STRING_SCHEMA,
  remainingMs: NUMBER_SCHEMA,
}, ['id', 'serviceDomain', 'recipientAddress', 'purpose', 'openedAt', 'expiresAt', 'remainingMs']);

/**
 * The source in force, with its latency stated as a SENTENCE.
 *
 * Not as a millisecond number: the whole reason `SourceLatency` is on the
 * source interface is that "real-time" must never be claimed for a poll, and a
 * consumer handed a raw interval is a consumer that will write that sentence
 * itself, wrongly. `kind` is optional because nothing is in force before a
 * source is selected, and a refusal has no source to name.
 */
const EMAIL_INBOUND_SOURCE_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  basis: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  latency: STRING_SCHEMA,
}, ['basis', 'detail', 'latency']);

/** The runtime capability verdict (§3.4b). Absent before anything is probed. */
const EMAIL_INBOUND_CAPABILITY_SCHEMA = objectSchema({
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  fix: STRING_SCHEMA,
}, ['state', 'reason', 'detail', 'fix']);

/** What each store is holding and what bounds it, the §9 disclosure. */
const EMAIL_INBOUND_RETENTION_SCHEMA = objectSchema({
  cursors: objectSchema({
    kept: NUMBER_SCHEMA,
    maxCursors: NUMBER_SCHEMA,
  }, ['kept', 'maxCursors']),
  // `kept` is what a read serves; `stored` is what the file holds. Both,
  // because `kept` alone was computed from a filtered view and so told the
  // owner their store was bounded while it was not. `reapedOnWrite` discloses
  // the records write-time bounding removed, which no sweep report can itemise.
  records: objectSchema({
    kept: NUMBER_SCHEMA,
    stored: NUMBER_SCHEMA,
    retentionDays: NUMBER_SCHEMA,
    maxRecords: NUMBER_SCHEMA,
    maxBodyExcerptChars: NUMBER_SCHEMA,
    reapedOnWrite: NUMBER_SCHEMA,
  }, ['kept', 'stored', 'retentionDays', 'maxRecords', 'maxBodyExcerptChars', 'reapedOnWrite']),
  expectations: objectSchema({
    open: NUMBER_SCHEMA,
    maxOpen: NUMBER_SCHEMA,
  }, ['open', 'maxOpen']),
  lastSweep: objectSchema({
    sweptAt: NUMBER_SCHEMA,
    trigger: STRING_SCHEMA,
    summary: STRING_SCHEMA,
    // One "<store>: <detail>" line per store the sweep could not clean.
    failures: arraySchema(STRING_SCHEMA),
  }, ['sweptAt', 'trigger', 'summary', 'failures']),
}, ['cursors', 'records', 'expectations']);

/**
 * Email's health entry, shaped like a channel's, and deliberately NOT one.
 *
 * `state`, `enabled`, `id` and `label` line up with `ChannelStatusSnapshot` so
 * a health view renders it in the same list; `surface` is absent because email
 * is not a `ChannelSurface`, and widening that union would hand inbound mail
 * the accounts, delivery and ingress-authorization capabilities §2.1 removes.
 */
const EMAIL_INBOUND_HEALTH_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  account: STRING_SCHEMA,
  mailbox: STRING_SCHEMA,
  mode: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['kind', 'id', 'label', 'state', 'enabled', 'account', 'mailbox', 'mode', 'reason']);

/** One persisted store's readability, as `describeStores` reports it. */
const EMAIL_INBOUND_STORE_SCHEMA = objectSchema({
  store: STRING_SCHEMA,
  state: STRING_SCHEMA,
  detail: STRING_SCHEMA,
}, ['store', 'state', 'detail']);

/**
 * Whether arriving mail is actually reaching the owner.
 *
 * `state: 'ok'` carries nothing else, which is why every other field is
 * optional here: a refusal has a reason, a fix, a start time and a count, and
 * "notices are getting through" has none of those and must not be padded with
 * empty strings that read as facts.
 */
const EMAIL_INBOUND_NOTICE_DELIVERY_SCHEMA = objectSchema({
  state: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  fix: STRING_SCHEMA,
  since: STRING_SCHEMA,
  unannounced: NUMBER_SCHEMA,
}, ['state']);

export const builtinGatewayEmailMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'email.inbox.list',
    title: 'List Email Inbox',
    description:
      'Return inbox message summaries fetched live from the configured IMAP account, newest first (ordered by server-assigned UID, never by the sender-written Date header). Read-only (EXAMINE / BODY.PEEK); never marks messages read. `before` pages backwards: pass the smallest UID of the page you have to get the next older page; `total` counts every match. When the server answered for a message and the daemon could not read the answer, the page is short and `unreadable` says so, an omitted message is not by itself evidence that it was deleted. A message the daemon\'s inbox mirror has labelled carries `triageLabel` (spam, priority or normal); one not labelled yet has none. A message the mirror holds carries `screening`: `screened`, or `not-screened` when only code checked it for credential and card text, with `screeningReason`. `uidValidity` is the mailbox generation the page\'s UIDs belong to (absent only when the server reports none); email.inbox.update needs it.',
    category: 'email',
    effects: ['email.read'],
    http: { method: 'GET', path: '/api/email/inbox' },
    inputSchema: objectSchema({
      limit: NUMBER_SCHEMA,
      since: STRING_SCHEMA,
      unreadOnly: BOOLEAN_SCHEMA,
      before: NUMBER_SCHEMA,
    }),
    // `unreadable` is deliberately NOT required: it is absent on every page
    // that came back whole, which is almost all of them, and a required-but-
    // empty array would make "nothing went wrong" and "nobody looked" the same
    // shape on the wire.
    outputSchema: objectSchema({
      messages: arraySchema(EMAIL_INBOX_MESSAGE_SCHEMA),
      total: NUMBER_SCHEMA,
      unreadable: arraySchema(EMAIL_INBOX_UNREADABLE_SCHEMA),
      uidValidity: NUMBER_SCHEMA,
    }, ['messages', 'total']),
  }),
  methodDescriptor({
    id: 'email.inbox.read',
    title: 'Read Email Message',
    description:
      'Return the full body and attachment metadata for a single inbox message by IMAP UID, with `uidValidity`, the mailbox generation it was read under (email.inbox.update needs it). Read-only (BODY.PEEK; does not mark as read).',
    category: 'email',
    effects: ['email.inspect'],
    http: { method: 'GET', path: '/api/email/inbox/{uid}' },
    inputSchema: objectSchema({ uid: NUMBER_SCHEMA }, ['uid']),
    outputSchema: EMAIL_MESSAGE_DETAIL_SCHEMA,
  }),
  methodDescriptor({
    id: 'email.draft.create',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Create Email Draft',
    description:
      'Append a draft message to the configured IMAP Drafts folder. Distinct from the local channel draft store. A draft is never sent by this verb and takes no confirmation field. To change a saved draft, use email.draft.update with its uid and uidValidity: a second create leaves two drafts. A save whose answer from the mail server was lost is reported as one that may have been saved, never as not saved; creating the same draft again in this daemon run looks for it in the Drafts folder first (by the Message-ID it was saved under) and returns it instead of saving a second copy.',
    category: 'email',
    effects: ['email.administer'],
    http: { method: 'POST', path: '/api/email/drafts' },
    inputSchema: bodyEnvelopeSchema({
      to: STRING_SCHEMA,
      subject: STRING_SCHEMA,
      body: STRING_SCHEMA,
      inReplyTo: STRING_SCHEMA,
      references: STRING_SCHEMA,
    }, ['to', 'subject', 'body']),
    // `uid` is deliberately NOT required: it is the APPENDUID, which only a
    // server advertising UIDPLUS returns. Requiring it would force a number to
    // be invented for every other server, and an invented uid is one a later
    // fetch cannot resolve. `mailbox` names the Drafts folder the message
    // actually landed in, which differs per provider ([Gmail]/Drafts, Drafts).
    outputSchema: objectSchema({
      draftId: STRING_SCHEMA,
      uid: NUMBER_SCHEMA,
      uidValidity: NUMBER_SCHEMA,
      mailbox: STRING_SCHEMA,
    }, ['draftId', 'mailbox']),
    dangerous: true,
  }),
  methodDescriptor({
    id: 'email.draft.update',
    repeat: 'unsafe',
    confirmation: 'not-declined',
    title: 'Replace an Email Draft',
    description:
      'Replace one saved draft in the IMAP Drafts folder with an edited one, so the folder keeps one copy: the edited message is appended, then the draft named by `uid` is removed. `uid` and `uidValidity` are what email.drafts.list (or email.draft.create) returned; a reset Drafts folder or a draft that is gone is refused with nothing changed, and a server that cannot remove one message by UID (no UIDPLUS) is refused before anything is written. A draft is never sent by this verb. Answers the new draft\'s { draftId, uid?, uidValidity?, mailbox } and `replaced`, the UID removed.',
    category: 'email',
    effects: ['email.administer'],
    // Served through the control-plane invoke endpoint, like email.inbox.update.
    transport: ['ws'],
    inputSchema: objectSchema({
      uid: NUMBER_SCHEMA,
      uidValidity: NUMBER_SCHEMA,
      to: STRING_SCHEMA,
      subject: STRING_SCHEMA,
      body: STRING_SCHEMA,
      inReplyTo: STRING_SCHEMA,
      references: STRING_SCHEMA,
    }, ['uid', 'uidValidity', 'to', 'subject', 'body']),
    outputSchema: objectSchema({
      draftId: STRING_SCHEMA,
      uid: NUMBER_SCHEMA,
      uidValidity: NUMBER_SCHEMA,
      mailbox: STRING_SCHEMA,
      replaced: NUMBER_SCHEMA,
    }, ['draftId', 'mailbox', 'replaced']),
    dangerous: true,
  }),
  methodDescriptor({
    id: 'email.send',
    confirmation: 'confirm',
    replay: { in: 'body', name: 'clientSendId', behavior: 'A repeat with the same `clientSendId` and the same message within ten minutes returns the first answer instead of sending again; the same id with a different message is 409 CLIENT_SEND_ID_REUSED.' },
    recipients: ['to'],
    effects: ['email.administer', 'outward.send'],
    title: 'Send Email',
    description:
      'Send a composed email via the configured SMTP account. Irreversible external send; requires confirm: true and explicit user review of recipients and body. Pass a clientSendId (8-128 letters, digits, - or _) chosen when the message was composed: a repeat with the same id and the same message within ten minutes returns the first answer instead of sending again (the id also becomes the Message-ID), and the same id with a different message is refused (409 CLIENT_SEND_ID_REUSED). A send whose final server reply was lost fails with EMAIL_DELIVERY_UNCONFIRMED: it may have gone, and repeating it with the same id will not send it twice.',
    category: 'email',
    http: { method: 'POST', path: '/api/email/send' },
    inputSchema: bodyEnvelopeSchema({
      to: STRING_SCHEMA,
      subject: STRING_SCHEMA,
      body: STRING_SCHEMA,
      inReplyTo: STRING_SCHEMA,
      confirm: BOOLEAN_SCHEMA,
      clientSendId: STRING_SCHEMA,
    }, ['to', 'subject', 'body']),
    outputSchema: objectSchema({
      messageId: STRING_SCHEMA,
      sentAt: STRING_SCHEMA,
    }, ['messageId', 'sentAt']),
    dangerous: true,
  }),
  methodDescriptor({
    id: 'email.inbox.update',
    repeat: 'safe',
    confirmation: 'not-declined',
    title: 'Mark, Archive or Delete an Email',
    description:
      'Change one inbox message by IMAP UID: action seen or unseen sets or clears its read flag; archive moves it to the folder the server marks Archive (or All Mail); delete moves it to the folder the server marks Trash, so it can be recovered there. A server with no such folder is refused and nothing changes; nothing here expunges permanently. uidValidity is required: the mailbox generation email.inbox.list or email.inbox.read returned with the uid, so a reset mailbox refuses instead of changing whichever message now holds that UID. Answers { uid, action, movedTo? }.',
    category: 'email',
    effects: ['email.administer'],
    // Served through the control-plane invoke endpoint, like checkpoints.* and rewind.*.
    transport: ['ws'],
    inputSchema: objectSchema({
      uid: NUMBER_SCHEMA,
      action: { type: 'string', enum: ['seen', 'unseen', 'archive', 'delete'] },
      uidValidity: NUMBER_SCHEMA,
    }, ['uid', 'action', 'uidValidity']),
    outputSchema: objectSchema({
      uid: NUMBER_SCHEMA,
      action: STRING_SCHEMA,
      movedTo: STRING_SCHEMA,
    }, ['uid', 'action']),
  }),
  methodDescriptor({
    id: 'email.attachment.get',
    title: 'Download an Email Attachment',
    description:
      'Return one attachment of an inbox message as base64 bytes, by UID and its position (from 0) in the attachments list email.inbox.read returns. Read-only (BODY.PEEK). Meant to be saved as a file, never rendered: the bytes are whatever the sender attached. Attachments over 25 MB are refused with the reason.',
    category: 'email',
    effects: ['email.inspect'],
    // Served through the control-plane invoke endpoint, like checkpoints.* and rewind.*.
    transport: ['ws'],
    inputSchema: objectSchema({ uid: NUMBER_SCHEMA, index: NUMBER_SCHEMA }, ['uid', 'index']),
    outputSchema: objectSchema({
      filename: STRING_SCHEMA,
      contentType: STRING_SCHEMA,
      sizeBytes: NUMBER_SCHEMA,
      contentBase64: STRING_SCHEMA,
    }, ['filename', 'contentType', 'sizeBytes', 'contentBase64']),
  }),
  methodDescriptor({
    id: 'email.drafts.list',
    title: 'List Email Drafts',
    description:
      'Return the newest drafts (default 25, at most 100) in the account\'s Drafts folder, newest first, each with its recipient, subject, date, the Message-ID it replies to and up to 64 KB of body text, so a draft can be reopened in a composer; `uidValidity` is the Drafts folder generation the UIDs belong to, which email.draft.update needs to replace one. `before` (a UID) reads the page of drafts older than it: pass the smallest UID of a page to read the one before, until `total` drafts are read. Read-only.',
    category: 'email',
    effects: ['email.inspect'],
    // Served through the control-plane invoke endpoint, like checkpoints.* and rewind.*.
    transport: ['ws'],
    inputSchema: objectSchema({ limit: NUMBER_SCHEMA, before: NUMBER_SCHEMA }),
    outputSchema: objectSchema({
      drafts: arraySchema(EMAIL_DRAFT_SUMMARY_SCHEMA),
      total: NUMBER_SCHEMA,
      mailbox: STRING_SCHEMA,
      uidValidity: NUMBER_SCHEMA,
    }, ['drafts', 'total', 'mailbox']),
  }),
  /**
   * The four expectation verbs carry NO `http` binding, unlike the mail
   * verbs above.
   *
   * They are not a REST surface. They are how an already-authorized
   * workstream, an account signup, a purchase, declares in advance that a
   * specific message is expected at a specific address from a specific
   * domain, before it submits the form. The callers are inside the daemon,
   * reaching them over the control plane; nothing external consumes them, and
   * a descriptor advertising an `/api/...` path that no route serves is
   * exactly what the route-reconcile gate exists to redden.
   *
   * `transport: ['ws']` follows from that and is not decoration. The default
   * is `['http', 'ws']`, and declaring http while serving no http path is a
   * method advertising a transport it cannot be reached on, which the
   * transport-honesty gate catches, correctly. The declaration has to match
   * the reachability, not the convention.
   *
   * Every input `required` array below is declared explicitly and matches
   * what the handler enforces.
   */
  methodDescriptor({
    id: 'email.expectation.open',
    repeat: 'unsafe',
    transport: ['ws'],
    title: 'Open Verification Expectation',
    description:
      'Register, in advance, that a verification message is expected at one address from one service domain, within a bounded window. Called by the workstream that already holds authority BEFORE it submits the signup or checkout form. Grants evidence-only authority: a matching message proves control of the address and can never start work, widen the expectation or extend its window. The answer carries `watching`: whether a mailbox is being read right now and, when not, why. Opening is not refused while nothing watches (a cluster standby legitimately does not), but a message cannot arrive then.',
    category: 'email',
    effects: ['email.administer'],
    inputSchema: objectSchema({
      serviceDomain: STRING_SCHEMA,
      recipientAddress: STRING_SCHEMA,
      purpose: STRING_SCHEMA,
      windowMs: NUMBER_SCHEMA,
      kind: STRING_SCHEMA,
    }, ['serviceDomain', 'recipientAddress', 'purpose']),
    outputSchema: EMAIL_EXPECTATION_OPENED_SCHEMA,
  }),
  methodDescriptor({
    id: 'email.expectation.list',
    transport: ['ws'],
    title: 'List Verification Expectations',
    description:
      'Return every open verification expectation with its recipient, service domain, purpose and remaining window. Disclosure: an expectation is a live correlation key, and the owner is entitled to see which ones exist.',
    category: 'email',
    effects: ['email.read'],
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      expectations: arraySchema(EMAIL_EXPECTATION_SCHEMA),
      total: NUMBER_SCHEMA,
    }, ['expectations', 'total']),
  }),
  methodDescriptor({
    id: 'email.expectation.cancel',
    repeat: 'safe',
    transport: ['ws'],
    title: 'Cancel Verification Expectation',
    description:
      'Close an expectation the workstream abandoned. A signup dropped before submission otherwise leaves a live correlation key for an address nobody is waiting on, occupying one of the bounded open slots until its window elapses. Cancelling an id that is not open is an answer, not a failure.',
    category: 'email',
    effects: ['email.administer'],
    inputSchema: objectSchema({ id: STRING_SCHEMA }, ['id']),
    outputSchema: objectSchema({
      cancelled: BOOLEAN_SCHEMA,
      expectation: EMAIL_EXPECTATION_SCHEMA,
    }, ['cancelled']),
  }),
  methodDescriptor({
    id: 'email.expectation.wait',
    transport: ['ws'],
    title: 'Wait For Verification Message',
    description:
      'Where one expectation stands, waiting up to timeoutMs (default 0, at most 60000) for it to change. state "arrived" carries the verification link or code the daemon took from the matching message (token); "waiting" lists matching messages that held none (arrivals); "expired", "capability-lost" and "cancelled" say how it ended, with detail; "unknown" means no expectation with that id is open or remembered. watching says whether a mailbox is being read right now, so "nothing yet" is never confused with "nobody is looking". Call it again while the state is "waiting".',
    category: 'email',
    effects: ['email.inspect'],
    inputSchema: objectSchema({ id: STRING_SCHEMA, timeoutMs: NUMBER_SCHEMA }, ['id']),
    outputSchema: EMAIL_EXPECTATION_WAIT_SCHEMA,
  }),
  /**
   * The inbound watcher's disclosure verb (§9).
   *
   * Anything persisted across restarts must say what it holds, and three
   * things outlive a restart here: the cursors, the inbound records, and the
   * expectations. This verb is where the owner reads all three, plus what the
   * watcher is actually doing right now, which source is in force and what
   * that source COSTS in latency, so "real-time" is never claimed for a poll.
   *
   * `transport: ['ws']` for the same reason the expectation verbs carry it:
   * there is no `/api/email/inbound/status` route, and a descriptor
   * advertising a transport it cannot be reached on is what the
   * transport-honesty gate exists to fail.
   */
  methodDescriptor({
    id: 'email.inbound.status',
    transport: ['ws'],
    title: 'Inbound Mail Status',
    description:
      'Disclose the inbound-mail watcher: whether it is running and why, which source is reading the mailbox and the delay that source actually costs, the current capability verdict, every persisted cursor with its position and age, every open verification expectation with its remaining window, whether each store could be read, whether arriving mail is actually being announced to the owner, and what each store retains before it is reaped. Read-only.',
    category: 'email',
    effects: ['email.read'],
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      enabled: BOOLEAN_SCHEMA,
      running: BOOLEAN_SCHEMA,
      mode: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      account: STRING_SCHEMA,
      mailbox: STRING_SCHEMA,
      source: EMAIL_INBOUND_SOURCE_SCHEMA,
      capability: EMAIL_INBOUND_CAPABILITY_SCHEMA,
      cursors: arraySchema(EMAIL_INBOUND_CURSOR_SCHEMA),
      expectations: arraySchema(EMAIL_INBOUND_EXPECTATION_SCHEMA),
      retention: EMAIL_INBOUND_RETENTION_SCHEMA,

      stores: arraySchema(EMAIL_INBOUND_STORE_SCHEMA),
      noticeDelivery: EMAIL_INBOUND_NOTICE_DELIVERY_SCHEMA,
      health: EMAIL_INBOUND_HEALTH_SCHEMA,
    }, [
      'enabled', 'running', 'mode', 'reason', 'account', 'mailbox',
      'source', 'cursors', 'expectations', 'retention', 'stores',
      'noticeDelivery', 'health',
    ]),
  }),
];
