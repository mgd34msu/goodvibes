/**
 * Preload for j14's update-hold step, never loaded by the product: SIGUSR2
 * closes the daemon's one work admission, as the self-update does before it
 * asks the service manager for the handover (a check a journey cannot run).
 * The instance is the one the daemon's composition subscribes to with
 * onReopen; the module is the same one the daemon loads from source, so the
 * patch on its prototype reaches it without a seam in product code.
 */
import { DaemonWorkAdmission } from '../../platform/src/platform/daemon/work-admission.ts';

const instances = new Set<DaemonWorkAdmission>();
const original = DaemonWorkAdmission.prototype.onReopen;
DaemonWorkAdmission.prototype.onReopen = function (this: DaemonWorkAdmission, listener: () => void) {
  instances.add(this);
  return original.call(this, listener);
};
process.on('SIGUSR2', () => {
  for (const admission of instances) admission.close('it is installing an update and will restart into it');
  process.stdout.write(`[runthrough hold] admission closed on ${instances.size} instance(s)\n`);
});
