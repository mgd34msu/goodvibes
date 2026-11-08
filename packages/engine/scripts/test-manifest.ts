import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

/** Compare the build job's complete inventory and grouping with local discovery.
 * The artifact is the expected plan, not a checksum of another local plan.
 */
export function assertTestManifest(path: string, current: unknown, product: string): void {
  let expected: unknown;
  try { expected = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${product} test manifest could not be read from the CI build discovery`); }
  if (!isDeepStrictEqual(expected, current)) throw new Error(`${product} test manifest differs from the CI build discovery`);
}
