import { expect, test } from 'bun:test';
import { captureNativeSnapshotControls, takeSnapshot } from '../sdk/src/platform/browser/browser-snapshot.js';
import { captureBrowserControlSnapshot } from '../sdk/src/platform/browser/browser-control-snapshot-data.js';
import type { BrowserSnapshot } from '../sdk/src/platform/browser/browser-types.js';
import { withSecurityReadings } from './helpers/security-readings.ts';

function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
function page(options: { readonly title?: (() => Promise<string>) | undefined } = {}) {
  const frame = { async evaluate() { return [{ documentUrl: 'https://merchant.example/checkout', tag: 'button', role: 'button', name: 'Place order',
    selector: '#original-submit', value: 'entered-value-not-for-recovery', disabled: false, checked: null, depth: 2, submits: true }]; } };
  return { url: () => 'https://merchant.example/checkout', title: options.title ?? (async () => 'Private page title'),
    frames: () => [frame], mainFrame: () => frame,
  } as unknown as Parameters<typeof takeSnapshot>[0];
}

test('native immutable snapshots retain selected identity/metadata without entered values or extra model calls', async () => {
  await withSecurityReadings({}, async requests => {
    const snapshot = await takeSnapshot(page(), 'original-session', 'original-page');
    const retained = captureNativeSnapshotControls(snapshot, ['e1', 'e1']);
    expect(retained.controls).toHaveLength(1);
    expect(retained.controls[0]).toMatchObject({ ref: 'e1', selector: '#original-submit', submits: true,
      metadata: { name: 'Place order', documentUrl: snapshot.url } });
    expect(JSON.stringify(retained)).not.toContain('entered-value-not-for-recovery');
    expect(JSON.stringify(retained)).not.toContain('Private page title');
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.elements)).toBe(true);
    expect(Object.isFrozen(snapshot.elements[0])).toBe(true); expect(Object.isFrozen(snapshot.elements[0]?.frameChain)).toBe(true);
    expect(requests).toEqual([]);
  });
});

test('copied snapshots, parsed identity data and foreign ref numbers do not acquire native provenance', async () => {
  await withSecurityReadings({}, async () => {
    const snapshot = await takeSnapshot(page(), 'original-session', 'original-page');
    const retained = captureNativeSnapshotControls(snapshot, ['e1']);
    expect(() => captureNativeSnapshotControls(JSON.parse(JSON.stringify(snapshot)) as BrowserSnapshot, ['e1'])).toThrow('unavailable');
    expect(() => captureNativeSnapshotControls({ ...snapshot }, ['e1'])).toThrow('unavailable');
    expect(() => captureNativeSnapshotControls(snapshot, ['e2'])).toThrow('unavailable');
    const parsed = captureBrowserControlSnapshot(JSON.parse(JSON.stringify(retained)));
    expect(parsed).toEqual(retained);
    expect(() => captureNativeSnapshotControls(parsed as unknown as BrowserSnapshot, ['e1'])).toThrow('unavailable');
  });
});

test('stored control parsing rejects entered values and accessors without evaluating them', async () => {
  await withSecurityReadings({}, async () => {
    const snapshot = await takeSnapshot(page(), 'original-session', 'original-page');
    const retained = captureNativeSnapshotControls(snapshot, ['e1']), control = retained.controls[0];
    if (!control) throw new Error('Missing original control');
    expect(() => captureBrowserControlSnapshot({ ...retained, controls: [{ ...control, value: 'do-not-retain' }] })).toThrow('unavailable');
    let entered = false;
    expect(() => captureBrowserControlSnapshot({ ...retained, controls: [{ ...control, get selector() { entered = true; return '#replacement'; } }] })).toThrow();
    expect(entered).toBe(false);
  });
});

test('concurrent native snapshot reads keep their own allocated snapshot IDs', async () => {
  await withSecurityReadings({}, async () => {
    const firstEntered = barrier(), secondEntered = barrier(), release = barrier();
    const first = takeSnapshot(page({ title: async () => { firstEntered.release(); await release.wait; return 'First'; } }), 'session', 'page');
    const second = takeSnapshot(page({ title: async () => { secondEntered.release(); await release.wait; return 'Second'; } }), 'session', 'page');
    await Promise.all([firstEntered.wait, secondEntered.wait]); release.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(captureNativeSnapshotControls(a, ['e1']).snapshotId).toBe(a.snapshotId);
    expect(captureNativeSnapshotControls(b, ['e1']).snapshotId).toBe(b.snapshotId);
  });
});
