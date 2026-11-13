import { syncProjectSurfaces } from './project-surfaces.ts';

/**
 * Prebuild script, syncs versioned surfaces and foundation artifacts before
 * compilation or staging so release assets cannot race stale source files.
 */
try {
  syncProjectSurfaces(process.cwd());
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
