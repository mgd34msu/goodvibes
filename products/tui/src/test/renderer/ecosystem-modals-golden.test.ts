// ---------------------------------------------------------------------------
// ecosystem-modals-golden.test.ts, golden frames for the group-B
// (ecosystem & governance) modal surfaces, RE-BASELINED through the canonical
// config-modal host (group-B port).
//
// Each surface is opened in a real ConfigModal and rendered via
// renderConfigModal on the modal surface kit (the exact production render
// path); the layer is composed over a blank dimmed screen with frameFromLayer,
// as the compositor stamps it. Each surface gets a normal (100 wide) and
// hostile (28 wide) pair.
//
// Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <this file>.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { assertGoldenIn } from '../helpers/golden-snapshot.ts';
import { hooksModalGoldenSurface, keybindingsModalGoldenSurface, knowledgeModalGoldenSurface, marketplaceModalGoldenSurface, memoryModalGoldenSurface, pairingModalGoldenSurface, pluginsModalGoldenSurface, policyModalGoldenSurface, securityModalGoldenSurface, skillsModalGoldenSurface, workPlanModalGoldenSurface } from '../helpers/modal-golden-surfaces.ts';

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;
const HEIGHT = 40;

function assertGolden(surface: string, lines: Line[]): void {
  assertGoldenIn(GOLDENS_DIR, surface, lines);
}

/**
 * Open a surface in the real host and render it, the production render path.
 *
 * Note (c) harness fix: ConfigModal.open() freezes the tab structure from
 * buildView() BEFORE surface.onOpen()'s refresh() loads its rows, and
 * getRenderModel() only overlays live values onto the FROZEN row ids, so a
 * naive render immediately after open() locks the pre-refresh chrome (empty
 * rows), not real content. We flush a macrotask turn (settles chained async
 * onOpen; the Promise-backed surfaces also pre-await inside their factory)
 * then syncStructure() to re-freeze from the post-refresh buildView(), so the
 * committed golden locks content, not chrome.
 */
async function renderSurface(surface: ConfigModalSurface, width: number): Promise<Line[]> {
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  modal.syncStructure();
  const lines = frameFromLayer(renderConfigModal(modal, width, HEIGHT), width, HEIGHT);
  modal.close();
  return lines;
}

interface GoldenModalEntry {
  readonly name: string;
  readonly factory: () => ConfigModalSurface | Promise<ConfigModalSurface>;
}

const GOLDEN_MODALS: readonly GoldenModalEntry[] = [
  // marketplace: locks the honest empty-state copy byte-for-byte INSIDE the host render.
  { name: 'marketplace-modal', factory: marketplaceModalGoldenSurface },
  { name: 'plugins-modal', factory: pluginsModalGoldenSurface },
  { name: 'skills-modal', factory: skillsModalGoldenSurface },
  { name: 'hooks-modal', factory: hooksModalGoldenSurface },
  { name: 'security-modal', factory: securityModalGoldenSurface },
  { name: 'policy-modal', factory: policyModalGoldenSurface },
  { name: 'knowledge-modal', factory: knowledgeModalGoldenSurface },
  { name: 'memory-modal', factory: memoryModalGoldenSurface },
  { name: 'work-plan-modal', factory: workPlanModalGoldenSurface },
  { name: 'keybindings-modal', factory: keybindingsModalGoldenSurface },
  { name: 'pairing-modal', factory: pairingModalGoldenSurface },
  // The planning modal's golden lives in planning-modal-golden.test.ts, which pins it once.
];

const SIZES = [
  { label: 'normal', width: 100 },
  { label: 'hostile', width: 28 },
] as const;

for (const entry of GOLDEN_MODALS) {
  describe(`group-B modal golden (host-rendered): ${entry.name}`, () => {
    for (const size of SIZES) {
      const surfaceName = `${entry.name}-${size.label}`;
      test(`${size.label} width matches committed golden`, async () => {
        const lines = await renderSurface(await entry.factory(), size.width);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surfaceName, lines);
      });
    }
  });
}
