/** Recognize the compiler's actual virtual filesystem root. A literal marker
 * inside an ordinary checkout/package path does not establish a bundled run.
 * This is location classification only, never artifact or execution admission. */
export function isCompiledBunModuleUrl(moduleUrl: string): boolean {
  try {
    const parsed = new URL(moduleUrl);
    return parsed.protocol === 'file:' && parsed.hostname === '' && decodeURIComponent(parsed.pathname).startsWith('/$bunfs/');
  } catch { return false; }
}
