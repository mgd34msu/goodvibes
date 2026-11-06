import { readFileSync } from 'node:fs';
import type { DecisionLog } from '@goodvibes-jev/judgment';
import { captureJudgmentVolumeMonitorSettings, startJudgmentVolumeMonitor } from '../observe/judgment-volume-monitor.js';
import { logger } from '../utils/logger.js';
import type { DisposalRegistry } from './disposal.js';

/** Enable local recurring alerts with an explicit budget file, independently per runtime. */
export function composeJudgmentVolumeMonitor(
  log: Pick<DecisionLog, 'query'>,
  env: Readonly<Record<string, string | undefined>>,
  disposal: DisposalRegistry,
): void {
  const file = env['GOODVIBES_JUDGMENT_MONITOR']?.trim();
  if (!file) return;
  try {
    const settings = captureJudgmentVolumeMonitorSettings(JSON.parse(readFileSync(file, 'utf8')));
    const monitor = startJudgmentVolumeMonitor({
      log,
      settings,
      notify: (alert) => {
        if (alert.kind === 'recovered') logger.info('Judgment call volume is back within the configured budget.');
        else logger.warn('Judgment call-volume monitor requires attention.', { monitor: alert });
      },
    });
    // Registered after the port/log owner: stop the timer before closing the log.
    disposal.add('judgment call-volume monitor', monitor.dispose);
    monitor.check();
  } catch {
    // Never print file contents, paths, or configuration values in this failure.
    logger.warn('Judgment call-volume monitoring could not start; check GOODVIBES_JUDGMENT_MONITOR and its budget configuration.');
  }
}
