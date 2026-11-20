/**
 * The one place a new kind of transcript row registers how it is drawn, so a
 * row kind is added without editing the conversation renderer.
 *
 * A row kind is named by the runtime event its system message restates
 * (`runtimeEvent.type` on the message, e.g. 'TURN_ERROR'). The conversation
 * renderer asks here first for every system message and turn notice that
 * carries an event; a kind with no renderer, or a renderer that returns null,
 * is drawn as a plain notice, as before.
 */
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';

export interface TranscriptRowInput {
  /** The runtime event the message restates. */
  readonly event: string;
  readonly content: string;
  readonly severity?: 'error' | 'warning' | 'info' | undefined;
  /** The message's index in the conversation. */
  readonly messageIndex: number;
  readonly width: number;
}

/** Draw a row; null draws it as a plain notice. */
export type TranscriptRowRenderer = (input: TranscriptRowInput) => Line[] | null;

const renderers = new Map<string, TranscriptRowRenderer>();

/** Register the renderer for one event's rows; returns the call that removes it. */
export function registerTranscriptRowRenderer(event: string, renderer: TranscriptRowRenderer): () => void {
  renderers.set(event, renderer);
  return () => {
    if (renderers.get(event) === renderer) renderers.delete(event);
  };
}

/** The registered drawing of a row, or null when its kind has none. */
export function renderRegisteredTranscriptRow(input: TranscriptRowInput): Line[] | null {
  return renderers.get(input.event)?.(input) ?? null;
}
