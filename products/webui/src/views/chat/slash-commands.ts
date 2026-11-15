/**
 * The composer's slash commands. Only commands ChatView actually carries out
 * are listed: the menu must never offer one that would instead send its text to
 * the model as a chat message.
 */

export type SlashCommandName = 'new';

export const SLASH_COMMANDS: readonly { name: SlashCommandName; description: string }[] = [
  { name: 'new', description: 'Start a new chat session' },
];

/** The command a draft is, or null for ordinary text (including an unknown "/word"). */
export function parseSlashCommand(draft: string): SlashCommandName | null {
  const word = /^\/(\S+)$/.exec(draft.trim())?.[1]?.toLowerCase();
  return SLASH_COMMANDS.find((command) => command.name === word)?.name ?? null;
}
