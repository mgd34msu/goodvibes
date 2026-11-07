import { formatTimestamp } from './modal-utils.js';
import { activeTokens } from './theme.js';
import { beginModal, finishModal, searchRow, scrollCountText, type KitHint, type SurfaceLayer } from './surface-kit.js';
import { drawList, type KitRow } from './surface-kit-list.js';
import { drawTextBlock, listHeight, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.js';

export interface ProfilePickerView {
  readonly profiles: readonly { readonly name: string; readonly timestamp: number }[];
  readonly visibleProfiles: readonly { readonly name: string; readonly timestamp: number }[];
  readonly selectedIndex: number;
  readonly query: string;
  readonly statusMessage: string;
  readonly deleteConfirmationTarget?: string | null | undefined;
  setVisibleRows?(rows: number): void;
}
export interface ProfilePickerPresentation {
  readonly hints: readonly KitHint[];
  readonly canDelete: boolean;
  readonly emptyHint: string;
  readonly description?: string;
  readonly note?: string;
  readonly trackVisibleRows: boolean;
  readonly mouseNavigation: boolean;
}
/** Geometry and rendering are shared; product-specific profile capabilities are explicit. */
export function createProfilePickerRenderer(presentation: ProfilePickerPresentation) {
  function renderProfilePickerModal(modal: ProfilePickerView, screenWidth: number, screenHeight = 24): SurfaceLayer {
    const t = activeTokens(),
      visible = modal.visibleProfiles;
    const armed = presentation.canDelete ? modal.deleteConfirmationTarget : null;
    const describe = (profile: { readonly name: string; readonly timestamp: number }): KitRow => ({
      label: profile.name,
      right: formatTimestamp(profile.timestamp),
      ...(presentation.description === undefined ? {} : { detail: presentation.description }),
    });
    const rows = visible.map(
      (profile, index): KitRow => ({
        ...describe(profile),
        selected: index === modal.selectedIndex,
        ...(presentation.canDelete
          ? { danger: armed === profile.name, ...(armed === profile.name ? { mark: '✕' } : {}), markFg: t.error }
          : {}),
      }),
    );
    const notes: TextLine[] = [];
    if (armed) notes.push({ text: `Press d again to permanently delete ${armed}.`, style: { fg: t.warning, bold: true } });
    else if (modal.statusMessage) notes.push({ text: modal.statusMessage, style: { fg: t.accent } });
    if (presentation.note) notes.push({ text: presentation.note, style: { fg: t.textFaint } });
    const width = modalTextWidth(screenWidth, screenHeight);
    const allRows = modal.profiles.map(describe);
    const emptyLines: TextLine[] = [
      { text: 'No saved profiles.', style: { fg: t.textMuted } },
      { text: presentation.emptyHint, style: { fg: t.textFaint } },
    ];
    const listRows = allRows.length ? listHeight(allRows, 0, width - 1) : textBlockHeight(emptyLines, width);
    const noteRows = notes.length ? textBlockHeight(notes, width) + 1 : 0;
    const height = modalHeightFor(screenWidth, screenHeight, { hints: presentation.hints }, 2 + listRows + noteRows);
    const f = beginModal(screenWidth, screenHeight, { title: 'Profiles', hints: presentation.hints, height });
    const total = modal.profiles.length;
    searchRow(f, f.top, modal.query, 'Filter profiles', modal.query ? `${visible.length} of ${total}` : `${total} saved`);
    const top = f.top + 2;
    const listBottom = presentation.trackVisibleRows ? Math.max(top, f.bottom - noteRows) : f.bottom - noteRows;
    if (presentation.trackVisibleRows) modal.setVisibleRows?.(Math.max(3, listBottom - top + 1));
    if (notes.length) drawTextBlock(f.canvas, f.l, listBottom + 2, f.r - f.l + 1, notes, f.bottom);
    if (!total) drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, emptyLines, listBottom);
    else if (!rows.length)
      drawTextBlock(
        f.canvas,
        f.l,
        top,
        f.r - f.l + 1,
        [{ text: `No profiles match "${modal.query}".`, style: { fg: t.textMuted } }],
        listBottom,
      );
    else {
      const result = drawList(f.canvas, {
        rows,
        top,
        bottom: listBottom,
        x0: f.l,
        x1: f.r,
        mouseNavigation: presentation.mouseNavigation,
        ...(presentation.trackVisibleRows ? { scrollKey: { owner: modal, name: 'profiles' } } : {}),
      });
      f.hintRight = scrollCountText(result.above, result.below);
    }
    return finishModal(f);
  }
  function renderProfilePickerPackageText(stateText = ''): string {
    return [
      'Profiles',
      'Filter profiles',
      '<n> saved',
      '<n> of <total>',
      'No saved profiles.',
      presentation.emptyHint,
      'No profiles match "<query>".',
      ...presentation.hints.map(([, action]) => action),
      presentation.note ?? '',
      stateText,
    ].join('\n');
  }
  return { renderProfilePickerModal, renderProfilePickerPackageText };
}
