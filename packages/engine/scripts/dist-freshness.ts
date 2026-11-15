import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Newest modification time (ms) of any file under `dir`; 0 when there is none. */
export function newestMtimeMs(dir: string): number {
  let newest = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') visit(path); }
      else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  if (existsSync(dir)) visit(dir);
  return newest;
}

/**
 * Some tests import the compiled output (`platform/dist`) instead of the
 * source, so `test:one` after an edit would exercise the old code and pass or
 * fail for the wrong reason. Returns the note to print when the output is
 * missing or older than the source, undefined when it is current. A build is
 * slow, so the caller warns and lets the run continue.
 */
export function staleDistNote(srcDir: string, distDir: string, buildCommand: string): string | undefined {
  const built = newestMtimeMs(distDir);
  if (built === 0) return `${distDir} is not built; tests that import it cannot run. Build it with \`${buildCommand}\`.`;
  if (newestMtimeMs(srcDir) > built) return `${distDir} is older than ${srcDir}; tests that import it run the previous build. Rebuild with \`${buildCommand}\`.`;
  return undefined;
}
