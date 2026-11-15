import type { CliDoctorFinding } from './status.ts';

/** Posture advisories (`runtime-posture-N`) describe a deliberate arrangement and say no action is needed. */
function isPostureAdvisory(finding: CliDoctorFinding): boolean {
  return finding.id.startsWith('runtime-posture-');
}

/**
 * The doctor command's exit code. A `warning` is a note on a usable install and
 * a posture advisory asks for nothing, so neither fails a healthy install; a
 * must-fix `risk` finding exits 1. `strict` (for CI) fails on any finding.
 */
export function resolveDoctorExitCode(findings: readonly CliDoctorFinding[], strict = false): number {
  if (strict && findings.length > 0) return 1;
  return findings.some((finding) => finding.severity === 'risk' && !isPostureAdvisory(finding)) ? 1 : 0;
}
