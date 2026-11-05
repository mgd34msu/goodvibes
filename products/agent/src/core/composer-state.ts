import { createComposerStateReader } from '@goodvibes-jev/engine/terminal-shell/composer-state';
import { routeSubmissionIntent } from '../input/submission-router.ts';
export type { ComposerState, ComposerStateInput } from '@goodvibes-jev/engine/terminal-shell/composer-state';
export const deriveComposerState = createComposerStateReader(routeSubmissionIntent, { approvalFlag: true, approvalSuppressesTurn: false });
