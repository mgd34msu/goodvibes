/** Owner choices only. No source body, token, caller-minted provenance or implicit defaults. */
import { z } from 'zod/v4';
const id = z.string().min(1).max(256);
const duration = z.number().int().min(1).max(2_147_483_647);
export const delegatedSourceRefSchema = z.object({ sessionId: id, inputId: id, sourceId: id, sourceRevision: id, requestId: id }).strict();
export const delegatedTelegramConfigureSchema = z.object({
  chatId: id, threadId: id.optional(), accountId: id,
  pendingRetention: z.literal('memory-only-until-deadline'), pendingRetentionMs: duration, configurationLifetimeMs: duration,
  onExpiry: z.literal('release-original-and-hold'),
}).strict();
export const delegatedInboundChoicesSchema = z.object({
    processingPurpose: z.literal('accept-external-message-for-owner-review'),
    sourceRetention: z.literal('memory-only-until-review-close-or-deadline'), sourceRetentionMs: duration,
    derivedRecord: z.literal('external-source-reference-only-v1'), derivedRecordRetentionMs: duration,
    execution: z.literal('none'), ownerMayReadOriginal: z.literal(true),
  }).strict();
export const delegatedTelegramDecisionSchema = z.object({
  approvalId: id, ref: delegatedSourceRefSchema,
  approved: z.boolean(),
  choices: delegatedInboundChoicesSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.choices && value.choices.derivedRecordRetentionMs < value.choices.sourceRetentionMs) ctx.addIssue({ code: 'custom', message: 'Review record must outlive its original-source memory window.' });
  if (value.approved !== (value.choices !== undefined)) ctx.addIssue({ code: 'custom', message: 'Approval requires explicit choices; denial must not carry a grant.' });
});
export const delegatedTelegramLookupSchema = z.object({ ref: delegatedSourceRefSchema }).strict();
export const delegatedTelegramRevokeSchema = z.object({ configurationId: id }).strict();
/** Release names a configuration, or the selected chat itself when no configuration exists (a held configure, or a restart). */
export const delegatedTelegramReleaseSchema = z.union([delegatedTelegramRevokeSchema, z.object({ chatId: id, threadId: id.optional() }).strict()]);
export type DelegatedTelegramConfiguration = z.infer<typeof delegatedTelegramConfigureSchema>;
export type DelegatedTelegramDecision = z.infer<typeof delegatedTelegramDecisionSchema>;
export type DelegatedInboundChoices = NonNullable<DelegatedTelegramDecision['choices']>;

/** Owner identity metadata only (a pairing or the owner's own machine); no bearer token, source content, or derived digest. */
export const delegatedReviewOwnerSchema = z.object({
  kind: z.enum(['pairing-token', 'local']), principalId: id, tokenId: id, authorityId: id, authorityRevision: id,
  scopes: z.array(id).max(256),
}).strict();
export type DelegatedReviewOwner = Readonly<Omit<z.infer<typeof delegatedReviewOwnerSchema>, 'scopes'>> & { readonly scopes: readonly string[] };
export const delegatedReviewRecordSchema = z.object({
  id, ref: delegatedSourceRefSchema,
  origin: z.object({ kind: z.literal('external-original'), accountId: id, accountRevision: id, routeId: id, routeRevision: id }).strict(),
  configurationId: id, ownerRevision: id, owner: delegatedReviewOwnerSchema.optional(), workspaceRevision: id, approvalId: id, choices: delegatedInboundChoicesSchema,
  acceptedAt: z.number(), sourceExpiresAt: z.number(), recordExpiresAt: z.number(),
  // accepted-for-review -> reviewed (the owner read the original) -> gone (cancelled by the owner, or expired).
  state: z.enum(['accepted-for-review', 'reviewed', 'cancelled']), execution: z.literal('not-started'),
}).strict();
/**
 * Why delegated intake held a message or refused a command. Each code has one
 * sentence and one next step (`delegatedHold`), so an agent or a person can
 * tell "wait for the owner" from "the request was wrong" from "try later"
 * without reading prose.
 */
export const DELEGATED_HOLD_REASONS = [
  'account-proof-required', 'account-not-chosen', 'account-proof-unavailable', 'account-proof-changed',
  'workspace-changed', 'lifecycle-changed', 'owner-changed', 'not-owner',
  'message-identity-missing', 'tracking-full', 'message-edited',
  'no-configuration', 'configuration-not-current', 'source-unavailable', 'missing-source-proof',
  'configuration-unavailable', 'chat-not-selected', 'already-decided', 'lifetime-exceeds-configuration',
  'not-durably-resolved', 'review-queue-refused', 'review-held', 'review-closed', 'handoff-held',
] as const;
export type DelegatedHoldReason = typeof DELEGATED_HOLD_REASONS[number];

