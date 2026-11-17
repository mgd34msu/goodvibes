import type { CalibrationRecord } from '@goodvibes-jev/judgment';

/** A calibration record as the calibration script writes it: the run's measurements and the source it measured. */
export type GateCalibrationRecord = CalibrationRecord & { readonly source?: string };

/**
 * The last calibration run over the decisions the permission gate registers,
 * written by `bun packages/engine/scripts/project-calibration.ts --gate` (a
 * paid run against the configured decision endpoint). Null until a run has
 * been recorded: the default mode then asks the owner instead of letting Jev
 * decide (gate/calibration.ts).
 */
export const GATE_CALIBRATION_RECORD: GateCalibrationRecord | null = {
  "at": "2026-11-17T20:15:25.205Z",
  "model": "jev-latest",
  "observedModels": [
    "jev-1.14.0"
  ],
  "decisions": [
    {
      "name": "agent.learning.consolidation-survivor",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.98,
      "checks": 2,
      "passed": true
    },
    {
      "name": "agent.learning.curator-score",
      "version": 5,
      "accuracy": 0.9534883720930233,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 43,
      "passed": true
    },
    {
      "name": "agent.learning.duplicate-alignment",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.98,
      "checks": 3,
      "passed": true
    },
    {
      "name": "agent.learning.proposal-target",
      "version": 3,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 6,
      "passed": true
    },
    {
      "name": "agent.learning.survivor-equivalence",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.98,
      "checks": 3,
      "passed": true
    },
    {
      "name": "agent.remote-publisher.outcome-kind",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 10,
      "passed": true
    },
    {
      "name": "agent.remote-publisher.schema-status",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 9,
      "passed": true
    },
    {
      "name": "engine.gate.agent-read-scope",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 2,
      "passed": true
    },
    {
      "name": "engine.gate.autonomous-disposition",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 9,
      "passed": true
    },
    {
      "name": "engine.gate.autonomous-refusal",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 3,
      "passed": true
    },
    {
      "name": "engine.gate.boundary",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 18,
      "passed": true
    },
    {
      "name": "engine.gate.execution-purpose",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 4,
      "passed": true
    },
    {
      "name": "engine.gate.ledger-arg",
      "version": 1,
      "accuracy": 0.9583333333333334,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 24,
      "passed": true
    },
    {
      "name": "engine.gate.policy-breadth",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 12,
      "passed": true
    },
    {
      "name": "engine.gate.risk-family",
      "version": 1,
      "accuracy": 0.9714285714285714,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 70,
      "passed": true
    },
    {
      "name": "engine.gate.sandbox-advisory",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.gate.sandbox-needs",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 14,
      "passed": true
    },
    {
      "name": "engine.gate.side-effect",
      "version": 3,
      "accuracy": 0.9696969696969697,
      "automaticAccuracy": 0.9833333333333333,
      "accuracyFloor": 0.85,
      "checks": 66,
      "passed": true
    },
    {
      "name": "engine.intake.inbox-triage",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.intake.triage-tag-meaning",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 6,
      "passed": true
    },
    {
      "name": "engine.knowledge.learning-proposal-quality",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 16,
      "passed": true
    },
    {
      "name": "engine.knowledge.repair-fact-scoring",
      "version": 3,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 28,
      "passed": true
    },
    {
      "name": "engine.knowledge.repair-profile-requirement",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 5,
      "passed": true
    },
    {
      "name": "engine.security.protected-source-screening",
      "version": 7,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.98,
      "checks": 8,
      "passed": true
    },
    {
      "name": "engine.security.research-reference-parameter-role",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.98,
      "checks": 4,
      "passed": true
    },
    {
      "name": "engine.tools.api-routes",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 24,
      "passed": true
    },
    {
      "name": "engine.tools.boolean-value",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.tools.child-failure-reason",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 17,
      "passed": true
    },
    {
      "name": "engine.tools.content-rank",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 8,
      "passed": true
    },
    {
      "name": "engine.tools.credential-header",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 16,
      "passed": true
    },
    {
      "name": "engine.tools.dangerous-call",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 18,
      "passed": true
    },
    {
      "name": "engine.tools.edit-target",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.tools.env-template",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 6,
      "passed": true
    },
    {
      "name": "engine.tools.exec-prompt",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 9,
      "passed": true
    },
    {
      "name": "engine.tools.exec-retry",
      "version": 3,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 18,
      "passed": true
    },
    {
      "name": "engine.tools.export-break",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 23,
      "passed": true
    },
    {
      "name": "engine.tools.frontend-finding",
      "version": 3,
      "accuracy": 0.9666666666666667,
      "automaticAccuracy": 0.9655172413793104,
      "accuracyFloor": 0.85,
      "checks": 30,
      "passed": true
    },
    {
      "name": "engine.tools.heal-acceptance",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.9,
      "checks": 11,
      "passed": true
    },
    {
      "name": "engine.tools.memory-class",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.tools.page-content",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 21,
      "passed": true
    },
    {
      "name": "engine.tools.page-summary",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 7,
      "passed": true
    },
    {
      "name": "engine.tools.param-fill",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.tools.project-tooling",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 26,
      "passed": true
    },
    {
      "name": "engine.tools.registry-catalog-group",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 7,
      "passed": true
    },
    {
      "name": "engine.tools.registry-rank",
      "version": 2,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 8,
      "passed": true
    },
    {
      "name": "engine.tools.registry-select",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.95,
      "checks": 6,
      "passed": true
    },
    {
      "name": "engine.tools.secret-finding",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 10,
      "passed": true
    },
    {
      "name": "engine.tools.semantic-diff",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 22,
      "passed": true
    },
    {
      "name": "engine.tools.test-of-source",
      "version": 1,
      "accuracy": 1,
      "automaticAccuracy": 1,
      "accuracyFloor": 0.85,
      "checks": 5,
      "passed": true
    }
  ],
  "passed": true,
  "source": "f318aa769a65aea1c0f3077b677477ef498edf5a"
};
