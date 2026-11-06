export interface HelpGroup {
  readonly title: string;
  readonly entries: Array<{
    readonly label: string;
    readonly right: string;
  }>;
}
export function filterGroups(groups: readonly HelpGroup[], query: string): HelpGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups
    .map((g) => ({
      title: g.title,
      entries: g.title.toLowerCase().includes(q)
        ? g.entries
        : g.entries.filter((e) => e.label.toLowerCase().includes(q) || e.right.toLowerCase().includes(q)),
    }))
    .filter((g) => g.entries.length > 0);
}

/** Treat plugin metadata as untrusted: one throwing getter cannot break help navigation. */
export function hasHelpCommand(
  commands: readonly { readonly name: string; readonly aliases?: readonly string[] | undefined }[] | undefined,
  name: string,
): boolean {
  if (!commands) return false;
  for (const command of commands) {
    try {
      if (command.name === name || (command.aliases ?? []).includes(name)) return true;
    } catch {
      /* Skip malformed plugin metadata. */
    }
  }
  return false;
}
