/**
 * Cascade rule -> remediation playbook mapping, derived from the rules table
 * (cascade-rules.ts), where each rule names its playbooks.
 *
 * Consumed by the CascadeTimer (attaches remediationPlaybookIds to each result).
 */
import { CASCADE_RULES } from './cascade-rules.js';

/** Map from cascade rule ID to its ordered remediation playbook IDs; the first is the primary recommendation. */
export const CASCADE_PLAYBOOK_MAP: ReadonlyMap<string, readonly string[]> = new Map(
  CASCADE_RULES.map((rule) => [rule.id, rule.playbooks] as const),
);

/** Every cascade rule ID, in table order. */
export const ALL_CASCADE_RULE_IDS: readonly string[] = CASCADE_RULES.map((rule) => rule.id);
