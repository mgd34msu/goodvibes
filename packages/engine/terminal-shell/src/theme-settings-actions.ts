/**
 * theme-settings-actions, the `display.theme` picker opened from settings.
 *
 * Lists 'system' plus every bundled theme (label + the modes it was authored
 * for). Moving the cursor previews the highlighted theme live (palettes
 * rebuild, full repaint); Enter stores it in `display.theme`; Esc restores the
 * theme that was active when the picker opened.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { SelectionResult } from './selection-modal.js';
export interface ThemePickerContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'> };
  readonly print: (text: string) => void;
  readonly renderRequest: () => void;
  readonly requestFullRepaint?: (() => void) | undefined;
  readonly clearScreen?: (() => void) | undefined;
  readonly openSelection?: ((title: string, items: SelectionItem[], options: { readonly preSelectId: string; readonly allowSearch: boolean; readonly primaryVerbLabel?: string | undefined; readonly onHighlight: (item: SelectionItem | null) => void }, callback: (result: SelectionResult | null) => void) => void) | undefined;
}
export interface ThemePickerPresentation { readonly clearScreen: boolean; readonly primaryVerbLabel: boolean }
const DEFAULT_PRESENTATION: ThemePickerPresentation = { clearScreen: false, primaryVerbLabel: true };
const THEME_NAME_CONFIG_KEY = 'display.theme';
import type { SelectionItem } from './selection-modal.js';
import {
  getActiveThemeName,
  listThemeChoices,
  normalizeThemeName,
  setActiveThemeName,
  type ThemeChoice,
} from './renderer/theme.js';
import { getTerminalPalette } from './terminal-palette-store.js';

function variantText(choice: ThemeChoice): string {
  return choice.variants.length > 1 ? `${choice.variants.join(' + ')}` : `${choice.variants[0] ?? 'dark'} only`;
}

function systemNote(): string {
  const palette = getTerminalPalette();
  const answered = palette !== null
    && (palette.background !== undefined || palette.foreground !== undefined || palette.ansi.some((slot) => slot !== undefined));
  return answered ? 'from your terminal colors' : 'terminal colors not read; shows GoodVibes';
}

/** Build the picker rows (exported for tests). */
export function buildThemePickerItems(current: string): SelectionItem[] {
  return listThemeChoices().map((choice) => {
    const detailParts = [choice.name === 'system' ? systemNote() : variantText(choice)];
    if (choice.name === current) detailParts.push('(current)');
    return {
      id: choice.name,
      label: choice.label,
      detail: detailParts.join('  '),
      category: choice.name === 'system' ? 'follow the terminal' : 'bundled themes',
      primaryAction: 'select',
      actions: '[Enter] use theme  [Esc] keep previous',
    };
  });
}

/** Open the theme picker. Returns false when this runtime has no selection modal. */
export function openThemePicker(ctx: ThemePickerContext, presentation: ThemePickerPresentation = DEFAULT_PRESENTATION): boolean {
  if (!ctx.openSelection) return false;
  const configured = normalizeThemeName(ctx.platform.configManager.get(THEME_NAME_CONFIG_KEY));
  const previous = getActiveThemeName();
  const repaint = (): void => {
    if (presentation.clearScreen && ctx.clearScreen) ctx.clearScreen();
    else { if (!presentation.clearScreen) ctx.requestFullRepaint?.(); ctx.renderRequest(); }
  };

  ctx.openSelection('Choose Theme', buildThemePickerItems(configured), {
    preSelectId: configured,
    allowSearch: true,
    ...(presentation.primaryVerbLabel ? { primaryVerbLabel: 'Use' } : {}),
    onHighlight: (item) => {
      if (!item || item.id === getActiveThemeName()) return;
      setActiveThemeName(item.id);
      repaint();
    },
  }, (result) => {
    if (!result) {
      if (getActiveThemeName() !== previous) {
        setActiveThemeName(previous);
        repaint();
      }
      return;
    }
    ctx.platform.configManager.setDynamic(THEME_NAME_CONFIG_KEY, result.item.id);
    const applied = setActiveThemeName(result.item.id);
    ctx.print(`Theme set to ${applied}.`);
    repaint();
  });
  return true;
}
