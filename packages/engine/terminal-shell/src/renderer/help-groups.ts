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

/** Curated and exhaustive command groups, filtered against the actual registered surface. */
export function commandHelpGroups(
  commands:
    | readonly { readonly name: string; readonly description: string; readonly aliases?: readonly string[] | undefined }[]
    | undefined,
  policy: {
    readonly featured: readonly (readonly [string, string, string])[];
    readonly preferred: readonly string[];
    readonly essentials?: readonly (readonly [string, string])[] | undefined;
    readonly fallback: HelpGroup['entries'];
    readonly onTraversalError: (error: unknown) => void;
  },
): HelpGroup[] {
  const groups: HelpGroup[] = [],
    seen = new Set<string>();
  if (policy.essentials) {
    const entries = policy.essentials
      .filter(([name]) => hasHelpCommand(commands, name))
      .map(([name, label]) => {
        seen.add(name);
        return { label, right: '/' + name };
      });
    if (entries.length) groups.push({ title: 'Essentials', entries });
  }
  const featured = (rows: typeof policy.featured) =>
    rows.map(([name, hint, label]) => ({ label, right: '/' + name + (hint ? ' ' + hint : '') }));
  let quickStart: HelpGroup['entries'];
  try {
    quickStart = featured(policy.featured.filter(([name]) => hasHelpCommand(commands, name)));
  } catch (error) {
    policy.onTraversalError(error);
    quickStart = featured(policy.featured);
  }
  if (quickStart.length) groups.push({ title: 'Quick Start', entries: quickStart });
  if (commands?.length) {
    const entries: HelpGroup['entries'] = [];
    for (const name of policy.preferred) {
      const command = commands.find((command) => command.name === name);
      if (!command || seen.has(command.name)) continue;
      seen.add(command.name);
      entries.push({ label: command.description, right: '/' + command.name });
    }
    if (entries.length) groups.push({ title: 'Available Slash Commands', entries });
    const remainder = commands
      .filter((command) => !seen.has(command.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((command) => ({ label: command.description, right: '/' + command.name }));
    if (remainder.length) groups.push({ title: 'More Commands', entries: remainder });
  } else if (!hasHelpCommand(commands, 'help') && policy.fallback.length) groups.push({ title: 'Essentials', entries: policy.fallback });
  return groups;
}
