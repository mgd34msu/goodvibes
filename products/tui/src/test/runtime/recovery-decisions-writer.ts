/**
 * Child process for recovery-decisions-housekeeping.test.ts: records `count`
 * removals named `<prefix>-<n>` into the ledger of the surface rooted at the
 * given directory, the way a second terminal sharing the same home would.
 */
import { recordRecoveryRemoval } from '../../runtime/recovery-decisions.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

const [dir, prefix, countText] = process.argv.slice(2);
if (!dir || !prefix || !countText) throw new Error('usage: recovery-decisions-writer <dir> <prefix> <count>');
const surface = makeTestSurface(dir);
for (let n = 0; n < Number(countText); n++) recordRecoveryRemoval(surface, `${prefix}-${n}`);
