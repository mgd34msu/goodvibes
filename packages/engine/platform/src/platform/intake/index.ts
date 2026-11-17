/**
 * Host-side inbound feed persistence and provider contracts (Node/Bun).
 * Not part of the browser/runtime-neutral platform facade. Provider credentials
 * remain read-only ports; semantic mapping and triage are separate layers.
 */
export type { IntakeCredentialStore, IntakeCredentialSnapshot, IntakeLogger } from './context.js';
export { createProtectedInboxMapper } from './protected-preview.js';
export type { ProtectedInboxPreviewInput, ProtectedInboxPreviewFields } from './protected-preview.js';
export { createEmailInboxOwner } from './providers/email-owner.js';
export { acquireAccountInboxIdentity, resolveAccountInboxIdentity, resolveAccountInboxElectionScope } from './providers/account-identity.js';
export type { AccountInboxIdentity, AccountInboxIdentityInput, AccountInboxIdentityOwner, AccountInboxSelectors, AccountInboxBinding } from './providers/account-identity.js';
export type { OwnerMailObservation, EmailInboxAccount, EmailInboxOwnerOptions, EmailInboxOwner, EmailInboxReadLease } from './providers/email-owner.js';
export { createSlackInboxOwner } from './providers/slack-owner.js';
export type { SlackInboxAccount, SlackInboxOwnerOptions, SlackInboxOwnerFactories, SlackInboxOwner, VerifiedSlackInboxOwner } from './providers/slack-owner.js';
export { sha256First, digestSender, stripMarkup, normalizeWhitespace } from './text-normalization.js';
export type {
  InboundChannelItem, ProviderState, ProviderPollResult, ProviderPollOptions,
  AdapterContext, RouteResolver, InboundProviderAdapter, PushedProviderSink, PushedProviderStatus,
} from './provider-adapter.js';
export { POLL_CADENCE_MS } from './provider-adapter.js';
export {
  InboxCursorStore, INBOX_ITEM_TTL_MS, INBOX_ITEM_CAP, INBOX_SWEEP_INTERVAL_MS,
} from './cursor-store.js';
export type {
  InboxSweepSummary, InboxCursorStoreOptions, InboxPosition, InboxQuery, InboxTriageReceiptRow, InboxTriageCandidate,
} from './cursor-store.js';

export { InboundPoller } from './poller.js';
export type { ProviderStatus, PollerOptions } from './poller.js';

export {
  DEFAULT_LIMIT, MAX_LIMIT, encodePageCursor, decodePageCursor,
  normalizeInboxQuery, toWireItem, aggregateInbox,
} from './aggregator.js';
export type {
  InboxListInput, ChannelInboxItem, ChannelInboxProviderStatus,
  InboxListOutput, InboxListQuery, InboxAggregatorSources,
} from './aggregator.js';

export { INBOX_LIST_METHOD_ID, INBOX_TRIAGE_METHOD_ID, registerInboxSurface, createOwnedInboxSource, registerCompositeInboxSurface } from './registration.js';
export type {
  InboxPollingControl, InboxSurfaceContext, RegisterInboxSurfaceOptions, InboxSurfaceRegistration,
  OwnedInboxReadLease, OwnedInboxRead, OwnedInboxSource,
} from './registration.js';

export { inboxTriage, TRIAGE_MODEL } from './triage/battery.js';
export { labelToTag } from './triage/evidence.js';
export { scoreInboxTriage } from './triage/scorer.js';
export { triageMirrorRows, previewInboxTriage } from './triage/pipeline.js';
export type { TriageRow } from './triage/pipeline.js';
export { triageAuthorityFromScreening } from './triage/screening-route.js';
export type {
  TriageInput, TriageLabel, TriageAttribution, TriageSourceBinding, TriageBinding, TriageEvidence, TriageFailureReceipt, TriagePreview, TriageReceipt,
  TriageReceiptScope,
} from './triage/types.js';

export { composeInboxReads } from './composite.js';
export type { InboxReadSource } from './composite.js';

export { createOwnedTriagedInboxSource, registerTriagedInbox } from './triage/owned.js';
export type { InboxTriageAuthority, InboxTriageState, OwnedTriagedInboxOptions, OwnedInboxTriageResult, OwnedTriagedInboxSource } from './triage/owned.js';

// Explicit host-owned provider mutation handles. No default registration or polling.
export { createTriageTagger } from './triage/tagger/index.js';
export type { TriageTagger, TriageTaggerOptions, PreparedTriageTags, TriageTagEffect, TriageProviderTag, TaggerGuard, TriageEffectResult, TriageTagWrite, ImapStoreArgs, ImapStoreFlag, ImapStoreResult, ImapRetryOptions } from './triage/tagger/index.js';
export { createOwnedInboxTagging } from './triage/tagged-owned.js';
export { INBOX_APPLY_LABELS_METHOD_ID, MAX_INBOX_LABEL_ITEMS, inboxItemProvider, registerInboxLabelsMethod } from './triage/apply-labels-method.js';
export type { InboxApplyLabelsInput, InboxApplyLabelsOutput } from './triage/apply-labels-method.js';
export type { OwnedInboxTagging, OwnedInboxTaggingOptions, OwnedInboxTagOperation, OwnedInboxTagResult } from './triage/tagged-owned.js';

// Explicit account-bound Discord channels; no implicit catalog or external polling.
export { createDiscordInboxOwner } from './providers/discord-owner.js';
export type { DiscordInboxAccount, DiscordInboxChannelScope, DiscordInboxOwnerOptions, DiscordInboxOwnerFactories, DiscordInboxOwner, VerifiedDiscordInboxOwner } from './providers/discord-owner.js';

export { acquireDiscordInboxIdentity, acquireDiscordInboxRegistryRevision, resolveDiscordInboxElectionScope } from './providers/discord-identity.js';
export type { DiscordInboxIdentity, DiscordInboxIdentityInput, DiscordInboxIdentityOwner } from './providers/discord-identity.js';

export { createInactiveInboxRetentionOwner } from './inactive-retention.js';
export type { InactiveInboxRetentionOwner, InactiveInboxRetentionOptions, InactiveInboxSweep } from './inactive-retention.js';
export type { InboxRetentionPolicy } from './cursor-store.js';
