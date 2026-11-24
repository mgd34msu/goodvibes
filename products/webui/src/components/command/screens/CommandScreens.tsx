/**
 * The screens drawn from slash command descriptions (listed in
 * command-screen-list.ts), and the panel the command palette opens one in.
 * Each screen is a plain component, so a settings section or a Work tab can
 * also show it in place.
 */
import type { ComponentType } from 'react';
import { Drawer } from '../../ui/Drawer';
import { CommandScreenTitleShown } from './CommandScreen';
import { COMMAND_SCREEN_LIST, type CommandScreenListing } from './command-screen-list';
import { McpServers } from './McpServers';
import { RepeatPurchases } from './RepeatPurchases';
import { SchedulesPanel } from './SchedulesPanel';
import { TriggersPanel } from './TriggersPanel';

export interface CommandScreenEntry extends CommandScreenListing {
  readonly Component: ComponentType;
}

const SCREEN_COMPONENTS: Readonly<Record<string, ComponentType>> = {
  'schedules': SchedulesPanel,
  'mcp-servers': McpServers,
  'repeat-purchases': RepeatPurchases,
  'triggers': TriggersPanel,
};

export const COMMAND_SCREENS: readonly CommandScreenEntry[] = COMMAND_SCREEN_LIST.flatMap((entry) => {
  const Component = SCREEN_COMPONENTS[entry.id];
  return Component ? [{ ...entry, Component }] : [];
});

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
