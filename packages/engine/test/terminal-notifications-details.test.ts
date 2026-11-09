/** Shared terminal regression source; execution deferred during coding. */
import { expect, test } from 'bun:test';
import { NotificationFeed } from '../sdk/src/platform/runtime/notifications/feed.ts';
import { NotificationsModal } from '../terminal-shell/src/notifications-modal.ts';
import { SurfaceModalHost } from '../terminal-shell/src/surface-modal-host.ts';

function fixture() {
  const feed = new NotificationFeed(), host = new SurfaceModalHost();
  for (const [index, title] of ['First notice', 'Second notice', 'Third notice'].entries()) {
    feed.record({ id: `notice-${index}`, title, domain: 'tools', level: 'info', timestamp: index + 1,
      body: Array.from({ length: 35 }, (_, row) => `${title} detail-${row}`).join('\n') },
    { target: 'panel_only', reasonCode: 'allowed' });
  }
  const modal = new NotificationsModal({ feed, resolveSubject: () => null, now: () => 10 });
  host.push(modal); modal.selectedIndex = 1;
  const frame = (width: number, height: number) => modal.render(width, height).lines.map(line => line.map(cell => cell.char).join(''));
  const press = (key: string) => modal.handleToken({ type: 'key', name: key, logicalName: key, ctrl: false, shift: false, meta: false }, host);
  return { feed, host, modal, frame, press };
}

for (const [width, height] of [[80, 24], [120, 40]] as const) {
  test(`notification details stay above the complete uninterrupted list at ${width}x${height}`, () => {
    const f = fixture();
    try {
      const lines = f.frame(width, height);
      const titleRows = ['Third notice', 'Second notice', 'First notice'].map(title => lines.findIndex(line => line.includes(title) && !line.includes('detail-')));
      expect(titleRows.every(row => row >= 0)).toBe(true);
      expect(titleRows[1]).toBe(titleRows[0]! + 1); expect(titleRows[2]).toBe(titleRows[1]! + 1);
      const detailRows = lines.flatMap((line, row) => line.includes('detail-') ? [row] : []);
      expect(detailRows.length).toBeGreaterThan(0);
      expect(detailRows.every(row => row < titleRows[0]!)).toBe(true);
      expect(lines.some(line => line.includes('Third notice detail-') || line.includes('First notice detail-'))).toBe(false);
      f.press('pagedown');
      const scrolled = f.frame(width, height);
      expect(f.modal.selectedIndex).toBe(1); expect(f.modal.contextScroll).toBeGreaterThan(0);
      expect(scrolled.some(line => line.includes('Second notice detail-8'))).toBe(true);
      expect(scrolled.findIndex(line => line.includes('Third notice') && !line.includes('detail-'))).toBe(titleRows[0]!);
      f.press('down'); expect(f.modal.contextScroll).toBe(0);
      expect(f.frame(width, height).some(line => line.includes('First notice detail-0'))).toBe(true);
    } finally { f.host.close(f.modal); }
  });
}

test('notification details paging clamps back from the end and selection changes reset it', () => {
  const f = fixture();
  try {
    for (let page = 0; page < 20; page++) { f.press('pagedown'); f.frame(80, 24); }
    const last = f.modal.contextScroll; expect(last).toBeGreaterThan(0);
    f.press('pageup'); f.frame(80, 24); expect(f.modal.contextScroll).toBeLessThan(last);
    f.press('home'); expect(f.modal.selectedIndex).toBe(0); expect(f.modal.contextScroll).toBe(0);
  } finally { f.host.close(f.modal); }
});
