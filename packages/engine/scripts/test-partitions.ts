import { defaultTestArgs } from './test-discovery.ts';

// CI runs the engine suite as this many `--partition=I/N` jobs on separate hosts.
export const ENGINE_TEST_PARTITIONS = 9;
const DEDICATED_TEST_FILES = ['test/knowledge-semantic-answer.test.ts'];
const MAX_PARTITIONS = 16;

export function partitionTestFiles(files: readonly string[], count: number): readonly (readonly string[])[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PARTITIONS || count > files.length) {
    throw new Error(`Test partition count must be 1..${MAX_PARTITIONS} and cannot create empty partitions`);
  }
  if (new Set(files).size !== files.length) throw new Error('Test file list contains duplicates');
  const partitions: string[][] = Array.from({ length: count }, () => []);
  // This complete native workflow suite needs its own host; sharing it with
  // ordinary suites exhausted their enclosing CI budget.
  const dedicated = count > DEDICATED_TEST_FILES.length
    ? DEDICATED_TEST_FILES.filter(file => files.includes(file)) : [];
  const sharedCount = count - dedicated.length;
  // A sorted round-robin spreads neighboring subsystem files rather than
  // concentrating all expensive daemon/contract fixtures in one contiguous leg.
  [...files].filter(file => !dedicated.includes(file)).sort()
    .forEach((file, index) => partitions[index % sharedCount]!.push(file));
  dedicated.forEach((file, index) => partitions[sharedCount + index]!.push(file));
  return partitions;
}

/**
 * The files of `--partition=INDEX/COUNT`, as explicit `./test/...` paths (bun
 * treats bare names as substring filters, so `test/a.test.ts` would also match
 * `test/nested/test/a.test.ts` in another partition).
 */
export function selectPartition(engineRoot: string, spec: string): readonly string[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
  if (!match) throw new Error('Invalid test partition; expected --partition=INDEX/COUNT');
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error('Test partition index is outside its partition count');
  const files = defaultTestArgs(engineRoot);
  const selected = partitionTestFiles(files, count)[index - 1]!;
  console.log(`[engine-tests] partition ${index}/${count}: ${selected.length}/${files.length} files`);
  return selected.map((file) => `./${file}`);
}
