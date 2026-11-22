/**
 * The daemon-wide permission mode in force, in the daemon's own words.
 *
 * sessions.permissionMode.get for the `runtime` session answers for the mode
 * every web chat runs under (the saved `permissions.mode`), with `words`: the
 * reading permissions/decision-model-readiness.ts computes (ModeInForceWords).
 * The header chip and Settings > Permissions render those words and build none
 * of their own. Read once when shown, again on a `gate` frame (a mode change,
 * through useRealtimeInvalidation's `sessions` prefix) and when the decision
 * model's state changes (the policy header every response carries), never per
 * render or on a timer.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettableGatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import { browserDecisionPolicy } from './decision-policy';
import { client as platformClient } from './goodvibes';
import { queryKeys } from './queries';

/** The `words` of sessions.permissionMode.get: the wire form of ModeInForceWords. */
export interface ModeInForceWords {
  /** The chosen mode's label: "Jev decides". */
  readonly chosen: string;
  /** What is in force when it differs from the chosen mode: "you, for now". */
  readonly inForce?: string;
  /** The chosen mode and when it takes effect: "Jev decides with a decision model". */
  readonly chosenWhen?: string;
  /** The choice in a few words, where `chosenWhen` does not fit: "default: Jev decides". */
  readonly chosenShort?: string;
  /** Why it differs, a few words: "decision model unreachable". */
  readonly because?: string;
  /** True when `because` reports the decision model failing rather than a choice. */
  readonly failure?: boolean;
  /** What the mode in force does: the explanation behind the chip. */
  readonly sentence: string;
  /** What GoodVibes asks you before, in one sentence. */
  readonly asksBefore: string;
}

/** The session id the daemon answers for its own runtime, whose mode is the saved one. */
export const DAEMON_RUNTIME_SESSION = 'runtime';

export interface DaemonModeInForce {
  /** The mode the gate decides calls by. */
  readonly mode: string;
  /** The mode chosen in settings. */
  readonly chosenMode: string;
  readonly words?: ModeInForceWords;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read `words` off the answer; undefined from a daemon that does not send them. */
export function readModeInForceWords(value: unknown): ModeInForceWords | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const chosen = text(record.chosen), sentence = text(record.sentence), asksBefore = text(record.asksBefore);
  if (!chosen || !sentence || !asksBefore) return undefined;
  const inForce = text(record.inForce), chosenWhen = text(record.chosenWhen), chosenShort = text(record.chosenShort), because = text(record.because);
  return {
    chosen, sentence, asksBefore,
    ...(inForce ? { inForce } : {}), ...(chosenWhen ? { chosenWhen } : {}), ...(chosenShort ? { chosenShort } : {}),
    ...(because ? { because } : {}),
    ...(record.failure === true ? { failure: true } : {}),
  };
}

/**
 * The words in one line, in the order the terminal's status bar draws them
 * (the engine's modeInForceLine, which cannot load in the browser): the mode in
 * force first, the choice second, a failure last. "Jev decides" when the chosen
 * mode is in force; "you, for now · Jev decides with a decision model".
 */
export function modeInForceLine(words: ModeInForceWords): string {
  if (words.inForce === undefined) return words.chosen;
  return [words.inForce, words.chosenWhen ?? words.chosen, ...(words.failure === true && words.because ? [words.because] : [])].join(' · ');
}

function readAnswer(value: unknown): DaemonModeInForce {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const mode = text(record.mode) ?? '';
  const words = readModeInForceWords(record.words);
  return { mode, chosenMode: text(record.chosenMode) ?? mode, ...(words ? { words } : {}) };
}

/** The decision model's observed state, as a key that changes on failure, recovery or a policy change. */
function decisionStateKey(): string {
  const state = browserDecisionPolicy.snapshot();
  return state === undefined ? '' : `${state.policy}|${state.reason ?? ''}|${state.failure?.since ?? ''}`;
}

export function useDaemonModeInForce(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.sessionPermissionMode(DAEMON_RUNTIME_SESSION),
    queryFn: async () => readAnswer(await platformClient.operator.sessions.permissionMode.get(DAEMON_RUNTIME_SESSION)),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const decisionState = useSyncExternalStore(browserDecisionPolicy.subscribe, decisionStateKey, () => '');
  useEffect(() => {
    if (!enabled || decisionState === '') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessionPermissionMode(DAEMON_RUNTIME_SESSION) });
  }, [decisionState, enabled, queryClient]);
  return query;
}

/** Choose the daemon-wide mode (rewrites `permissions.mode`; a looser one may wait for the owner's approval). */
export function useSetDaemonMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: SettableGatePresetName) => platformClient.operator.sessions.permissionMode.set(DAEMON_RUNTIME_SESSION, mode),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessionPermissionMode(DAEMON_RUNTIME_SESSION) });
    },
  });
}
