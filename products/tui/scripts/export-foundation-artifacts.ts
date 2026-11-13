import { join } from 'node:path';
import { syncFoundationArtifacts } from './project-surfaces.ts';

syncFoundationArtifacts(join(import.meta.dir, '..'));