const HOLD_TEXT: Readonly<Record<DelegatedHoldReason, { readonly message: string; readonly nextStep: string }>> = {
  'account-proof-required': { message: 'The Telegram polling account could not be verified, so no original was captured and no permission was created.', nextStep: 'Check the Telegram bot token for this daemon, then call inbound.telegram.configure again.' },
  'account-not-chosen': { message: 'The accountId does not name the verified bot account.', nextStep: 'Call inbound.telegram.configure with accountId set to the account shown in accountIdentity.' },
  'account-proof-unavailable': { message: 'The Telegram account proof is unavailable or was cancelled.', nextStep: 'Check the Telegram bot token for this daemon, then send the command again.' },
  'account-proof-changed': { message: 'The Telegram polling account changed while the message arrived, so no original was captured.', nextStep: 'Call inbound.telegram.configure again for the current account.' },
  'workspace-changed': { message: 'The workspace changed, so delegated intake requires fresh workspace construction.', nextStep: 'Restart the daemon so delegated intake is built for the current workspace, then call inbound.telegram.configure.' },
  'lifecycle-changed': { message: 'Delegated intake was stopped or restarted, so nothing was captured or decided.', nextStep: 'Call inbound.telegram.configure again for this chat.' },
  'owner-changed': { message: 'The paired owner changed while the command ran.', nextStep: 'Send the command again from the paired owner device.' },
  'not-owner': { message: 'This review or configuration belongs to another paired owner.', nextStep: 'Send the command from the paired device that configured this chat.' },
  'message-identity-missing': { message: 'The provider sent the message without a message id, so no original was captured.', nextStep: 'Ask the sender to send the message again.' },
  'tracking-full': { message: 'Delegated intake is tracking 500 messages whose source deadline has not passed, so no original was captured.', nextStep: 'Decide or cancel pending reviews (inbound.telegram.list), or wait for earlier messages to expire.' },
  'message-edited': { message: 'The provider message was edited; its earlier capture was released and the edit needs a fresh original and decision.', nextStep: 'Review the edited message when it is delivered as a new message.' },
  'no-configuration': { message: 'This chat has no current pending-memory lifetime, so the original was not captured.', nextStep: 'Call inbound.telegram.configure for this chat, then ask the sender to send the message again.' },
  'configuration-not-current': { message: 'The selected chat has no current owner configuration, so the original was not captured.', nextStep: 'Call inbound.telegram.configure for this chat, then ask the sender to send the message again.' },
  'source-unavailable': { message: 'The original source or its route binding is no longer available; nothing was replayed.', nextStep: 'Call inbound.telegram.list to see the reviews that are still pending.' },
  'missing-source-proof': { message: 'This daemon holds no review or pending source for that reference.', nextStep: 'Call inbound.telegram.list to see the reviews this daemon holds.' },
  'configuration-unavailable': { message: 'No live configuration has that id.', nextStep: 'Call inbound.telegram.release with the chatId (and threadId), or inbound.telegram.configure to set one up.' },
  'chat-not-selected': { message: 'That chat is not selected for delegated intake.', nextStep: 'Nothing to release; call inbound.telegram.configure to select a chat.' },
  'already-decided': { message: 'A decision was already attempted for this message.', nextStep: 'Call inbound.telegram.status with this ref to see the outcome.' },
  'lifetime-exceeds-configuration': { message: 'The source lifetime ends after the configuration expires.', nextStep: 'Choose a sourceRetentionMs that ends before the configuration expires, or configure again with a longer configurationLifetimeMs.' },
  'not-durably-resolved': { message: 'The approval was not recorded exactly as sent, so the original was released.', nextStep: 'Call inbound.telegram.status with this ref.' },
  'review-queue-refused': { message: 'The review queue did not accept the message.', nextStep: 'Cancel a review with inbound.telegram.cancel, or wait for one to expire.' },
  'review-held': { message: 'This review was denied, expired or failed; its original was released.', nextStep: 'Ask the sender to send the message again if it still needs review.' },
  'review-closed': { message: 'This review left the review queue (cancelled or expired); its original was released.', nextStep: 'Ask the sender to send the message again if it still needs review.' },
  'handoff-held': { message: 'The approved message could not be handed to the review queue.', nextStep: 'Call inbound.telegram.status with this ref.' },
};

type DelegatedSourceRef = z.infer<typeof delegatedSourceRefSchema>;
interface DelegatedAccountIdentity { readonly id: string; readonly username: string; readonly revision: string }

