export type SettingsRefusalReason = 'stale' | 'spent' | 'managed' | 'read-only' | 'owner-fault';

/**
 * What a caller may do next depends on whether anything may have been written.
 * Shared by a single setting write and a settings import, which report the same
 * receipt states.
 */
export function settingsOutcomeError(
  status: 'partial' | 'unknown',
  refused: boolean,
  reason?: SettingsRefusalReason,
  subject: 'change' | 'import' = 'change',
): string {
  const thing = subject === 'import' ? 'the imported settings' : 'the setting';
  const refusal = `The settings owner refused this ${subject} before applying anything`;
  if (refused) {
    switch (reason) {
      case 'stale': return `${refusal} (stale: the setting or its owner changed, or the capture expired). Nothing changed; read ${thing} and request the ${subject} again.`;
      case 'spent': return `${refusal} (spent: this capture was already used). Nothing changed by this attempt; read ${thing} to see whether the earlier use took effect before requesting it again.`;
      case 'managed': return `${refusal} (managed: policy locks this setting). Nothing changed. Do not retry; only the policy owner can change it.`;
      case 'read-only': return `${refusal} (read-only: this owner cannot write settings). Nothing changed. Do not retry on this owner.`;
      case 'owner-fault': return `${refusal} (owner-fault: a settings store is faulted or briefly busy). Nothing changed. Retry shortly; if it keeps failing, check the daemon log.`;
      default: return `${refusal} (its precondition was stale or unavailable). Nothing changed; read ${thing} and request the ${subject} again.`;
    }
  }
  if (status === 'partial') return `The settings ${subject} was partly applied: the files in completedPaths were written and uncertainPath may or may not have been (a credential clear writes the setting first, so a stored credential may remain, unreferenced). It was not retried; read ${thing} before deciding whether to ${subject === 'import' ? 'import' : 'change it'} again.`;
  return `The settings ${subject} has an unknown outcome: the owner gave no definite answer, so it may or may not have been applied. It was not retried; read ${thing} to see whether it ${subject === 'import' ? 'was imported' : 'changed'} before requesting it again.`;
}
