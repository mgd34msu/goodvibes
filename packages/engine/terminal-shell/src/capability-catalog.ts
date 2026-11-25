/**
 * A terminal program's capability catalog: the moved capabilities with their
 * own definitions, then every action of every slash command this program
 * registered (each described once, command-actions/). Built on first use and
 * again only when the registry's commands change.
 */
import { CapabilityCatalog, movedCapabilityEntries, type CatalogCommandSource } from '@goodvibes/engine/platform/platform/capabilities';

interface RegisteredCommandLike {
  readonly name: string;
  readonly described?: unknown;
}

export function terminalCapabilityCatalog(commands: () => readonly RegisteredCommandLike[]): () => CapabilityCatalog {
  let held: { readonly key: string; readonly catalog: CapabilityCatalog } | undefined;
  return () => {
    const registered = commands();
    const key = registered.map((command) => command.name).join(',');
    if (held?.key === key) return held.catalog;
    const catalog = new CapabilityCatalog(movedCapabilityEntries());
    catalog.addCommands(registered.flatMap((command) => command.described ? [command.described as CatalogCommandSource] : []));
    held = { key, catalog };
    return catalog;
  };
}
