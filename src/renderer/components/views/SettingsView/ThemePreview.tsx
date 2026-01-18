// ============================================================================
// THEME PREVIEW COMPONENT
// ============================================================================
//
// Visual preview of theme colors showing color swatches for primary, accent,
// success, warning, error, info, and sample text/backgrounds.
//
// ============================================================================

import type { Theme, ColorScale, SemanticColorSet } from '../../../../shared/types/theme-types';

interface ThemePreviewProps {
  theme: Theme;
  compact?: boolean;
}

/** Valid color scale shade keys */
type ColorShade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

/**
 * Color swatch component for displaying a single color
 */
function ColorSwatch({
  color,
  label,
  size = 'md',
}: {
  color: string;
  label?: string;
  size?: 'sm' | 'md';
}) {
  const sizeClasses = size === 'sm' ? 'w-4 h-4' : 'w-6 h-6';

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`${sizeClasses} rounded-md border border-surface-600/50 shadow-sm`}
        style={{ backgroundColor: color }}
        title={label ? `${label}: ${color}` : color}
      />
      {label && <span className="text-[9px] text-surface-500 truncate max-w-[40px]">{label}</span>}
    </div>
  );
}

/**
 * Color group showing multiple shades of a color scale
 */
function ColorGroup({
  label,
  colors,
  shades = [400, 500, 600],
}: {
  label: string;
  colors: ColorScale | SemanticColorSet;
  shades?: ColorShade[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium text-surface-400 uppercase tracking-wide">
        {label}
      </span>
      <div className="flex gap-0.5">
        {shades.map((shade) => (
          <ColorSwatch key={shade} color={colors[shade]} size="sm" />
        ))}
      </div>
    </div>
  );
}

/**
 * ThemePreview - Visual preview of theme colors
 *
 * Shows color swatches for:
 * - Primary and accent colors
 * - Semantic colors (success, warning, error, info)
 * - Text and background samples
 */
export function ThemePreview({ theme, compact = false }: ThemePreviewProps): React.JSX.Element {
  const { colors } = theme;

  if (compact) {
    // Compact view: Just show main colors in a row
    return (
      <div className="flex gap-1">
        <ColorSwatch color={colors.primary[500]} size="sm" />
        <ColorSwatch color={colors.accent[500]} size="sm" />
        <ColorSwatch color={colors.success[500]} size="sm" />
        <ColorSwatch color={colors.warning[500]} size="sm" />
        <ColorSwatch color={colors.error[500]} size="sm" />
        <ColorSwatch color={colors.info[500]} size="sm" />
      </div>
    );
  }

  return (
    <div
      className="rounded-lg p-3 border border-surface-700/50"
      style={{ backgroundColor: colors.bg.secondary }}
    >
      {/* Main color groups */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <ColorGroup label="Primary" colors={colors.primary} />
        <ColorGroup label="Accent" colors={colors.accent} />
        <ColorGroup label="Surface" colors={colors.surface} shades={[700, 800, 900]} />
      </div>

      {/* Semantic colors */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <ColorGroup label="Success" colors={colors.success} shades={[500]} />
        <ColorGroup label="Warning" colors={colors.warning} shades={[500]} />
        <ColorGroup label="Error" colors={colors.error} shades={[500]} />
        <ColorGroup label="Info" colors={colors.info} shades={[500]} />
      </div>

      {/* Text samples */}
      <div
        className="rounded-md p-2 space-y-1"
        style={{ backgroundColor: colors.bg.primary }}
      >
        <div className="text-xs" style={{ color: colors.text.primary }}>
          Primary text
        </div>
        <div className="text-xs" style={{ color: colors.text.secondary }}>
          Secondary text
        </div>
        <div className="text-xs" style={{ color: colors.text.muted }}>
          Muted text
        </div>
      </div>
    </div>
  );
}

export default ThemePreview;
