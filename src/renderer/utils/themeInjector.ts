// ============================================================================
// THEME INJECTOR - CSS injection utility for dynamic theming
// ============================================================================
//
// This utility converts Theme objects into CSS custom properties and injects
// them into the document. It handles color scales, glows, gradients, and all
// semantic colors defined in the theme system.
//
// ============================================================================

import type {
  Theme,
  ColorScale,
  SemanticColorSet,
  GlowColors,
  GradientStops,
  BackgroundColors,
  TextColors,
  BorderColors,
  TerminalColors,
} from '../../shared/types/theme-types.js';

/** ID of the style element used for theme variables */
const THEME_STYLE_ID = 'theme-variables';

/** Data attribute name for storing the applied theme ID */
const THEME_DATA_ATTR = 'data-theme-id';

/** Color scale shade keys in order */
const COLOR_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/**
 * Generates CSS custom properties for a color scale.
 * Maps each shade to `--color-{name}-{shade}` variables.
 */
function generateColorScaleCSS(name: string, scale: ColorScale): string[] {
  const rules: string[] = [];
  for (const shade of COLOR_SHADES) {
    rules.push(`  --color-${name}-${shade}: ${scale[shade]};`);
  }
  return rules;
}

/**
 * Generates CSS custom properties for glow colors.
 * Maps to `--color-{name}-glow`, `--color-{name}-glow-strong`, etc.
 */
function generateGlowCSS(name: string, glow: GlowColors): string[] {
  return [
    `  --color-${name}-glow: ${glow.default};`,
    `  --color-${name}-glow-strong: ${glow.strong};`,
    `  --color-${name}-glow-subtle: ${glow.subtle};`,
    `  --color-${name}-glow-muted: ${glow.muted};`,
    `  --color-${name}-glow-faint: ${glow.faint};`,
  ];
}

/**
 * Generates CSS custom properties for gradient stops.
 * Maps to `--color-{name}-gradient-start`, `--color-{name}-gradient-mid`, `--color-{name}-gradient-end`.
 */
function generateGradientStopsCSS(name: string, gradient: GradientStops): string[] {
  return [
    `  --color-${name}-gradient-start: ${gradient.start};`,
    `  --color-${name}-gradient-mid: ${gradient.mid};`,
    `  --color-${name}-gradient-end: ${gradient.end};`,
  ];
}

/**
 * Generates CSS custom properties for a semantic color set (scale + glow + gradient).
 */
function generateSemanticColorSetCSS(name: string, colorSet: SemanticColorSet): string[] {
  const rules: string[] = [];

  // Color scale
  rules.push(...generateColorScaleCSS(name, colorSet));

  // Glow colors
  rules.push(...generateGlowCSS(name, colorSet.glow));

  // Gradient stops
  rules.push(...generateGradientStopsCSS(name, colorSet.gradient));

  return rules;
}

/**
 * Generates CSS custom properties for background colors.
 * Maps to `--color-bg-{name}` variables.
 */
function generateBackgroundColorsCSS(bg: BackgroundColors): string[] {
  return [
    `  --color-bg-primary: ${bg.primary};`,
    `  --color-bg-secondary: ${bg.secondary};`,
    `  --color-bg-tertiary: ${bg.tertiary};`,
    `  --color-bg-hover: ${bg.hover};`,
    `  --color-bg-elevated: ${bg.elevated};`,
    `  --color-bg-active: ${bg.active};`,
  ];
}

/**
 * Generates CSS custom properties for text colors.
 * Maps to `--color-text-{name}` variables.
 */
function generateTextColorsCSS(text: TextColors): string[] {
  return [
    `  --color-text-primary: ${text.primary};`,
    `  --color-text-secondary: ${text.secondary};`,
    `  --color-text-muted: ${text.muted};`,
    `  --color-text-disabled: ${text.disabled};`,
  ];
}

/**
 * Generates CSS custom properties for border colors.
 * Maps to `--color-border`, `--color-border-light`, etc.
 */
function generateBorderColorsCSS(border: BorderColors): string[] {
  return [
    `  --color-border: ${border.default};`,
    `  --color-border-light: ${border.light};`,
    `  --color-border-hover: ${border.hover};`,
    `  --color-border-focus: ${border.focus};`,
  ];
}

/**
 * Generates CSS custom properties for terminal colors.
 * Maps to `--color-xterm-bg`, `--color-xterm-fg`, `--color-xterm-cursor`, etc.
 */
