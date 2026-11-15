/**
 * UIEvent, what the terminal apps show: which panels are open and focused, and
 * which view fills the screen.
 *
 * Published by the TUI and the Agent from the frame they draw
 * (terminal-shell `createUiEventPublisher`), only when something changed. A
 * panel is a modal on the screen (`settings`, `modelPicker`, a kit modal such
 * as the command palette); the focused panel is the top one. A view is `main`,
 * `agent:<id>` or `process:<id>`.
 */

export type GoodVibesUIEvent =
  /** A panel was opened. */
  | { type: 'UI_PANEL_OPEN'; panelId: string }
  /** A panel was closed. */
  | { type: 'UI_PANEL_CLOSE'; panelId: string }
  /** A panel became the focused (top) panel. */
  | { type: 'UI_PANEL_FOCUS'; panelId: string }
  /** The view that fills the screen changed (e.g. main -> agent:a1). */
  | { type: 'UI_VIEW_CHANGED'; from: string; to: string };

/** All GoodVibes UI event type literals as a union. */
export type GoodVibesUIEventType = GoodVibesUIEvent['type'];

// GoodVibesUIEvent / GoodVibesUIEventType avoid colliding with the DOM global UIEvent.
