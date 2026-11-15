import { syncProjectSurfaces } from './project-surfaces.ts';

/**
 * Syncs versioned surfaces, foundation artifacts and the command reference.
 * Run it by hand with `bun run prepare:build`; a plain
 * `build` does not run it, because it rewrites tracked files.
 */
try {
  // The product root comes from the script's own location, so the sync is the
  // same from any working directory.
  syncProjectSurfaces();
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
