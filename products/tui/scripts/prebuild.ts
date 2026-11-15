import { syncProjectSurfaces } from './project-surfaces.ts';

/**
 * Syncs versioned surfaces, foundation artifacts and the command reference.
 * Run it by hand with `bun run prepare:build`; a plain
 * `build` does not run it, because it rewrites tracked files.
 */
try {
  syncProjectSurfaces(process.cwd());
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
