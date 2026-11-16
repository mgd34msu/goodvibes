/** Where a host slash command writes text for the person who typed it. */
export interface HostCommandOutput {
  print(text: string): void;
}

export interface HostSlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly description: string;
  readonly usage?: string | undefined;
  readonly argsHint?: string | undefined;
  /** `output` is the typing session's output; a host with no session (the daemon) passes none. */
  readonly handler: (args: string[], output?: HostCommandOutput) => void | Promise<void>;
}

export interface CommandRegistryLike {
  register(command: HostSlashCommand): void;
  unregister(name: string): void;
}

export interface HostKeyCombo {
  readonly key: string;
  readonly ctrl?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly alt?: boolean | undefined;
}

export interface KeybindingEntry {
  readonly action: string;
  readonly combos: readonly HostKeyCombo[];
  readonly description: string;
}

export interface KeybindingsManagerLike {
  loadFromDisk?(): void;
  getAll?(): readonly KeybindingEntry[];
  getComboLabel?(action: string): string;
  formatCombo?(combo: HostKeyCombo): string;
  getConfigPath?(): string;
  matches?(
    action: string,
    token: { readonly logicalName?: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean },
  ): boolean;
}

export interface PanelInstanceLike {
  readonly id: string;
}

export interface PanelPaneLike {
  readonly panels: readonly PanelInstanceLike[];
  readonly activeIndex: number;
}

export interface PanelRegistrationLike {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

export interface PanelManagerLike {
  getTopPane(): PanelPaneLike;
  getBottomPane(): PanelPaneLike;
  getRegisteredTypes(): readonly PanelRegistrationLike[];
  /**
   * Open a registered view on the host. `true` only when the host actually
   * showed it; `false` when nothing holds the view or the host has no screen.
   */
  open(id: string, pane?: 'top' | 'bottom'): boolean;
}

const EMPTY_PANE: PanelPaneLike = Object.freeze({
  panels: Object.freeze([]),
  activeIndex: 0,
});

const EMPTY_PANEL_MANAGER: PanelManagerLike = Object.freeze({
  getTopPane: () => EMPTY_PANE,
  getBottomPane: () => EMPTY_PANE,
  getRegisteredTypes: () => [],
  open: () => false,
});

const EMPTY_KEYBINDINGS_MANAGER: KeybindingsManagerLike = Object.freeze({
  getAll: () => [],
  getComboLabel: () => '(unbound)',
  formatCombo: (combo: HostKeyCombo) => combo.key,
  getConfigPath: () => '',
  matches: () => false,
  loadFromDisk: () => {},
});

export function createNoopPanelManager(): PanelManagerLike {
  return EMPTY_PANEL_MANAGER;
}

export function createNoopKeybindingsManager(): KeybindingsManagerLike {
  return EMPTY_KEYBINDINGS_MANAGER;
}
