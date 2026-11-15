/** A refused localStorage write must not throw from a click handler or revert the choice. */
import { afterEach, describe, expect, test } from 'bun:test';
import { readThemePreferences, THEME_PREFERENCES_EVENT, writeThemePreferences } from './theme';
import { readWebUiPreferences, WEBUI_PREFERENCES_EVENT, writeWebUiPreference } from './ui-preferences';

const realSetItem = Storage.prototype.setItem;

afterEach(() => {
  Storage.prototype.setItem = realSetItem;
  // A successful write clears the session-only value kept for a failed one.
  writeThemePreferences({ theme: 'dark', density: 'default' });
  writeWebUiPreference('codeBlockLineNumbers', false);
});

function refuseWrites(): void {
  Storage.prototype.setItem = () => {
    throw new Error('QuotaExceededError');
  };
}

describe('theme preferences', () => {
  test('a refused write still dispatches the change and later reads keep it', () => {
    refuseWrites();
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(THEME_PREFERENCES_EVENT, listener);
    try {
      expect(() => writeThemePreferences({ theme: 'light', density: 'compact' })).not.toThrow();
    } finally {
      window.removeEventListener(THEME_PREFERENCES_EVENT, listener);
    }
    expect(seen).toEqual([{ theme: 'light', density: 'compact' }]);
    expect(readThemePreferences()).toEqual({ theme: 'light', density: 'compact' });
  });
});

describe('webui preferences', () => {
  test('a refused write still dispatches the change and later reads keep it', () => {
    refuseWrites();
    let fired = 0;
    const listener = () => { fired += 1; };
    window.addEventListener(WEBUI_PREFERENCES_EVENT, listener);
    try {
      expect(() => writeWebUiPreference('codeBlockLineNumbers', true)).not.toThrow();
    } finally {
      window.removeEventListener(WEBUI_PREFERENCES_EVENT, listener);
    }
    expect(fired).toBe(1);
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(true);
  });
});
