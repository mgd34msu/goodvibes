import { useEffect, useState } from 'react';

export const WEBUI_PREFERENCES_KEY = 'goodvibes.webui.preferences';
export const WEBUI_PREFERENCES_EVENT = 'goodvibes:webui-preferences';

export interface WebUiPreferences {
  codeBlockLineNumbers: boolean;
  /**
   * Memory provenance chip (owner-ruled, default OFF): when true, a chat turn
   * that used memories shows a small chip with drill-in listing the injection
   * records (MemoryProvenanceChip.tsx, memory-provenance.ts). Off by default,
   * nothing renders until the owner opts in.
   */
  memoryProvenanceChipEnabled: boolean;
  /** Code blocks wrap long lines instead of scrolling sideways (the toggle on every code block), once chosen. */
  codeBlockWrap: boolean;
  /**
   * The person used the wrap toggle. Until then a code block wraps on a screen
   * narrower than 640 px and scrolls on a wider one (codeBlockWrapFor); a stored
   * `codeBlockWrap` written before this flag existed was never a choice, so it is
   * read as not chosen.
   */
  codeBlockWrapChosen: boolean;
  /**
   * Hold still in this browser even when the system does not ask for reduced
   * motion: menus, panels and toasts appear without moving, the "Thinking…" line
   * does not shimmer, nothing scrolls smoothly. The system's own setting always
   * applies too.
   */
  reduceMotion: boolean;
  /** Setup checklist steps the person chose "Skip for now" on, in this browser (SetupChecklist). */
  setupSkipped: readonly string[];
  /**
   * The person agreed to dictate with this browser's own speech service (which sends the
   * audio to the browser's maker) while the daemon has no speech-to-text provider: the mic
   * then dictates with one tap. Shown and turned off in Settings, Voice.
   */
  browserDictation: boolean;
}

export const DEFAULT_WEBUI_PREFERENCES: WebUiPreferences = {
  codeBlockLineNumbers: false,
  memoryProvenanceChipEnabled: false,
  codeBlockWrap: false,
  codeBlockWrapChosen: false,
  reduceMotion: false,
  setupSkipped: [],
  browserDictation: false,
};

const SYSTEM_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether motion is reduced right now: this browser's setting, or the system's. */
export function motionReduced(): boolean {
  if (readWebUiPreferences().reduceMotion) return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_REDUCED_MOTION).matches;
}

/**
 * Keep the setting on the page root (`data-motion="reduce"`), which the
 * stylesheets read like the system query: set at boot, and again whenever the
 * preference changes in this tab or another.
 */
export function applyMotionPreference(): void {
  if (typeof document === 'undefined') return;
  const apply = () => {
    const root = document.documentElement;
    if (readWebUiPreferences().reduceMotion) root.dataset.motion = 'reduce';
    else delete root.dataset.motion;
  };
  apply();
  window.addEventListener('storage', apply);
  window.addEventListener(WEBUI_PREFERENCES_EVENT, apply);
}

/** Below this width an unchosen code block wraps (a phone held upright). */
export const CODE_WRAP_QUERY = '(max-width: 639px)';

/** Whether code blocks wrap: the person's choice once made, else by the screen's width. */
export function codeBlockWrapFor(preferences: Pick<WebUiPreferences, 'codeBlockWrap' | 'codeBlockWrapChosen'>, narrow: boolean): boolean {
  return preferences.codeBlockWrapChosen ? preferences.codeBlockWrap : narrow;
}

/** The wrap toggle: records the choice so the width no longer decides. */
export function chooseCodeBlockWrap(wrap: boolean): WebUiPreferences {
  writeWebUiPreference('codeBlockWrapChosen', true);
  return writeWebUiPreference('codeBlockWrap', wrap);
}

type PreferenceKey = keyof WebUiPreferences;

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** The last value storage refused to keep; readers prefer it so the change event does not revert it. */
let unpersisted: WebUiPreferences | null = null;

export function readWebUiPreferences(): WebUiPreferences {
  if (unpersisted !== null) return unpersisted;
  if (!storageAvailable()) return DEFAULT_WEBUI_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(WEBUI_PREFERENCES_KEY);
    if (!stored) return DEFAULT_WEBUI_PREFERENCES;
    const parsed = JSON.parse(stored) as Partial<WebUiPreferences>;
    return {
      ...DEFAULT_WEBUI_PREFERENCES,
      ...parsed,
      codeBlockLineNumbers: Boolean(parsed.codeBlockLineNumbers),
      memoryProvenanceChipEnabled: Boolean(parsed.memoryProvenanceChipEnabled),
      codeBlockWrap: Boolean(parsed.codeBlockWrap),
      codeBlockWrapChosen: parsed.codeBlockWrapChosen === true,
      reduceMotion: parsed.reduceMotion === true,
      browserDictation: parsed.browserDictation === true,
      setupSkipped: Array.isArray(parsed.setupSkipped) ? parsed.setupSkipped.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return DEFAULT_WEBUI_PREFERENCES;
  }
}

export function writeWebUiPreference<Key extends PreferenceKey>(key: Key, value: WebUiPreferences[Key]): WebUiPreferences {
  const next = { ...readWebUiPreferences(), [key]: value };
  if (storageAvailable()) {
    try {
      window.localStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify(next));
      unpersisted = null;
    } catch {
      // The preference still applies for this session, it just is not remembered.
      unpersisted = next;
    }
    window.dispatchEvent(new CustomEvent(WEBUI_PREFERENCES_EVENT, { detail: next }));
  }
  return next;
}

export function useWebUiPreferences() {
  const [preferences, setPreferences] = useState<WebUiPreferences>(() => readWebUiPreferences());

  useEffect(() => {
    function refresh() {
      setPreferences(readWebUiPreferences());
    }

    window.addEventListener('storage', refresh);
    window.addEventListener(WEBUI_PREFERENCES_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(WEBUI_PREFERENCES_EVENT, refresh);
    };
  }, []);

  return [preferences, writeWebUiPreference] as const;
}
