/**
 * The platform's key names for shortcuts: one answer to "is this an Apple device"
 * for both the keys a shortcut is bound to (hooks/useHotkeys.ts maps `mod` to
 * Meta there) and the labels that name them, so a label never names a key that
 * does nothing.
 */

/** Mac, iPhone and iPad (an iPad reports itself as a Mac): `mod` is Command there, Control elsewhere. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * New chat's keys, bound in the command table and shown on the rail: a two-key
 * sequence, since every browser keeps Ctrl+Shift+N (a private window) and
 * Ctrl+Shift+O (bookmarks) for itself. Like every sequence it works outside a text field.
 */
export const NEW_CHAT_KEYS = 'g n';

/** "mod+shift+n" → "Ctrl Shift N" (⌘ ⇧ N on a Mac); "mod+k" → "Ctrl K" / "⌘ K"; "g c" → "G then C". */
export function formatShortcut(shortcut: string): string {
  const apple = isApplePlatform();
  if (shortcut.includes(' ') && !shortcut.includes('+')) {
    return shortcut.split(' ').map((part) => part.toUpperCase()).join(' then ');
  }
  return shortcut
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'mod') return apple ? '⌘' : 'Ctrl';
      if (lower === 'shift') return apple ? '⇧' : 'Shift';
      if (lower === 'alt') return apple ? '⌥' : 'Alt';
      if (lower === 'enter') return apple ? '↩' : 'Enter';
      if (lower === 'escape' || lower === 'esc') return 'Esc';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' ');
}
