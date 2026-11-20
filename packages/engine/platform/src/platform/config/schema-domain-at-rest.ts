/**
 * schema-domain-at-rest.ts, config for the at-rest redaction + retention policy
 * applied to the on-disk transcript journal (agents/session.ts) and local
 * execution ledger (runtime/telemetry/exporters/local-ledger.ts). Consumed by
 * runtime/at-rest-persistence.ts (resolveAtRestPolicy).
 *
 * Honest defaults: redaction ON by default (secrets never persisted in the
 * clear); retention generous but bounded (30 days / 512 MB) so a normal
 * debugging window survives while a long-lived daemon cannot grow these files
 * without limit.
 */
import type { AtRestConfig, ConfigSetting } from './schema-types.js';
import { intRange } from './schema-shared.js';

export const atRestConfigDefaults: { atRest: AtRestConfig } = {
  atRest: {
    redactionEnabled: true,
    retentionMaxAgeDays: 30,
    retentionMaxTotalMb: 512,
  },
};

export const atRestConfigSettings: ConfigSetting[] = [
  {
    key: 'atRest.redactionEnabled',
    type: 'boolean',
    description:
      'When true (default), credential patterns (API keys, bearer tokens, GitHub/GitLab/Slack/AWS credentials) are redacted at WRITE time from the on-disk transcript journal (per-agent <agentId>.jsonl), reusing the same pattern set as the telemetry egress. Home paths are NOT redacted. The local execution ledger gets the same treatment only when the application embedding the platform wires the policy in. Crash reports are always redacted, whatever this setting says. A redacted value shows a [REDACTED_*] marker, a record never pretends the content was absent. Set false ONLY for local debugging where plaintext secrets in the transcript journal are acceptable.',
  },
  {
    key: 'atRest.retentionMaxAgeDays',
    type: 'number',
    description:
      'Age cap (days) for the append-only files: per-agent transcript journals, the execution ledger, the activity log, crash logs and crash-recovery snapshots. Files older than this are pruned at start and every six hours (the journal also prunes on each new agent session; the ledger on each export). Saved conversations are never pruned by it. Generous by default; bounded so the files cannot grow without limit.',
    ...intRange(1, 365),
  },
  {
    key: 'atRest.retentionMaxTotalMb',
    type: 'number',
    description:
      'Total-size cap (MB) for each of the append-only file sets named under atRest.retentionMaxAgeDays (transcript journals, execution ledger, activity log, crash logs, crash-recovery snapshots). When exceeded, the oldest are deleted first (rotated backups before freshly-written active files) until under budget. Saved conversations are never deleted by it.',
    ...intRange(1, 1_048_576),
  },
];
