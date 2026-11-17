import { JudgmentAuthorityRetiredError, type JudgmentAuthorityFrame } from '@goodvibes-jev/engine/errors';
import type { JudgmentSettingsSource } from './judgment-services.js';
import { captureJudgmentFallbackSettings } from '../config/judgment-fallback-settings.js';
import { captureJudgmentBackendSettings } from '@goodvibes-jev/judgment/decisions';

/**
 * The real composition owns this observation. Credential values are compared
 * only inside this closure; they never become cache identities or log facts.
 * Config/credential mutation intent invalidates before publication, including
 * ABA and failed/no-op mutation: the two change subscriptions abort the
 * lifetime's signal, and a capture's check reads that signal and nothing else.
 * A source with no observers is sampled once per capture instead, so a change
 * is still seen by the next capture.
 */
export function createJudgmentSourceLifetime(source: Pick<JudgmentSettingsSource, 'config' | 'env'> & {
  readonly secrets: Omit<JudgmentSettingsSource['secrets'], 'get'>;
}): {
  readonly capture: () => JudgmentAuthorityFrame;
  readonly dispose: () => void;
} {
  let identity = Object.freeze({});
  let controller = new AbortController();
  let previous: readonly unknown[] | undefined;
  let disposed = false;
  const invalidate = () => {
    const old = controller;
    identity = Object.freeze({}); controller = new AbortController(); previous = undefined;
    old.abort();
  };
  const configUnsubscribe = source.config.onDidChangeIncarnation?.(invalidate);
  const secretUnsubscribe = source.secrets.onDidInvalidateCredentials?.(invalidate);

  const sample = () => {
    if (disposed) throw new JudgmentAuthorityRetiredError();
    const configBefore = source.config.getConfigurationIncarnation?.();
    const secretBefore = source.secrets.getCredentialMutationState?.();
    const fallbacks = captureJudgmentFallbackSettings(source.config.get('judgment.fallbacks'));
    const keySource = source.config.get('judgment.keySource');
    const configuredKeyName = source.config.get('judgment.keyName');
    const keyName = typeof configuredKeyName === 'string' && configuredKeyName.trim() ? configuredKeyName.trim() : 'TYPESAFE_API_KEY';
    const secretNames = [...(keySource === 'secret' ? [keyName] : []),
      ...fallbacks.filter(target => target.keySource === 'secret').map(target => target.keyName)];
    const credentialObservations = secretNames.flatMap(name => {
      const snapshot = source.secrets.resolveLocalCredentialSnapshot?.(name);
      return snapshot?.state === 'resolved' ? [snapshot.state, snapshot.revision, snapshot.value]
        : snapshot?.state === 'absent' ? [snapshot.state, snapshot.revision] : [snapshot?.state];
    });
    const observation = [configBefore, secretBefore?.generation,
      source.config.get('judgment.policy'),
      source.config.get('judgment.endpoint'), keySource, keyName, source.env[keyName],
      source.config.get('judgment.model'), source.config.get('judgment.timeoutMs'),
      JSON.stringify(captureJudgmentBackendSettings(source.config.get('judgment.backend'))),
      JSON.stringify(fallbacks), ...fallbacks.map(target => source.env[target.keyName]), ...credentialObservations,
      source.env['TYPESAFE_BASE_URL'], source.env['TYPESAFE_DEFAULT_MODEL'], source.env['TYPESAFE_API_KEY']];
    const configAfter = source.config.getConfigurationIncarnation?.();
    const secretAfter = source.secrets.getCredentialMutationState?.();
    if (disposed || configBefore !== configAfter || secretBefore?.generation !== secretAfter?.generation
      || secretBefore?.pending || secretAfter?.pending) {
      invalidate(); throw new JudgmentAuthorityRetiredError();
    }
    if (previous && (previous.length !== observation.length || previous.some((value, index) => value !== observation[index]))) invalidate();
    previous = observation;
  };

  // With both observers every change (another process's settings or credential
  // write included, through the config file watch and the secret store watch)
  // aborts the signal, so a capture needs no re-reading; a source without them
  // is sampled once per capture.
  const observed = configUnsubscribe !== undefined && secretUnsubscribe !== undefined;
  return {
    capture() {
      if (disposed) throw new JudgmentAuthorityRetiredError();
      if (!observed) sample();
      else if (source.secrets.getCredentialMutationState?.().pending) throw new JudgmentAuthorityRetiredError();
      const captured = identity;
      const signal = controller.signal;
      return Object.freeze({ identity: captured, signal, assertCurrent() {
        if (disposed || signal.aborted || identity !== captured) throw new JudgmentAuthorityRetiredError();
      } });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      configUnsubscribe?.(); secretUnsubscribe?.();
      previous = undefined;
      controller.abort();
    },
  };
}
