import { generateCompletion } from './completions/generate.ts';

/** An unknown or missing shell gets the bash script, as before. */
export const renderCompletion = (shell: string | undefined, binary = 'goodvibes') => {
  const normalized = (shell ?? 'bash').toLowerCase();
  return generateCompletion(normalized === 'zsh' || normalized === 'fish' ? normalized : 'bash', binary);
};
