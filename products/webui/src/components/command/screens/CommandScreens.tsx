/**
 * The screens drawn from slash command descriptions, and the panel the
 * command palette opens one in. Each screen is a plain component, so a
 * settings section or a Work tab can also show it in place.
 */
import type { ComponentType } from 'react';
import { Drawer } from '../../ui/Drawer';
import { CommandScreenTitleShown } from './CommandScreen';
import { McpServers } from './McpServers';
import { RepeatPurchases } from './RepeatPurchases';
import { SchedulesPanel } from './SchedulesPanel';
import { TriggersPanel } from './TriggersPanel';

export interface CommandScreenEntry {
  readonly id: string;
  /** The palette row and the panel's name. */
  readonly title: string;
  /** The slash command it is drawn from (searchable in the palette as `/name`). */
  readonly command: string;
  readonly keywords: readonly string[];
  readonly Component: ComponentType;
}

export const COMMAND_SCREENS: readonly CommandScreenEntry[] = [
  { id: 'schedules', title: 'Schedules', command: 'schedule', keywords: ['schedule', 'routine', 'cron', 'every', 'remind', 'automation'], Component: SchedulesPanel },
  { id: 'mcp-servers', title: 'MCP servers and tools', command: 'mcp', keywords: ['mcp', 'servers', 'tools', 'block', 'trust', 'role'], Component: McpServers },
  { id: 'repeat-purchases', title: 'Repeat purchases', command: 'payments', keywords: ['payments', 'standing', 'repeat', 'purchase', 'buy', 'allowance'], Component: RepeatPurchases },
  { id: 'triggers', title: 'Triggers', command: 'triggers', keywords: ['triggers', 'watch', 'watcher', 'recovery', 'grant', 'fires'], Component: TriggersPanel },
];

export function CommandScreenDrawer({ screen, onClose }: { readonly screen: string | null; readonly onClose: () => void }) {
  const entry = COMMAND_SCREENS.find((candidate) => candidate.id === screen);
  if (!entry) return null;
  const { Component } = entry;
  return (
    <Drawer open onClose={onClose} label={entry.title} title={entry.title} width={600} modal data-testid={`command-screen-${entry.id}`}>
      <div className="gv-command-screen-drawer">
        <CommandScreenTitleShown.Provider value={false}>
          <Component />
        </CommandScreenTitleShown.Provider>
      </div>
    </Drawer>
  );
}
