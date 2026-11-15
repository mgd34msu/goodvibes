import { resolveGoodVibesTreeDirectory } from '@goodvibes-jev/engine/platform/platform/config';
import type { LiveVerificationReport } from '../src/verification/live-verifier.ts';

/**
 * The `.goodvibes` directory to verify. `GOODVIBES_HOME` names the root the tree
 * sits under, as it does for the runtime, so the default is derived from it the
 * same way; reading it as the tree itself made this verifier inspect a different
 * directory than the binary it drives. `--home` names a `.goodvibes` directory
 * directly.
 */
export function resolveVerifyLiveHome(homeFlag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return homeFlag ?? resolveGoodVibesTreeDirectory(env);
}

/**
 * Whether the run passes. Under `--strict` a skipped check is not a pass: with
 * no token every host check skips, and a report that checked nothing must not
 * read as green.
 */
export function liveVerificationPasses(report: Pick<LiveVerificationReport, 'ok' | 'strict' | 'counts'>): boolean {
  return report.ok && !(report.strict && report.counts.skip > 0);
}
