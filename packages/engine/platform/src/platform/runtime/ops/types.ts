/**
 * Type definitions for operational runbooks.
 *
 * Playbooks are structured runbooks read by `/doctor <symptom>` in both
 * terminal apps and by the `ops.doctor` operator method. Each playbook
 * describes symptoms, diagnostic checks over live state, resolution steps
 * that name real commands, and escalation criteria.
 */

import type { OpsCheckContext } from './runtime-context.js';

// ── Diagnostic check ─────────────────────────────────────────────────────────

/** Severity level of a diagnostic check result. */
export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Result of running a single diagnostic check. */
export interface DiagnosticCheckResult {
  /** Whether the check passed. */
  readonly passed: boolean;
  /** Human-readable summary of the check outcome. */
  readonly summary: string;
  /** Optional structured detail behind the summary. */
  readonly context?: Record<string, string | number | boolean> | undefined;
  /** Severity when the check fails. */
  readonly severity: DiagnosticSeverity;
  /**
   * False when the check could not look at the live state it needs. Then
   * `passed` says nothing about the system: treat the result as "unknown", not
   * as a failure. Omitted means the check was evaluated.
   */
  readonly evaluated?: boolean | undefined;
}

/**
 * A single diagnostic check over the live state in its context.
 *
 * `run` must not throw: wrap it in `safeCheck`, which turns a throw into an
 * unevaluated ("unknown") result.
 */
export interface DiagnosticCheck {
  /** Unique identifier for this check (e.g. 'queue.overflow'). */
  readonly id: string;
  /** Short human-readable label. */
  readonly label: string;
  /** Longer description of what this check verifies. */
  readonly description: string;
  /** Execute the check against live state and return a result. Never throws. */
  readonly run: (context: OpsCheckContext) => Promise<DiagnosticCheckResult>;
}

// ── Playbook step ─────────────────────────────────────────────────────────────

/** Category of action required for a step. */
export type PlaybookStepKind =
  | 'command'    // Execute a shell/runtime command
  | 'config'     // Modify configuration
  | 'observe'    // Inspect logs/metrics/state
  | 'wait'       // Wait for a condition
  | 'escalate';  // Escalate to human or automated alert

/** A single resolution step within a playbook. */
export interface PlaybookStep {
  /** Step number (1-indexed). */
  readonly step: number;
  /** Short title for display. */
  readonly title: string;
  /** Detailed action description. */
  readonly action: string;
  /** Category of this step. */
  readonly kind: PlaybookStepKind;
  /**
   * For 'command' steps: the slash command (or key) to use.
   * For 'config' steps: the config key and value to set.
   * For 'wait' steps: condition description.
   * Optional for 'observe' and 'escalate' steps.
   */
  readonly command?: string | undefined;
  /** Expected outcome if the step succeeds. */
  readonly expectedOutcome?: string | undefined;
  /** Whether this step can be safely automated. */
  readonly automatable: boolean;
}

// ── Playbook ──────────────────────────────────────────────────────────────────

/** A complete operational runbook. */
export interface Playbook {
  /** Unique identifier (e.g. 'stuck-turn'). */
  readonly id: string;
  /** Short human-readable name. */
  readonly name: string;
  /** Description of what this playbook addresses. */
  readonly description: string;
  /**
   * Observable symptoms that suggest this playbook applies; the symptom
   * search matches against these, the name, the description and the tags.
   */
  readonly symptoms: string[];
  /**
   * Diagnostic checks to run when this playbook is matched.
   */
  readonly checks: DiagnosticCheck[];
  /** Ordered resolution steps. */
  readonly steps: PlaybookStep[];
  /**
   * Conditions that indicate the issue has escalated beyond
   * automated remediation and requires human intervention.
   */
  readonly escalationCriteria: string[];
  /** Tags; a symptom that names one picks this playbook first. */
  readonly tags: string[];
}

// ── Playbook registry ─────────────────────────────────────────────────────────

/** Registry entry wrapping a playbook with metadata. */
export interface PlaybookRegistryEntry {
  readonly playbook: Playbook;
  /** Version string (semver-like, e.g. '1.0.0'). */
  readonly version: string;
  /** ISO timestamp of when this playbook was last updated. */
  readonly updatedAt: string;
}

/** A map of playbook IDs to their registry entries. */
export type PlaybookRegistry = Map<string, PlaybookRegistryEntry>;
