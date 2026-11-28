/**
 * The daemon's capability catalog. Every moved capability comes from the
 * capability registry (builtin/index.ts: its definition is the only source of
 * its id, inputs, risk and effects); the actions not moved yet come from the
 * generated command-actions data (the same file the web UI's sheets are drawn
 * from), which is read only for them: a row of that file for a moved
 * capability is never read. When every action has moved, the file is not read
 * at all. Read once, on the first find or run (or when a daemon composition
 * asks for it ahead, `preloadDaemonCapabilityCatalog`), never at start.
 */
import { CapabilityCatalog, type CatalogCommandSource } from './catalog.js';
import { movedCapabilityEntries } from './builtin/index.js';

let held: Promise<CapabilityCatalog> | undefined;
let loaded: CapabilityCatalog | undefined;

/**
 * The operator method that returns a live list's rows (terminal-shell command-actions/lists.ts `NamedList.operator`):
 * its input (`{input}` blanks are earlier answers) and how its answer becomes rows; or why only a terminal reads it.
 */
export type DaemonListOperator =
  | { readonly method: string; readonly input: Readonly<Record<string, unknown>>; readonly rows: Readonly<Record<string, unknown>> }
  | { readonly terminalOnly: string };

interface DescribedData {
  readonly commands?: readonly CatalogCommandSource[];
  readonly lists?: Readonly<Record<string, DaemonListOperator>>;
}

let described: Promise<DescribedData> | undefined;

function describedData(): Promise<DescribedData> {
  described ??= (async () => {
    try {
      const module = await import('@goodvibes/engine/contracts/command-actions.json') as unknown as { readonly default?: DescribedData } & DescribedData;
      return module.default ?? module;
    } catch {
      // A build without the generated data still finds and runs every moved capability.
      return {};
    }
  })();
  return described;
}

async function describedCommands(): Promise<readonly CatalogCommandSource[]> {
  return (await describedData()).commands ?? [];
}

/**
 * Every live list a capability's input chooses from, by name, with the method that returns its rows: the same file
 * as the catalog (written with the operator contract this daemon serves, by one step), so a screen that draws a form
 * from `capabilities.list` reads a list's rows from the daemon it talks to, never from a copy of its own.
 */
export async function daemonListOperators(): Promise<Readonly<Record<string, DaemonListOperator>>> {
  return (await describedData()).lists ?? {};
}

/** The catalog every daemon find and run reads (built on first use, then kept). */
export function daemonCapabilityCatalog(): Promise<CapabilityCatalog> {
  held ??= describedCommands().then((commands) => {
    const moved = movedCapabilityEntries();
    const catalog = new CapabilityCatalog(moved);
    const movedIds = new Set(moved.map((entry) => entry.id));
    // Only the actions that have not moved: a moved one's row (it carries its declaration) is the registry's to describe.
    catalog.addCommands(commands.map((command) => ({ ...command, actions: command.actions.filter((action) => !action.capability || !movedIds.has(action.capability.id)) })));
    loaded = catalog;
    return catalog;
  });
  return held;
}

/** The catalog once it has been read; undefined before. */
export function loadedDaemonCapabilityCatalog(): CapabilityCatalog | undefined {
  return loaded;
}

/** Read the catalog now, for a composition that builds tool definitions from it next. */
export function preloadDaemonCapabilityCatalog(): Promise<CapabilityCatalog> {
  return daemonCapabilityCatalog();
}
