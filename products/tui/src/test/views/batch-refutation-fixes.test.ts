/**
 * Regression tests for three review findings: (2) MODAL_TONES dark-pinned
 * across theme flips, (3) config-modal async onOpen loads frozen at
 * "Loading…" until a keypress, (4) queued-steer badge rendered for a node with
 * a stop in flight.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import type { ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import { MODAL_TONES } from '../../views/modals/modal-theme.ts';
import { setActiveThemeMode, resolveUiTones } from '../../renderer/theme.ts';
import type { ProcessNode } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';
import { renderFleetRowLine } from '../../views/fleet-format.ts';
import { steerBadgeGlyph } from '../../views/fleet-steer.ts';
import type { FleetTreeRow } from '../../views/fleet-read-model.ts';

afterEach(() => {
  setActiveThemeMode('dark');
});

describe('finding 2: MODAL_TONES follows theme flips in place', () => {
  test('light flip rebuilds tones; dark restore returns originals', () => {
    const darkInfo = MODAL_TONES.info;
    expect(darkInfo).toBe(resolveUiTones('dark').state.info);

    setActiveThemeMode('light');
    expect(MODAL_TONES.info).toBe(resolveUiTones('light').state.info);
    expect(MODAL_TONES.primary).toBe(resolveUiTones('light').fg.primary);

    setActiveThemeMode('dark');
    expect(MODAL_TONES.info).toBe(darkInfo);
  });
});

describe('finding 3: async onOpen loads paint before the first interaction', () => {
  function makeAsyncSurface(): { surface: ConfigModalSurface; finishLoad: () => void } {
    let loaded = false;
    const view = (): ConfigModalView => ({
      title: 'T',
      tabs: [{
        id: 'main', label: 'Main',
        rows: loaded
          ? [{ id: 'r1', label: 'row one', selectable: true }, { id: 'r2', label: 'row two', selectable: true }]
          : [{ id: 'loading', label: 'Loading…', selectable: false }],
      }],
    });
    return {
      surface: { name: 'async-test-modal', title: 'T', buildView: view },
      finishLoad: () => { loaded = true; },
    };
  }

  test('pre-interaction render syncs structure (no keypress needed)', () => {
    const { surface, finishLoad } = makeAsyncSurface();
    const modal = new ConfigModal();
    modal.open(surface);
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['loading']);

    finishLoad(); // the async load's requestRender path re-renders:
    const ids = modal.getRenderModel().rows.map((r) => r.id);
    expect(ids).toEqual(['r1', 'r2']);
  });

  test('after the first interaction, structure freezes to boundaries again', () => {
    const { surface, finishLoad } = makeAsyncSurface();
    const modal = new ConfigModal();
    modal.open(surface);
    finishLoad();
    modal.getRenderModel(); // paints loaded content pre-interaction
    modal.noteInteraction();
    modal.syncStructure();

    // A post-interaction structural change must WAIT for the next boundary.
    // mutate: swap the surface's view fn output by re-using finishLoad-style state
    // (rows already loaded; simulate a structural append via a wrapped surface)
    const base = surface.buildView;
    let appended = false;
    (surface as { buildView: () => ConfigModalView }).buildView = () => {
      const v = base();
      if (!appended) return v;
      const [firstTab, ...restTabs] = v.tabs;
      return {
        ...v,
        tabs: [
          { ...firstTab!, rows: [...firstTab!.rows, { id: 'r3', label: 'row three', selectable: true }] },
          ...restTabs,
        ],
      };
    };
    appended = true;
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    modal.moveDown(); // interaction boundary
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('finding 4: a queued-steer badge never shows on a node with a stop in flight', () => {
  const node: ProcessNode = {
    id: 'agent-1', kind: 'agent', label: 'agent-1', state: 'executing-tool', elapsedMs: 1_000, costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
  };
  const row: FleetTreeRow = { node, depth: 0, treePrefix: '', isLastChild: true, hasChildren: false };
  const badge = { messageId: 'm1', status: 'queued', queuedAt: 1 } as const;
  const text = (stopping: boolean, withBadge: boolean): string =>
    renderFleetRowLine(row, 200, stopping, false, withBadge ? badge : null).map((cell) => cell.char ?? ' ').join('');

  test('the badge shows while nothing is stopping, and the stopping marker replaces it when a stop is in flight', () => {
    expect(text(false, true)).toContain(steerBadgeGlyph('queued'));
    const stopping = text(true, true);
    expect(stopping).toContain('stopping');
    expect(stopping).not.toContain(steerBadgeGlyph('queued'));
  });
});
