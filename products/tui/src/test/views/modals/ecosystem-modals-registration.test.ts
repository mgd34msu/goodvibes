import { describe, test, expect } from 'bun:test';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { planningModalGoldenSurface } from '../../helpers/planning-modal-fixture.ts';
import { hooksModalGoldenSurface, keybindingsModalGoldenSurface, knowledgeModalGoldenSurface, marketplaceModalGoldenSurface, memoryModalGoldenSurface, pairingModalGoldenSurface, pluginsModalGoldenSurface, policyModalGoldenSurface, securityModalGoldenSurface, skillsModalGoldenSurface, workPlanModalGoldenSurface } from '../../helpers/modal-golden-surfaces.ts';

// ---------------------------------------------------------------------------
// Config-modal-surface registration completeness.
// The 12 ConfigModalSurfaces must all exist under their '-modal' names
// with the required host contract. The view→modal redirects (including the
// 'sessions' -> 'sessionPicker' fold) are asserted end-to-end against a live
// modal host in src/test/release-gates/operator-surfaces-gate.test.ts.
// ---------------------------------------------------------------------------

/** The 12 ecosystem surfaces, by their canonical registered name. */
const EXPECTED_SURFACE_NAMES = [
  'marketplace-modal', 'plugins-modal', 'skills-modal', 'hooks-modal',
  'security-modal', 'policy-modal', 'knowledge-modal', 'memory-modal',
  'work-plan-modal', 'keybindings-modal', 'pairing-modal', 'planning-modal',
];

async function allSurfaces(): Promise<ConfigModalSurface[]> {
  return [
    marketplaceModalGoldenSurface(),
    pluginsModalGoldenSurface(),
    skillsModalGoldenSurface(),
    hooksModalGoldenSurface(),
    securityModalGoldenSurface(),
    policyModalGoldenSurface(),
    knowledgeModalGoldenSurface(),
    await memoryModalGoldenSurface(),
    workPlanModalGoldenSurface(),
    keybindingsModalGoldenSurface(),
    pairingModalGoldenSurface(),
    await planningModalGoldenSurface(),
  ];
}

describe('group-B config-modal surface registration', () => {
  test('all 12 surfaces exist under their canonical -modal names', async () => {
    const surfaces = await allSurfaces();
    expect(surfaces.map((s) => s.name)).toEqual(EXPECTED_SURFACE_NAMES);
  });

  test('row ids are unique within each tab (the host keys its live overlay off them)', async () => {
    for (const surface of await allSurfaces()) {
      for (const tab of surface.buildView().tabs) {
        const ids = tab.rows.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});
