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

async function describedCommands(): Promise<readonly CatalogCommandSource[]> {
  try {
    const module = await import('@goodvibes/engine/contracts/command-actions.json') as { readonly default?: { readonly commands?: readonly CatalogCommandSource[] }; readonly commands?: readonly CatalogCommandSource[] };
    return module.default?.commands ?? module.commands ?? [];
  } catch {
    // A build without the generated data still finds and runs every moved capability.
    return [];
  }
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
