/**
 * The composer's slash commands: what a person can do from the browser's
 * composer, and nothing else. Typing `/` lists them; Enter on one typed in full
 * (or picked from the list) does it:
 *
 * - `/new` starts a new chat (ChatView);
 * - a command with its own screen in the web UI (`/schedule`, `/mcp`,
 *   `/payments`, `/triggers`) opens that screen;
 * - any other command with an action the daemon carries out for the browser
 *   (lib/generated/command-actions.ts, the same actions the Ctrl+K palette
 *   lists) opens that action's sheet when it has one, or the palette narrowed
 *   to its actions when it has several.
 *
 * A command whose every action runs only in the terminal app is not listed:
 * the menu never offers a command that would do nothing here or send its text
 * to the model as a chat message.
 */
import { COMMAND_ACTIONS } from '../../lib/generated/command-actions';
import { COMMAND_SCREENS } from '../../components/command/screens/CommandScreens';

/** What running a slash command does in the browser. */
export type SlashRun =
  | { readonly kind: 'new-chat' }
  /** A command registered in the palette (lib/commands.ts): an action's sheet or a command's screen. */
  | { readonly kind: 'palette-command'; readonly id: string }
  /** The palette, opened on this search: a command with several actions. */
  | { readonly kind: 'palette-search'; readonly query: string };

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly run: SlashRun;
}

function buildSlashCommands(): SlashCommand[] {
  const out: SlashCommand[] = [{ name: 'new', description: 'Start a new chat', run: { kind: 'new-chat' } }];
  for (const command of COMMAND_ACTIONS.commands) {
    if (command.name === 'new') continue;
    const screen = COMMAND_SCREENS.find((entry) => entry.command === command.name);
    if (screen) {
      out.push({ name: command.name, description: screen.title, run: { kind: 'palette-command', id: `screen.${screen.id}` } });
      continue;
    }
    // The actions the palette lists: carried out by the daemon, and not a read.
    const runnable = command.actions.filter((action) => 'method' in action.operator && action.touches !== 'reads');
    const only = runnable[0];
    if (!only) continue;
    out.push(runnable.length === 1
      ? { name: command.name, description: only.label, run: { kind: 'palette-command', id: `action.${command.name}.${only.id}` } }
      : { name: command.name, description: command.title, run: { kind: 'palette-search', query: `/${command.name}` } });
  }
  return out.sort((a, b) => (a.name === 'new' ? -1 : b.name === 'new' ? 1 : a.name.localeCompare(b.name)));
}

export const SLASH_COMMANDS: readonly SlashCommand[] = buildSlashCommands();

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
  | { kind: 'command'; command: SlashCommand }
  /** `known` is true for a command this composer runs only alone (`/new` with words after it). */
  | { kind: 'unknown'; word: string; known: boolean }
  | { kind: 'text' };

const COMMAND_ATTEMPT = /^\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/;

export function parseSlashCommand(draft: string): SlashDraft {
  const trimmed = draft.trim();
  const word = COMMAND_ATTEMPT.exec(trimmed)?.[1];
  if (!word) return { kind: 'text' };
  const known = SLASH_COMMANDS.find((command) => command.name === word.toLowerCase());
  // A command runs only when typed alone; with words after it, it is held: the
  // browser's sheets and screens take their values in their own fields.
  if (known && trimmed.length === word.length + 1) return { kind: 'command', command: known };
  return { kind: 'unknown', word: `/${word}`, known: Boolean(known) };
}
