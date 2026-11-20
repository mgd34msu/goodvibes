import { calibrationCovers, HOSTED_BASE_URL } from '@goodvibes/judgment';
import { GATE_CALIBRATION_RECORD, type GateCalibrationRecord } from './gate-calibration-record.js';
import { registry } from './judgment-registry.js';

let covered: boolean | undefined;

/** One place a decision request can be answered: the endpoint it goes to and the model it names. */
export interface DecisionTarget {
  readonly endpoint: string;
  readonly model: string;
}

/** An endpoint as written, without the trailing slashes that do not change where a request goes. */
function sameEndpoint(a: string, b: string): boolean {
  const plain = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
  return plain(a) === plain(b);
}

/**
 * Whether Jev's gate decisions were measured on every target a decision can
 * reach: the shipped calibration record covers every decision the gate
 * registers at its current version, each met its accuracy floor, and each
 * target is what the record measured. The record measured one endpoint (its
 * `endpoint`; a record written before that field was measured against the
 * hosted endpoint, the only one that serves its `jev-latest`) and one model:
 * the name its requests carried (`model`) or a model that actually answered
 * them (`observedModels`). A custom endpoint, or a fallback target naming
 * another endpoint or model, is not what was measured. The coverage is worked
 * out once per process; each call after that compares strings.
 */
export function gateDecisionsCalibrated(targets: readonly DecisionTarget[], record: GateCalibrationRecord | null = GATE_CALIBRATION_RECORD): boolean {
  if (!record || !record.passed || targets.length === 0) return false;
  const measured = record === GATE_CALIBRATION_RECORD
    ? covered ??= calibrationCovers(record, registry.list())
    : calibrationCovers(record, registry.list());
  if (!measured) return false;
  const endpoint = record.endpoint ?? HOSTED_BASE_URL;
  return targets.every((target) => {
    const name = target.model.trim();
    return name.length > 0 && sameEndpoint(target.endpoint, endpoint)
      && (record.model === name || record.observedModels.includes(name));
  });
}
