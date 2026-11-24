/**
 * "Read 2 min ago · Refresh": when a list the daemon sends no live event for
 * was last read, and the button that reads it again. Used on the views whose
 * freshness comes from reading again, not from a live event (memory, who is
 * who, checkpoints, CI watches, check-ins), so a stale list never looks live.
 * The words are worked out when the view draws; no timer of its own.
 */
import { agoWords } from '@goodvibes/engine/contracts';
import { Button } from '../ui/Button';

export function ReadAt({ at, onRefresh, refreshing = false }: { at: number; onRefresh: () => void; refreshing?: boolean }) {
  if (!at) return null;
  return (
    <span className="dv-read-at">
      Read {agoWords(at, Math.max(Date.now(), at))}
      {' · '}
      <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Reading…' : 'Refresh'}</Button>
    </span>
  );
}
