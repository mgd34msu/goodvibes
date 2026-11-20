import type { Line } from '@goodvibes/engine/platform/platform/types';
import type { SurfaceLayer } from './surface-kit.js';
import { overlayViewportBottom } from './conversation-layout.js';
import { isTrackedModal, type StackedModal } from '../surface-modal-host.js';
export type ModalEntry = readonly [name: string, active: boolean, render: () => SurfaceLayer | null];
type ActiveModal = { readonly active: boolean };
type CommonConversationModals = Readonly<Record<'modelPicker' | 'settingsModal' | 'mcpWorkspace' | 'sessionPickerModal'
  | 'profilePickerModal' | 'bookmarkModal' | 'blockActionsMenu' | 'selectionModal' | 'contextInspectorModal', ActiveModal>> & {
  readonly surfaceModals: { modals(): readonly StackedModal[] };
};
/** Product-only workspaces join this predicate at their composition boundary. */
export function isCommonConversationModalOpen(input: CommonConversationModals): boolean {
  return input.modelPicker.active || input.settingsModal.active || input.mcpWorkspace.active || input.sessionPickerModal.active
    || input.profilePickerModal.active || input.bookmarkModal.active || input.blockActionsMenu.active || input.selectionModal.active
    || input.contextInspectorModal.active
    || input.surfaceModals.modals().some((modal) => !isTrackedModal(modal));
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
/**
 * Draw the modal stack bottom to top: a kit modal draws itself, a tracked
 * modal through the product's entry of the same name (an entry that is not
 * visible, or a modal with no entry, such as a composer popup, draws nothing
 * here), then the permission dialog. Nothing else is drawn over the
 * conversation: a notice is never a box on screen, only the status bar's
 * count, opened with the notices key.
 */
export function composeConversationLayers(options: {
  readonly entries: readonly ModalEntry[];
  readonly modals: readonly StackedModal[];
  readonly width: number;
  readonly height: number;
  readonly permission?: SurfaceLayer | null | undefined;
}): SurfaceLayer[] {
  const { entries, modals, width, height } = options;
  const layers: SurfaceLayer[] = [];
  for (const modal of modals) {
    if (!isTrackedModal(modal)) {
      layers.push(modal.render(width, height));
      continue;
    }
    const entry = entries.find(([name]) => name === modal.name);
    if (!entry?.[1]) continue;
    const layer = entry[2]();
    if (layer) layers.push(layer);
  }
  if (options.permission) layers.push(options.permission);
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
