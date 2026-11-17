import type { SetStateAction } from 'react';

/**
 * The text of the reply being streamed, held outside React state so a token
 * re-renders only the live bubble that subscribes to it, not the chat view and
 * its message list. Growth is published at most once per animation frame, so a
 * burst of tokens costs one render; clearing is published at once, so the stored
 * reply never shows beside a stale live bubble.
 */
export interface LiveReplyStore {
  /** The published text (what subscribers render). */
  get(): string;
  /** Same shape as a React state setter, so the stream and send hooks write it unchanged. */
  set(next: SetStateAction<string>): void;
  subscribe(listener: () => void): () => void;
}

export function createLiveReplyStore(): LiveReplyStore {
  let text = '';
  let published = '';
  let scheduled: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    scheduled = null;
    if (published === text) return;
    published = text;
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    if (scheduled) return;
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(publish);
      scheduled = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(publish, 16);
      scheduled = () => clearTimeout(timer);
    }
  };

  return {
    get: () => published,
    set(next) {
      text = typeof next === 'function' ? next(text) : next;
      if (text === '') {
        scheduled?.();
        publish();
        return;
      }
      schedule();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
