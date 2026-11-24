/**
 * The screens drawn from slash command descriptions, by name: what the palette
 * lists and the composer's slash menu offers. The screens themselves load when
 * one opens (CommandScreens.tsx).
 */
export interface CommandScreenListing {
  readonly id: string;
  /** The palette row and the panel's name. */
  readonly title: string;
  /** The slash command it is drawn from (searchable in the palette as `/name`). */
  readonly command: string;
  readonly keywords: readonly string[];
}

export const COMMAND_SCREEN_LIST: readonly CommandScreenListing[] = [
  { id: 'schedules', title: 'Schedules', command: 'schedule', keywords: ['schedule', 'routine', 'cron', 'every', 'remind', 'automation'] },
  { id: 'mcp-servers', title: 'MCP servers and tools', command: 'mcp', keywords: ['mcp', 'servers', 'tools', 'block', 'trust', 'role'] },
  { id: 'repeat-purchases', title: 'Repeat purchases', command: 'payments', keywords: ['payments', 'standing', 'repeat', 'purchase', 'buy', 'allowance'] },
  { id: 'triggers', title: 'Triggers', command: 'triggers', keywords: ['triggers', 'watch', 'watcher', 'recovery', 'grant', 'fires'] },
];
