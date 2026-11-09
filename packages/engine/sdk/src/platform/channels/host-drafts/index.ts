/**
 * channels.drafts.* handler surface barrel.
 *
 * Re-exports only the concrete register entrypoint and the store/types other
 * code may need. It imports concrete submodules (no project index barrels), so
 * it introduces no import cycle.
 */
export { registerDraftMethods } from './register.js';
export type { RegisterDraftsOptions, DraftRegistration } from './register.js';
export { DraftSyncStore, redactWebhook } from './draft-store.js';
export type {
  DraftListQuery,
  DraftRecord,
  DraftSaveInput,
  DraftSaveResult,
  DraftStatus,
} from './draft-store.js';
export type { DraftHostContext } from './types.js';
export { channelDraftWireReference, createChannelDraftWireReference, historicalChannelDraftWireReference, matchesHistoricalDraftWireReference, isNativeDraftWireReference } from './wire-reference.js';
