import type { CliDoctorFinding } from './status.ts';

/**
 * The doctor command's exit code. A `note` describes the arrangement and a
 * `warning` is a note on a usable install, so neither fails a healthy install;
 * a must-fix `risk` finding exits 1. `strict` (for CI) also fails on a warning.
 */
export function resolveDoctorExitCode(findings: readonly CliDoctorFinding[], strict = false): number {
  if (strict && findings.some((finding) => finding.severity !== 'note')) return 1;
  return findings.some((finding) => finding.severity === 'risk') ? 1 : 0;
}
