/**
 * terminal-bg-color, reading a terminal's reported background colour as light
 * or dark. Pure parsing and classification, with no terminal I/O and no config:
 * the startup probe (terminal-bg-probe.ts) and the theme-mode setting
 * (theme-mode-config.ts) both classify the same reply through it, so neither
 * has to import the other.
 */
import type { ThemeMode } from './theme.js';
/** Luminance split point (normalized 0..1). At/above → light; below → dark. */
export const LUMINANCE_LIGHT_THRESHOLD = 0.5;
/** An 8-bit-per-channel colour parsed from an OSC 11 reply. */
export interface ProbeRgb {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}
/**
 * Parse a single hex channel of `len` digits into an 8-bit value.
 * Scales by the channel's own full-scale (16^len - 1) so `ffff`→255, `ff`→255,
 * `80`→128, `8000`→128. Returns null on non-hex input.
 */
function parseHexChannel(hex: string): number | null {
    if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex))
        return null;
    const max = 16 ** hex.length - 1;
    return Math.round((parseInt(hex, 16) / max) * 255);
}
/**
 * Parse an OSC 11 colour spec into 8-bit RGB. Accepts:
 *   - `rgb:RRRR/GGGG/BBBB` and `rgb:RR/GG/BB` (1–4 hex digits per channel)
 *   - `rgba:R/G/B/A` (alpha ignored)
 *   - `#RRGGBB` and `#RRRRGGGGBBBB`
 * Returns null for anything else (→ caller treats as dark).
 */
export function parseColorSpec(spec: string): ProbeRgb | null {
    const trimmed = spec.trim();
    if (trimmed.startsWith('rgb:') || trimmed.startsWith('rgba:')) {
        const body = trimmed.slice(trimmed.indexOf(':') + 1);
        const [red, green, blue] = body.split('/');
        if (red === undefined || green === undefined || blue === undefined)
            return null;
        const r = parseHexChannel(red);
        const g = parseHexChannel(green);
        const b = parseHexChannel(blue);
        if (r === null || g === null || b === null)
            return null;
        return { r, g, b };
    }
    if (trimmed.startsWith('#')) {
        const hex = trimmed.slice(1);
        if (hex.length !== 6 && hex.length !== 12)
            return null;
        if (!/^[0-9a-fA-F]+$/.test(hex))
            return null;
        const per = hex.length / 3;
        const r = parseHexChannel(hex.slice(0, per));
        const g = parseHexChannel(hex.slice(per, per * 2));
        const b = parseHexChannel(hex.slice(per * 2));
        if (r === null || g === null || b === null)
            return null;
        return { r, g, b };
    }
    return null;
}
/**
 * Classify a background colour as 'light' or 'dark' by relative luminance.
 * Uses the Rec. 601 luma weights (0.299/0.587/0.114) normalized to 0..1 and
 * splits at LUMINANCE_LIGHT_THRESHOLD (0.5). Conservative by construction, the
 * exact threshold only matters for mid-grey backgrounds, which are rare.
 */
export function classifyBackgroundLuminance(rgb: ProbeRgb): ThemeMode {
    const luma = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luma >= LUMINANCE_LIGHT_THRESHOLD ? 'light' : 'dark';
}
