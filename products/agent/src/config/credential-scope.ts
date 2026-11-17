/**
 * credential-scope.ts, which secret-store tier a credential belongs in.
 *
 * The platform's credential-scope registry is the one answer for every
 * product: a credential the daemon reads (one a daemon-owned setting names, or
 * one declared there, such as the calendar token store and the per-subscription
 * feed URLs `GOODVIBES_CALENDAR_SUB_<NAME>`) lives in the daemon tier whatever
 * scope a caller asks for, and a delete of it sweeps every tier. These names
 * are the Agent's spellings of that one rule.
 */

export {
  isDaemonNeededSecretKey,
  resolveSecretDeleteScope as resolveCredentialDeleteScope,
  resolveSecretWriteScope as resolveCredentialWriteScope,
  secretWriteScopeWasOverridden as credentialWriteScopeWasRelocated,
} from '@goodvibes-jev/engine/platform/platform/config';
