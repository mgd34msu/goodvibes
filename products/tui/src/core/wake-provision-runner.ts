// ---------------------------------------------------------------------------
// wake-provision-runner.ts, what `/voice wake-status` prints.
//
// The installer and the npm postinstall provision the wake model, and a daemon
// retries at boot whatever the install could not fetch (the platform's
// voice/wake/install-provision.ts owns that policy). `/voice wake-setup` and
// turning `voice.wake.enabled` on go through the platform's voice setup
// (core/wake-setup-plan.ts), which fetches missing models as one of its steps.
//
// `/voice wake-status` only reads what is on disk, verifying by content, never
// by existence. The read is injectable so a wire test drives it with no files.
// ---------------------------------------------------------------------------

import {
  wakeProvisionStatus,
  type WakeProvisionStatus,
  type WakeRuntimeSettings,
} from '@goodvibes-jev/engine/platform/platform/voice';
import { wakeStatusLines } from './wake-provision-status.ts';

export interface WakeProvisionRunnerDeps {
  /** Managed root the wake tree hangs off; `<managedRoot>/wake` holds the artifacts. */
  readonly managedRoot: string;
  /** Already-resolved `voice.wake.*` rows, so the status block reports the live posture. */
  readonly settings: WakeRuntimeSettings;
  readonly print: (block: string) => void;
  /** Injected in tests; defaults to the platform's content-verifying read. */
  readonly readStatus?: (managedRoot: string) => WakeProvisionStatus;
}

/** Print the honest on-disk + configured posture. Reads only; never downloads. */
export function printWakeStatus(deps: WakeProvisionRunnerDeps): void {
  const read = deps.readStatus ?? ((managedRoot: string) => wakeProvisionStatus({ managedRoot }));
  deps.print(['Wake-Word Detection', ...wakeStatusLines(read(deps.managedRoot), deps.settings)].join('\n'));
}
