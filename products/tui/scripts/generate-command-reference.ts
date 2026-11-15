#!/usr/bin/env bun
/**
 * generate-command-reference, regenerate docs/commands-reference.md from the
 * live slash-command registry. Run via `bun run docs:commands`.
 * `scripts/prebuild.ts` also rewrites it.
 */
import { join } from 'node:path';
import { syncCommandReference } from './project-surfaces.ts';

syncCommandReference(join(import.meta.dir, '..'));
