// ============================================================================
// THEME SETTINGS COMPONENT
// ============================================================================
//
// Theme selection grid with visual previews. Allows users to select from
// available color themes with preview of colors and variant badges.
//
// ============================================================================

import { clsx } from 'clsx';
import type { AppSettings } from '../../../../shared/types';
import type { ThemeId, Theme } from '../../../../shared/types/theme-types';
import { SettingsSection } from './components';
import { ThemePreview } from './ThemePreview';
import { getAllThemes, getThemesByVariant } from '../../../themes/registry';
import { applyTheme } from '../../../utils/themeInjector';

interface ThemeSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

/**
 * Badge displaying theme variant (dark/light)
 */
function VariantBadge({ variant }: { variant: 'dark' | 'light' }) {
  return (
    <span
      className={clsx(
        'px-1.5 py-0.5 text-[10px] font-medium rounded-full uppercase tracking-wide',
        variant === 'dark'
          ? 'bg-surface-700 text-surface-300'
          : 'bg-surface-200 text-surface-700'
      )}
    >
      {variant}
    </span>
  );
}

/**
 * Individual theme card in the selection grid
 */
function ThemeCard({
  theme,
  isSelected,
  onSelect,
}: {
  theme: Theme;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'relative text-left rounded-xl p-3 transition-all duration-200',
        'border-2 hover:border-primary-500/50',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-800',
        isSelected
          ? 'border-primary-500 bg-primary-500/10 shadow-lg shadow-primary-500/20'
          : 'border-surface-700 bg-surface-800/50 hover:bg-surface-800'
      )}
    >
      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
          <svg
            className="w-3 h-3 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      {/* Theme info header */}
      <div className="flex items-start justify-between mb-2 pr-6">
        <div>
          <h3 className="text-sm font-medium text-surface-100">{theme.name}</h3>
          {theme.author && (
            <p className="text-[10px] text-surface-500">by {theme.author}</p>
          )}
        </div>
        <VariantBadge variant={theme.variant} />
      </div>

      {/* Theme description */}
      <p className="text-xs text-surface-400 mb-3 line-clamp-2">{theme.description}</p>

      {/* Color preview */}
      <ThemePreview theme={theme} compact />
    </button>
  );
}

/**
 * Collapsed preview showing current theme with mini color swatches
 */
function CollapsedThemePreview({ theme }: { theme: Theme }) {
  const colors = theme.colors.terminal;
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex gap-0.5">
          {[colors.red, colors.green, colors.blue, colors.yellow, colors.magenta, colors.cyan].map(
            (color, i) => (
              <div
                key={i}
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: color }}
              />
            )
          )}
        </div>
        <div>
          <span className="text-sm font-medium text-surface-100">{theme.name}</span>
          <span className="text-xs text-surface-500 ml-2">({theme.variant})</span>
        </div>
      </div>
      <span className="text-xs text-surface-500">Click to expand</span>
    </div>
  );
}

/**
 * ThemeSettings - Main theme selection component
 *
 * Displays a grid of available themes with:
 * - Visual color previews
 * - Theme name, author, and description
 * - Variant badges (dark/light)
 * - Selection indicator
 */
export function ThemeSettings({ settings, onChange }: ThemeSettingsProps): React.JSX.Element {
  const { dark: darkThemes, light: lightThemes } = getThemesByVariant();
  const currentThemeId = settings.colorTheme;
  const currentTheme = getAllThemes().find((t) => t.id === currentThemeId);

  const handleThemeSelect = (themeId: ThemeId, theme: Theme) => {
    // Update the setting
    onChange('colorTheme', themeId);
    // Apply the theme immediately
    applyTheme(theme);
  };

  return (
    <SettingsSection
      title="Color Theme"
      collapsible
      defaultExpanded={false}
      collapsedPreview={
        currentTheme ? (
          <CollapsedThemePreview theme={currentTheme} />
        ) : (
          <div className="px-5 py-4 text-sm text-surface-500">No theme selected</div>
        )
      }
    >
      <div className="p-4 space-y-6">
        {/* Theme count summary */}
        <div className="text-xs text-surface-400">
          {getAllThemes().length} themes available ({darkThemes.length} dark, {lightThemes.length}{' '}
          light)
        </div>

        {/* Dark themes section */}
        {darkThemes.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-surface-600" />
              Dark Themes
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {darkThemes.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  isSelected={theme.id === currentThemeId}
                  onSelect={() => handleThemeSelect(theme.id, theme)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Light themes section */}
        {lightThemes.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-surface-300" />
              Light Themes
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {lightThemes.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  isSelected={theme.id === currentThemeId}
                  onSelect={() => handleThemeSelect(theme.id, theme)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Currently selected theme expanded preview */}
        <div className="space-y-3 pt-2 border-t border-surface-700/50">
          <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider">
            Current Theme Preview
          </h3>
          {currentTheme ? (
            <ThemePreview theme={currentTheme} />
          ) : (
            <p className="text-xs text-surface-500">No theme selected</p>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

export default ThemeSettings;
