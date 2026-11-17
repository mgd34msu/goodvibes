import { runTuiCompletion } from './completions/generate.ts';

/** `goodvibes completion <shell>`: bash, zsh or fish; any other name is refused with exit 2. */
export const renderCompletion = (args: readonly string[], binary = 'goodvibes') => runTuiCompletion(args, binary);
