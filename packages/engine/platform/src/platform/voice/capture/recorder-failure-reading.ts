export type RecorderFailureCause = 'permission-denied' | 'device-missing' | 'device-unavailable' | 'none';

/**
 * The diagnostics the five supported recorders (pw-record, parecord, arecord,
 * ffmpeg, sox) print when the device itself is the problem, in the order they
 * are checked. Permission comes first because a refused device is often also
 * reported as unopenable; a missing device before a busy one for the same reason.
 */
const RECORDER_DIAGNOSTICS: readonly (readonly [Exclude<RecorderFailureCause, 'none'>, RegExp])[] = [
  ['permission-denied', /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b|access (?:is |was )?denied|not authori[sz]ed to (?:access|use|capture)/i],
  ['device-missing', /no target node available|no such device|no such file or directory|no such entity|unknown pcm|cannot find card|invalid card|no capture devices? found|\bENODEV\b|\bENOENT\b|device not found|no default (?:input|source)/i],
  ['device-unavailable', /device or resource busy|resource busy|\bEBUSY\b|resource temporarily unavailable|connection refused|connection failure|audio open error|can't open (?:input|audio)|failed to open (?:audio )?device/i],
];

/**
 * Why a recorder that exited on its own stopped, read from its diagnostics with
 * a fixed table. Nothing is asked of a model: the recorders are known programs
 * with known wording, and an unrecognised diagnostic is `none`, reported with
 * its exit code and signal.
 */
export function classifyRecorderFailure(stderr: string): RecorderFailureCause {
  if (stderr.length === 0) return 'none';
  for (const [cause, pattern] of RECORDER_DIAGNOSTICS) if (pattern.test(stderr)) return cause;
  return 'none';
}
