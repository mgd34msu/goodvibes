import { calibrationCovers } from '@goodvibes-jev/judgment';
import { GATE_CALIBRATION_RECORD, type GateCalibrationRecord } from './gate-calibration-record.js';
import { registry } from './judgment-registry.js';

let covered: boolean | undefined;

/**
 * Whether Jev's gate decisions were measured on this decision model: the
 * shipped calibration record covers every decision the gate registers at its
 * current version, each met its accuracy floor, and `model` is the model the
 * run asked or that answered it. The coverage is worked out once per process;
 * each call after that compares strings.
 */
export function gateDecisionsCalibrated(model: string, record: GateCalibrationRecord | null = GATE_CALIBRATION_RECORD): boolean {
  if (!record || !record.passed) return false;
  const measured = record === GATE_CALIBRATION_RECORD
    ? covered ??= calibrationCovers(record, registry.list())
    : calibrationCovers(record, registry.list());
  const name = model.trim();
  return measured && name.length > 0 && (record.model === name || record.observedModels.includes(name));
}
