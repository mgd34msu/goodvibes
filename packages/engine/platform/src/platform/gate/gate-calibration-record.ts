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
export const GATE_CALIBRATION_RECORD: GateCalibrationRecord | null = null;