function generateTerminalColorsCSS(terminal: TerminalColors): string[] {
  return [
    // Core terminal colors
    `  --color-xterm-bg: ${terminal.background};`,
    `  --color-xterm-fg: ${terminal.foreground};`,
    `  --color-xterm-cursor: ${terminal.cursor};`,
    `  --color-xterm-cursor-accent: ${terminal.cursorAccent};`,
    `  --color-xterm-selection: ${terminal.selectionBackground};`,

    // Standard ANSI colors (0-7)
    `  --color-xterm-black: ${terminal.black};`,
    `  --color-xterm-red: ${terminal.red};`,
    `  --color-xterm-green: ${terminal.green};`,
    `  --color-xterm-yellow: ${terminal.yellow};`,
    `  --color-xterm-blue: ${terminal.blue};`,
    `  --color-xterm-magenta: ${terminal.magenta};`,
    `  --color-xterm-cyan: ${terminal.cyan};`,
    `  --color-xterm-white: ${terminal.white};`,

    // Bright ANSI colors (8-15)
    `  --color-xterm-bright-black: ${terminal.brightBlack};`,
    `  --color-xterm-bright-red: ${terminal.brightRed};`,
    `  --color-xterm-bright-green: ${terminal.brightGreen};`,
    `  --color-xterm-bright-yellow: ${terminal.brightYellow};`,
    `  --color-xterm-bright-blue: ${terminal.brightBlue};`,
    `  --color-xterm-bright-magenta: ${terminal.brightMagenta};`,
    `  --color-xterm-bright-cyan: ${terminal.brightCyan};`,
    `  --color-xterm-bright-white: ${terminal.brightWhite};`,
  ];
}

/**
 * Converts a Theme object into CSS custom properties.
 *
 * @param theme - The theme object to convert
 * @returns CSS string with all custom properties wrapped in :root
 *
 * @example
 * ```typescript
 * const css = generateThemeCSS(myTheme);
 * // Returns:
 * // :root {
 * //   --color-primary-50: #eef2ff;
 * //   --color-primary-100: #e0e7ff;
 * //   ...
 * // }
 * ```
 */
export function generateThemeCSS(theme: Theme): string {
  const rules: string[] = [];
  const { colors } = theme;

  // Add theme metadata as CSS comment
  rules.push(`/* Theme: ${theme.name} (${theme.id}) */`);
  rules.push(`/* Variant: ${theme.variant} */`);
  if (theme.author) {
    rules.push(`/* Author: ${theme.author} */`);
  }
  rules.push('');

  rules.push(':root {');

  // Primary color (SemanticColorSet)
  rules.push('  /* Primary colors */');
  rules.push(...generateSemanticColorSetCSS('primary', colors.primary));
  rules.push('');

  // Accent color (SemanticColorSet)
  rules.push('  /* Accent colors */');
  rules.push(...generateSemanticColorSetCSS('accent', colors.accent));
  rules.push('');

  // Surface color (ColorScale only, no glow/gradient)
  rules.push('  /* Surface colors */');
  rules.push(...generateColorScaleCSS('surface', colors.surface));
  rules.push('');

  // Semantic colors (success, warning, error, info)
  rules.push('  /* Success colors */');
  rules.push(...generateSemanticColorSetCSS('success', colors.success));
  rules.push('');

  rules.push('  /* Warning colors */');
  rules.push(...generateSemanticColorSetCSS('warning', colors.warning));
  rules.push('');

  rules.push('  /* Error colors */');
  rules.push(...generateSemanticColorSetCSS('error', colors.error));
  rules.push('');

  rules.push('  /* Info colors */');
  rules.push(...generateSemanticColorSetCSS('info', colors.info));
  rules.push('');

  // Background colors
  rules.push('  /* Background colors */');
  rules.push(...generateBackgroundColorsCSS(colors.bg));
  rules.push('');

  // Text colors
  rules.push('  /* Text colors */');
  rules.push(...generateTextColorsCSS(colors.text));
  rules.push('');

  // Border colors
  rules.push('  /* Border colors */');
  rules.push(...generateBorderColorsCSS(colors.border));
  rules.push('');

  // Terminal colors
  rules.push('  /* Terminal colors */');
  rules.push(...generateTerminalColorsCSS(colors.terminal));

  rules.push('}');

  return rules.join('\n');
}

/**
 * Applies a theme to the document by injecting CSS custom properties.
 *
 * This function:
 * 1. Creates or updates a `<style id="theme-variables">` element in document.head
 * 2. Sets document.documentElement.style.colorScheme based on theme.variant
 * 3. Adds/removes 'light'/'dark' class on documentElement
 * 4. Stores the theme ID in a data attribute for retrieval
 *
 * @param theme - The theme object to apply
 *
 * @example
 * ```typescript
 * applyTheme(draculaTheme);
 * // Document now has Dracula theme colors applied
 * ```
 */
export function applyTheme(theme: Theme): void {
  // Generate the CSS
  const css = generateThemeCSS(theme);

  // Find or create the style element
  let styleEl = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = THEME_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  // Update the CSS content
  styleEl.textContent = css;

  // Set color scheme on documentElement
  document.documentElement.style.colorScheme = theme.variant;

  // Update light/dark class on documentElement
  const htmlEl = document.documentElement;
  if (theme.variant === 'light') {
    htmlEl.classList.add('light');
    htmlEl.classList.remove('dark');
  } else {
    htmlEl.classList.add('dark');
    htmlEl.classList.remove('light');
  }

  // Store the theme ID for later retrieval
  htmlEl.setAttribute(THEME_DATA_ATTR, theme.id);
}
