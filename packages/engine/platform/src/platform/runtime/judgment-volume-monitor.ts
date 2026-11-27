import { readFileSync } from 'node:fs';
import { captureJudgmentVolumeMonitorControl, captureJudgmentVolumeMonitorSettings, startJudgmentVolumeMonitor, type JudgmentVolumeAlert, type JudgmentVolumeMonitorSettings, type JudgmentVolumeLog } from '../observe/judgment-volume-monitor.js';
import { logger } from '../utils/logger.js';
import { outsideEveryCall } from '../utils/outside-every-call.js';
import type { DisposalRegistry } from './disposal.js';

interface VolumeSettingsSource {
  get(key: 'judgment.volumeMonitor'): unknown;
  subscribe?(key: 'judgment.volumeMonitor', listener: () => void): () => void;
  onDidChangeIncarnation?(listener: () => void): () => void;
}

/** Read side of the composed monitor, for a status surface. */
export interface JudgmentVolumeMonitorHandle {
  /** The most recent alert state change (budget breach, unreadable log, recovery); undefined until one happens or when monitoring is off. */
  lastAlert(): JudgmentVolumeAlert | undefined;
}

/** Product settings own local recurring alerts; the explicit budget-file
 * override remains available when product monitoring is disabled. Neither
 * configuration path invokes a model or changes execution authority. */
export function composeJudgmentVolumeMonitor(
  log: JudgmentVolumeLog,
  env: Readonly<Record<string, string | undefined>>,
  disposal: DisposalRegistry,
  config?: VolumeSettingsSource,
): JudgmentVolumeMonitorHandle {
  const file = env['GOODVIBES_JUDGMENT_MONITOR']?.trim();
  let monitor: ReturnType<typeof startJudgmentVolumeMonitor> | undefined;
  let signature: string | undefined, disposed = false;
  let unsubscribe = () => {};
  disposal.add('judgment call-volume monitor', () => {
    disposed = true;
    try { unsubscribe(); }
    finally { monitor?.dispose(); monitor = undefined; }
  });
  const handle: JudgmentVolumeMonitorHandle = { lastAlert: () => monitor?.lastAlert() };
  if (disposed) return handle;
  const reload = () => {
    if (disposed) return;
    try {
      const control = captureJudgmentVolumeMonitorControl(config?.get('judgment.volumeMonitor'));
      const settings: JudgmentVolumeMonitorSettings | undefined = control.enabled
        ? { budgets: control.budgets, intervalMs: control.intervalMs, windowMs: control.windowMs, limit: control.limit }
        : file ? captureJudgmentVolumeMonitorSettings(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
      if (disposed) return;
      const next = JSON.stringify(settings) ?? 'disabled';
      if (next === signature) return;
      monitor?.dispose(); monitor = undefined; signature = next;
      if (!settings) return;
      const selected = startJudgmentVolumeMonitor({ log, settings, notify: alert => {
        if (disposed) return;
        if (alert.kind === 'recovered') logger.info('Judgment call volume is back within the configured budget.');
        else logger.warn('Judgment call-volume monitor requires attention.', { monitor: alert });
      } });
      monitor = selected;
      selected.check();
    } catch {
      monitor?.dispose(); monitor = undefined; signature = undefined;
      // Never print a budget file, its path or borrowed configuration values.
      if (!disposed) logger.warn('Judgment call-volume monitoring could not start; check Judgment settings or GOODVIBES_JUDGMENT_MONITOR and its budget configuration.');
    }
  };
  // Native incarnation notifications precede mutation. Prefer the actual
  // post-publication setting subscription, so the just-saved value is visible.
  // Older structural hosts exposing only incarnation callbacks re-read after
  // the synchronous mutation finishes; disposal fences that queued callback.
  let queued = false;
  const queueReload = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; reload(); });
  };
  // A settings change is made by a request: the monitor it re-arms runs with no caller's context (utils/outside-every-call.ts).
  const release = config?.subscribe
    ? config.subscribe('judgment.volumeMonitor', () => outsideEveryCall(reload))
    : config?.onDidChangeIncarnation?.(() => outsideEveryCall(queueReload));
  if (release) { if (disposed) release(); else unsubscribe = release; }
  reload();
  return handle;
}
