import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const productRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = join(productRoot, 'src');
const emittedRoot = join(productRoot, 'dist');

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path !== join(sourceRoot, 'test')) sourceFiles(path, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

let checked = false;

/**
 * Tests that run the emitted CLI exercise `dist`, which the single-test command
 * does not rebuild. Fail loudly when it is missing or older than the source it
 * was built from, so a green run always describes the working tree.
 */
export function assertEmittedBuildCurrent(): void {
  if (checked) return;
  const stale: string[] = [];
  for (const source of sourceFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, source);
    const emitted = join(emittedRoot, relativePath.replace(/\.ts$/, '.js'));
    if (!existsSync(emitted) || statSync(emitted).mtimeMs < statSync(source).mtimeMs) stale.push(relativePath);
  }
  if (stale.length > 0) {
    throw new Error(`The emitted daemon build in dist is missing or older than src (${stale.slice(0, 5).join(', ')}${stale.length > 5 ? `, and ${stale.length - 5} more` : ''}). Run "bun run build" in products/daemon, then run this test again.`);
  }
  checked = true;
}
