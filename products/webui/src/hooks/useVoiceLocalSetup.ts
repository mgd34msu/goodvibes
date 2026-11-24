/**
 * useVoiceLocalSetup, the managed local-voice provisioning state and one-act install
 * (voice.local.status / voice.local.install, platform 1.9.0-dev's memory-relay-voice-
 * hardening work).
 *
 * No wire event exists for this domain (unlike power.*, which rides OPS_POWER_STATE_
 * CHANGED), VoiceSettings refetches manually / on install-mutation success, the same
 * standing gap fleet.*, checkpoints.*, and memory.* document in queries.ts.
 *
 * voice.local.install starts the run and answers at once ({ state: 'running',
 * startedAt, joined }); the run goes on in the daemon. The install mutation then polls
 * voice.local.status, writing each read into the status query so the card shows the
 * live `installInProgress` section, until the run has ended and its outcome is on the
 * read as `lastInstall`; it resolves with that receipt or fails with the recorded
 * reason. No request is held open for the download, so a long install is never
 * reported failed because the connection idled out. One poller: the status query
 * itself does not poll.
 *
 * A successful install also invalidates useVoice.ts's ['voice','status'] and the one
 * shared config entry (queryKeys.config), since the install call may newly configure
 * tts.provider/tts.voice (or make the 'local' provider's capabilities non-empty), and
 * both surfaces need to see that immediately, not on their next unrelated refetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../lib/goodvibes';
import { NO_EVENT_LIST_FRESHNESS, queryKeys } from '../lib/queries';
import { formatError } from '../lib/errors';
import {
  readVoiceLocalInstallResult,
  readVoiceLocalInstallStart,
  readVoiceLocalStatus,
  type VoiceLocalInstallResult,
  type VoiceLocalStatusSnapshot,
} from '../lib/voice/voice-local-setup';

/** How often a running install's status is read. */
const INSTALL_POLL_MS = 750;
/** Reads in a row that fail, or that show the run neither running nor finished, before the surface says so. */
const INSTALL_POLL_PATIENCE = 5;

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function useVoiceLocalStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.voiceLocalStatus,
    queryFn: async () => {
      const raw = await platformClient.operator.voice.local.status();
      // Defensive wire parse: a 200 whose body carries no runtime state is an honest,
      // retriable error, never a crash or an 'undefined' label (see voice-local-setup.ts).
      const status = readVoiceLocalStatus(raw);
      if (!status) {
        throw new Error('The daemon answered, but its response did not carry a local-voice runtime state.');
      }
      return status;
    },
    enabled,
    staleTime: 30_000,
    retry: false,
    ...NO_EVENT_LIST_FRESHNESS,
  });
}

export function useVoiceLocalInstall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<VoiceLocalInstallResult> => {
      const raw = await platformClient.operator.voice.local.install();
      // A daemon that still runs the install inside the request answers with the receipt.
      const receipt = readVoiceLocalInstallResult(raw);
      if (receipt) return receipt;
      const start = readVoiceLocalInstallStart(raw);
      if (!start) throw new Error('The daemon answered, but its response named no install run.');
      let failures = 0;
      let unreported = 0;
      for (;;) {
        await pause(INSTALL_POLL_MS);
        let status: VoiceLocalStatusSnapshot | null = null;
        let readError: unknown = null;
        try {
          status = readVoiceLocalStatus(await platformClient.operator.voice.local.status());
        } catch (error) {
          readError = error;
        }
        if (!status) {
          if (++failures < INSTALL_POLL_PATIENCE) continue;
          throw new Error(
            `Could not read the install's progress (${readError ? formatError(readError) : 'the status answer carried no runtime state'}). `
            + 'It may still be running in the daemon; reopen voice settings to see what is installed.',
          );
        }
        failures = 0;
        queryClient.setQueryData(queryKeys.voiceLocalStatus, status);
        if (status.installInProgress) { unreported = 0; continue; }
        const outcome = status.lastInstall;
        if (!outcome || outcome.startedAt < start.startedAt) {
          if (++unreported < INSTALL_POLL_PATIENCE) continue;
          throw new Error(
            'The daemon no longer reports this install as running or finished (it may have restarted while installing). '
            + 'The card shows what is installed; install again to finish any missing part.',
          );
        }
        if (outcome.receipt) return outcome.receipt;
        throw new Error(`The install failed: ${outcome.error ?? 'the daemon recorded no reason'}. Install again to retry any failed part.`);
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.voiceLocalStatus }),
        queryClient.invalidateQueries({ queryKey: ['voice', 'status'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.config }),
      ]);
    },
  });
}