/** Context a hold may carry beside its reason; `message` and `nextStep` replace the defaults. */
export interface DelegatedHoldContext {
  readonly ref?: DelegatedSourceRef;
  readonly route?: string;
  readonly accountIdentity?: DelegatedAccountIdentity;
  readonly approvalId?: string;
  readonly source?: string;
  readonly message?: string;
  readonly nextStep?: string;
}

export interface DelegatedHold extends Omit<DelegatedHoldContext, 'message' | 'nextStep'> {
  readonly outcome: 'held';
  readonly reason: DelegatedHoldReason;
  readonly message: string;
  readonly nextStep: string;
}

/** A held message or a refused command, as a value: the code, its sentence and the next step. */
export function delegatedHold(reason: DelegatedHoldReason, context: DelegatedHoldContext = {}): DelegatedHold {
  const text = HOLD_TEXT[reason];
  return { ...context, outcome: 'held', reason, message: context.message ?? text.message, nextStep: context.nextStep ?? text.nextStep };
}

/** Thrown by delegated intake for a refusal the command layer returns as a held value. */
export class DelegatedIntakeRefusal extends Error {
  override readonly name = 'DelegatedIntakeRefusal';
  constructor(readonly reason: DelegatedHoldReason, message?: string) {
    super(message ?? HOLD_TEXT[reason].message);
  }
}

const accountIdentitySchema = z.object({ id, username: id, revision: id }).strict();
const holdSchema = z.object({
  outcome: z.literal('held'), reason: z.enum(DELEGATED_HOLD_REASONS), message: z.string(), nextStep: z.string(),
  ref: delegatedSourceRefSchema.optional(), route: z.string().optional(), accountIdentity: accountIdentitySchema.optional(),
  approvalId: id.optional(), source: z.string().optional(),
}).strict();
const handoffOutcome = z.enum(['transferred', 'started', 'unknown']);
const pendingOutcome = z.enum(['awaiting-owner', 'deciding', 'approved', 'cancelled', 'transferred', 'started', 'unknown']);
const reviewView = z.object({
  outcome: z.literal('recorded'), record: delegatedReviewRecordSchema,
  source: z.enum(['available-in-memory', 'expired-or-lost']), recovery: z.enum(['owner-review-available', 'new-original-required']),
  original: z.object({ text: z.string(), unsupportedSources: z.array(z.object({ kind: z.string(), label: z.string() }).strict()) }).strict().optional(),
}).strict();
const pendingView = z.object({ outcome: pendingOutcome, ref: delegatedSourceRefSchema, source: z.enum(['awaiting-owner', 'released']), approvalId: id }).strict();

/** Each command's result: what happened, or a hold with its reason, message and next step. */
export const delegatedTelegramResultSchemas = {
  configure: z.union([z.object({
    outcome: z.literal('configured'), configurationId: id, accountIdentity: accountIdentitySchema, expiresAt: z.number(),
    pendingRetentionMs: duration, processing: z.literal('requires-per-message-approval'), restart: z.literal('selected-route-held-without-original-or-grant'),
  }).strict(), holdSchema]),
  decide: z.union([
    z.object({ outcome: handoffOutcome, ref: delegatedSourceRefSchema, execution: z.literal('not-started') }).strict(),
    z.object({ outcome: z.literal('denied'), ref: delegatedSourceRefSchema, execution: z.literal('not-started') }).strict(),
    holdSchema,
  ]),
  status: z.union([reviewView, pendingView, holdSchema]),
  read: z.union([reviewView, pendingView, holdSchema]),
  list: z.object({
    outcome: z.literal('listed'), records: z.array(delegatedReviewRecordSchema),
    pending: z.array(z.object({ ref: delegatedSourceRefSchema, approvalId: id, sourceExpiresAt: z.number(), outcome: z.union([pendingOutcome, z.literal('held')]) }).strict()),
  }).strict(),
  cancel: z.union([z.object({ outcome: z.literal('cancelled'), execution: z.literal('not-started') }).strict(), holdSchema]),
  revoke: z.union([z.object({ outcome: z.literal('revoked'), route: z.literal('remains-selected-and-held') }).strict(), holdSchema]),
  release: z.union([z.object({ outcome: z.literal('released'), route: z.literal('normal-handling-resumes') }).strict(), holdSchema]),
} as const;
export type DelegatedTelegramOperation = keyof typeof delegatedTelegramResultSchemas;
export type DelegatedTelegramResult<O extends DelegatedTelegramOperation> = z.infer<typeof delegatedTelegramResultSchemas[O]>;

/** What an inbound Telegram message became: waiting for the owner's decision, or held with a reason. */
export type DelegatedTelegramAcceptance =
  | { readonly outcome: 'awaiting-owner'; readonly approvalId: string; readonly ref: DelegatedSourceRef; readonly sourceExpiresAt: number }
  | DelegatedHold;

