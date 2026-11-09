import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { SurfaceLayer } from './surface-kit.js';
import { renderToasts, type ToastSpec } from './surface-kit-parts.js';
import { overlayViewportBottom } from './conversation-layout.js';
export type ModalEntry = readonly [name: string, active: boolean, render: () => SurfaceLayer | null];
type ActiveModal = { readonly active: boolean };
type CommonConversationModals = Readonly<Record<'modelPicker' | 'settingsModal' | 'mcpWorkspace' | 'sessionPickerModal'
  | 'profilePickerModal' | 'bookmarkModal' | 'blockActionsMenu' | 'selectionModal' | 'contextInspectorModal' | 'surfaceModals', ActiveModal>> & {
  readonly helpOverlayActive: boolean;
  readonly shortcutsOverlayActive: boolean;
};
/** Product-only workspaces join this predicate at their composition boundary. */
export function isCommonConversationModalOpen(input: CommonConversationModals): boolean {
  return input.modelPicker.active || input.settingsModal.active || input.mcpWorkspace.active || input.sessionPickerModal.active
    || input.profilePickerModal.active || input.bookmarkModal.active || input.blockActionsMenu.active || input.selectionModal.active
    || input.contextInspectorModal.active || input.helpOverlayActive || input.shortcutsOverlayActive || input.surfaceModals.active;
}

/** Popup lifetimes and anchoring are common; renderers retain each product's
 * styles and the caller declares viewport replacement/mutation policy. */
export function applyConversationPopupRows<Input extends {
  readonly filePicker: ActiveModal;
  readonly searchManager: ActiveModal;
  readonly historySearch: ActiveModal;
  readonly commandMode: boolean;
  readonly autocomplete: { readonly isActive: boolean } | null;
}>(viewport: Line[], input: Input, options: {
  readonly width: number;
  readonly height: number;
  readonly covered: boolean;
  readonly mutateSearchRows: boolean;
  readonly replaceViewport?: (() => Line[]) | undefined;
}, renderers: {
  readonly filePicker: (picker: Input['filePicker'], width: number, height: number) => Line[];
  readonly search: (search: Input['searchManager'], width: number) => Line[];
  readonly historySearch: (search: Input['historySearch'], width: number) => Line[];
  readonly autocomplete: (autocomplete: NonNullable<Input['autocomplete']>, width: number, height: number) => Line[];
}): Line[] {
  const { width, height } = options, autocomplete = input.autocomplete;
  return applyConversationOverlayRows(viewport, { ...options,
    filePicker: input.filePicker.active ? () => renderers.filePicker(input.filePicker, width, height) : undefined,
    search: input.searchManager.active ? () => renderers.search(input.searchManager, width) : undefined,
    historySearch: input.historySearch.active ? () => renderers.historySearch(input.historySearch, width) : undefined,
    autocomplete: input.commandMode && autocomplete?.isActive ? () => renderers.autocomplete(autocomplete, width, height) : undefined,
  });
}
/** Preserve modal-stack order, then the product's declared fallback order. */
export function composeConversationLayers(options: {
  readonly entries: readonly ModalEntry[];
  readonly modalStack: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly renderSurfaceModals: () => SurfaceLayer[];
  readonly permission?: SurfaceLayer | null | undefined;
  readonly headerRows?: number | undefined;
  readonly footerRows?: number | undefined;
  readonly toasts: () => readonly ToastSpec[];
}): SurfaceLayer[] {
  const { entries, modalStack, width, height } = options;
  const rank = (name: string): number => {
    const index = modalStack.indexOf(name);
    return index >= 0 ? index : modalStack.length + entries.findIndex(([candidate]) => candidate === name);
  };
  const active = entries.filter(([, isActive]) => isActive).sort((a, b) => rank(a[0]) - rank(b[0]));
  const layers: SurfaceLayer[] = [];
  for (const [, , render] of active) {
    const layer = render();
    if (layer) layers.push(layer);
  }
  layers.push(...options.renderSurfaceModals());
  if (options.permission) layers.push(options.permission);
  const toasts = renderToasts(width, height, options.toasts(), {
    top: options.headerRows ?? 1,
    bottom: height - (options.footerRows ?? 2),
  });
  if (toasts) layers.push(toasts);
  return layers;
}
/** The full-screen product flow can replace the viewport; transient popups remain composer-anchored. */
export function applyConversationOverlayRows(
  viewport: Line[],
  options: {
    readonly width: number;
    readonly height: number;
    readonly covered: boolean;
    readonly replaceViewport?: (() => Line[]) | undefined;
    readonly filePicker?: (() => Line[]) | undefined;
    readonly search?: (() => Line[]) | undefined;
    readonly historySearch?: (() => Line[]) | undefined;
    readonly autocomplete?: (() => Line[]) | undefined;
    readonly mutateSearchRows: boolean;
  },
): Line[] {
  let next = options.replaceViewport ? options.replaceViewport() : viewport;
  const inset = 1 + (options.search || options.historySearch ? 1 : 0);
  if (!options.replaceViewport && !options.covered && options.filePicker)
    next = overlayViewportBottom(next, options.filePicker(), options.width, options.height, inset);
  for (const render of [options.search, options.historySearch]) {
    if (!render) continue;
    const rows = render();
    if (options.mutateSearchRows) next.push(...rows);
    else next = [...next, ...rows];
  }
  if (!options.replaceViewport && !options.covered && options.autocomplete) {
    const rows = options.autocomplete();
    if (rows.length) next = overlayViewportBottom(next, rows, options.width, options.height, inset);
  }
  return next;
}
