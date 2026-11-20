import { createComposerStateReader } from '@goodvibes/engine/terminal-shell/composer-state';
import { routeSubmissionIntent } from '../input/submission-router.ts';
export type { ComposerState, ComposerStateInput } from '@goodvibes/engine/terminal-shell/composer-state';
export const deriveComposerState = createComposerStateReader(routeSubmissionIntent);
