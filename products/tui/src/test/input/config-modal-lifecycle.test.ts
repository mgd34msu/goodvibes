import { describe, expect, test } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';

function countingSurface(name = 'counting-modal'): { surface: ConfigModalSurface; events: string[] } {
  const events: string[] = [];
  const surface: ConfigModalSurface = {
    name,
    title: name,
    buildView: () => ({ title: name, tabs: [{ id: 'a', label: 'A', rows: [] }] }),
    onOpen: () => { events.push('open'); },
    onClose: () => { events.push('close'); },
  };
  return { surface, events };
}

describe('ConfigModal surface lifecycle', () => {
  test('opening the same surface again closes it before reopening it', () => {
    const modal = new ConfigModal();
    const { surface, events } = countingSurface();
    modal.open(surface);
    modal.open(surface);
    modal.close();
    expect(events).toEqual(['open', 'close', 'open', 'close']);
  });

  test('reopening after a nested modal does not subscribe a second time without releasing the first', () => {
    const modal = new ConfigModal();
    const { surface, events } = countingSurface();
    modal.open(surface);
    modal.reopen();
    modal.close();
    expect(events).toEqual(['open', 'close', 'open', 'close']);
  });

  test('every onOpen has exactly one onClose when switching surfaces', () => {
    const modal = new ConfigModal();
    const first = countingSurface('first-modal');
    const second = countingSurface('second-modal');
    modal.open(first.surface);
    modal.open(second.surface);
    modal.close();
    expect(first.events).toEqual(['open', 'close']);
    expect(second.events).toEqual(['open', 'close']);
  });
});
