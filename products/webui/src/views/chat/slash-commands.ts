/**
 * The composer's slash commands. Only commands ChatView actually carries out
 * are listed: the menu must never offer one that would instead send its text to
 * the model as a chat message.
 */

export type SlashCommandName = 'new';

export const SLASH_COMMANDS: readonly { name: SlashCommandName; description: string }[] = [
  { name: 'new', description: 'Start a new chat session' },
];

/**
 * What a draft is: a command this composer runs, a command attempt it does
 * not run, or ordinary text.
 *
 * A command attempt is a draft whose first word is a slash and a command name:
 * a letter, then letters, digits, `-` or `_`, ending at the end of the draft or
 * at a space or line break (arguments may follow). A first word that goes on
 * with another `/`, a `.` or any other character is text, so a path such as
 * `/etc/hosts is broken` or `/var/log/app.log` is sent as written.
 */
export type SlashDraft =
  | { kind: 'command'; name: SlashCommandName }
  /** `known` is true for a command this composer runs only alone (`/new` with words after it). */
  | { kind: 'unknown'; word: string; known: boolean }
  | { kind: 'text' };

const COMMAND_ATTEMPT = /^\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/;

export function parseSlashCommand(draft: string): SlashDraft {
  const trimmed = draft.trim();
  const word = COMMAND_ATTEMPT.exec(trimmed)?.[1];
  if (!word) return { kind: 'text' };
  const known = SLASH_COMMANDS.find((command) => command.name === word.toLowerCase());
  // A known command runs only when typed alone; `/new` with words after it is held
  // like any other command this composer cannot run with arguments.
  if (known && trimmed.length === word.length + 1) return { kind: 'command', name: known.name };
  return { kind: 'unknown', word: `/${word}`, known: Boolean(known) };
}
