/** What a settings owner's pre-effect refusal tells the caller, shared by the change and import clients. */
import type { SettingsPreconditionReceipt } from '@goodvibes-jev/engine/daemon-api';

export type SettingsRefusalReason = NonNullable<SettingsPreconditionReceipt['refusalReason']>;
const REASONS: readonly SettingsRefusalReason[] = ['stale', 'spent', 'managed', 'read-only', 'owner-fault'];

/** The value-free reason on a refusal body, when it carries a known one. */
export function refusalReasonOf(body: unknown): SettingsRefusalReason | undefined {
  const reason = body !== null && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  return REASONS.find(known => known === reason);
}

/** A capture refusal the caller can act on; anything unclassified stays the generic refusal. */
export class SettingsRefusalError extends Error {
  constructor(readonly reason: SettingsRefusalReason | 'pairing-store-faulted', message: string) {
    super(message);
    this.name = 'SettingsRefusalError';
  }
}

/** Next-step text per reason; every one states that nothing was applied. */
export function refusalText(subject: 'Settings change' | 'Settings import', reason: SettingsRefusalReason): string {
  switch (reason) {
    case 'stale': return `${subject} refused (stale): the setting, its owner or the daemon changed, or the capture expired, before it was used. Nothing was applied. Read the current state and capture again.`;
    case 'spent': return `${subject} refused (spent): this capture was already used once. Nothing was applied by this attempt. Read the current state to see whether the earlier use took effect before capturing again.`;
    case 'managed': return `${subject} refused (managed): managed policy locks this setting. Nothing was applied. Do not retry; only the policy owner can change it.`;
    case 'read-only': return `${subject} refused (read-only): the settings owner is read-only here. Nothing was applied. Do not retry on this owner; use a writable one.`;
    case 'owner-fault': return `${subject} refused (owner-fault): a settings owner store is faulted or briefly busy (for example another process is changing configuration). Nothing was applied. Retry shortly; if it keeps failing, check the daemon log for the faulted store.`;
  }
}
