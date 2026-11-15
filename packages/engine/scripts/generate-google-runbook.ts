/**
 * Regenerates docs/google-setup-runbook.md from the Google setup plan.
 *
 * The runbook is generated rather than hand-written so the written fallback
 * cannot drift from what the automation does. A test compares the checked-in
 * file against this output; run this after editing the plan.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGoogleSetupRunbook, RUNBOOK_RELATIVE_PATH } from '../platform/src/platform/google/setup-runbook.ts';

const engineRoot = join(import.meta.dir, '..');
writeFileSync(join(engineRoot, RUNBOOK_RELATIVE_PATH), renderGoogleSetupRunbook(), 'utf8');
console.log(`Wrote ${RUNBOOK_RELATIVE_PATH}`);
