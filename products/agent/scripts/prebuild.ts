import { syncProjectSurfaces } from './project-surfaces.ts';

/**
 * Prebuild script, syncs versioned package surfaces before compilation or
 * staging so release assets cannot race stale source files.
 */
try {
  syncProjectSurfaces(process.cwd());
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
