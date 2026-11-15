import { DEFAULT_VIEW_PALETTE } from '../polish.ts';
import type { ModalSectionStyle } from '../../input/config-modal-types.ts';
import type { ConfigModalActionContext, ConfigModalRow } from '../../input/config-modal-types.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';

/**
 * Shared formatting helpers for config-modal surfaces. Row styling reuses
 * DEFAULT_VIEW_PALETTE (theme tokens). The frame, tabs, search row, group
 * headers and keycap hints are drawn by the modal surface kit in
 * renderConfigModal; surfaces only describe rows.
 */
export const PALETTE = DEFAULT_VIEW_PALETTE;

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'dim' | 'value';

/** Map a semantic tone to a ModalSectionStyle (foreground only). */
export function toneStyle(tone: Tone): ModalSectionStyle {
  return { fg: PALETTE[tone] };
}

/** A single-glyph status dot matching the provider-console convention
 *  (● online · ◐ warming · ✕ error · ○ idle). */
export function statusGlyph(tone: Tone): string {
  switch (tone) {
    case 'good': return '●';
    case 'warn': return '◐';
    case 'bad': return '✕';
    default: return '○';
  }
}

/** Fixed-width left-justify by display columns (plain padEnd is fine for the
 *  ASCII/latin labels these surfaces use; wide glyphs are the status dot only,
 *  which we place at a fixed column). */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Build a `label value` posture cell for the header line. */
export function kv(label: string, value: string | number): string {
  return `${label} ${value}`;
}

/** Join posture cells into one header line with a consistent separator. */
export function postureLine(cells: string[]): string {
  return cells.join('   ');
}

/**
 * A stable non-selectable informational row (section title, empty-state copy,
 * or a content line the surface renders but the cursor never lands on). `id`
 * must be unique within its tab so the host's live-value overlay keys off it.
 */
export function infoRow(id: string, label: string, style?: ModalSectionStyle): ConfigModalRow {
  return { id, label, selectable: false, ...(style ? { style } : {}) };
}

/**
 * A group header row (a section title such as "Next steps"). The kit draws it
 * as a ✦ lowercase accent header with a blank row above it; it is never
 * selectable and never filtered out by the search row.
 */
export function headerRow(id: string, label: string): ConfigModalRow {
  return { id, label, selectable: false, header: true };
}

/**
 * Run a slash command from a modal action and report what actually happened.
 * The status line reads "Dispatched ..." while the command runs, then "Done"
 * once it ran, "Failed: <reason>" when it refused (a command refuses by
 * throwing its refusal) or threw, and "Not a command" when no command has that
 * name. It never escapes as an unhandled rejection. `afterSettle` runs on
 * success and on failure (the screen may have changed either way) and is where
 * a surface re-reads the data the command changed: refreshing before the
 * command settles would read the old value back.
 */
export function runModalCommand(
  ctx: ConfigModalActionContext,
  name: string,
  args: string[],
  label: string,
  options: { readonly pending?: string; readonly done?: string; readonly afterSettle?: () => void } = {},
): void {
  const run = ctx.executeCommand;
  if (!run) {
    ctx.setStatus(`Not run: ${label} (this session has no command runner).`);
    return;
  }
  ctx.setStatus(options.pending ?? `Dispatched ${label}.`);
  // The command starts now, in the key handler's own tick; a synchronous throw from the runner is turned into a rejection.
  let started: Promise<unknown>;
  try { started = Promise.resolve(run(name, args)); } catch (error) { started = Promise.reject(error); }
  void started
    .then(
      (found) => ctx.setStatus(found === false ? `Not a command: /${name} (${label} was not run).` : options.done ?? `Done: ${label}.`),
      (error: unknown) => {
        const refused = readRefusal(error);
        ctx.setStatus(`Failed: ${label}: ${refused ? formatRefusal(refused) : summarizeError(error)}`);
      },
    )
    .then(() => {
      try { options.afterSettle?.(); } catch (error) { ctx.setStatus(`Failed to refresh after ${label}: ${summarizeError(error)}`); }
      ctx.requestRender();
    });
}
