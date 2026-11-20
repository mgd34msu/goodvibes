/** Bind each connection attempt to the actual configured account and credential generation. */
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { assertImapReadingCurrent, ImapReadingError } from '../imap-readings.js';
import { readSurfaceEmailSettings } from '../surface-config.js';
import type { InboundMailSourceFactoryDeps } from './source-factory.js';

export function beginImapSourceReading(deps: InboundMailSourceFactoryDeps, owner: JudgmentReadingOptions): {
  readonly reading: JudgmentReadingOptions;
  dispose(): void;
} {
  const retired = new AbortController();
  const invalidate = () => retired.abort();
  let projection = '';
  const readProjection = (): string => JSON.stringify([
    readSurfaceEmailSettings(deps.getConfig),
    deps.getConfig('surfaces.email.inbound.onInsufficientCapability'),
  ]);
  // Every config write announces a new incarnation, including writes to keys
  // that have nothing to do with mail, and it announces it BEFORE the value is
  // applied. So the comparison waits a microtask, and only a change to what
  // this source actually reads retires it; anything else used to cost a full
  // teardown and a fresh IMAP login per settings save.
  const configOff = deps.onDidChangeConfiguration?.(() => {
    queueMicrotask(() => { if (!retired.signal.aborted && readProjection() !== projection) retired.abort(); });
  });
  const secretsOff = deps.secrets.onDidInvalidateCredentials?.(invalidate);
  const dispose = () => { configOff?.(); secretsOff?.(); retired.abort(); };
  try {
    projection = readProjection();
    const credentials = deps.secrets.getCredentialMutationState?.();
    const signal = AbortSignal.any([retired.signal, ...(owner.signal ? [owner.signal] : [])]);
    const reading = { signal, assertCurrent: () => {
      assertImapReadingCurrent(owner);
      const currentCredentials = deps.secrets.getCredentialMutationState?.();
      if (signal.aborted
        || credentials?.pending || currentCredentials?.pending
        || credentials?.generation !== currentCredentials?.generation
        || projection !== readProjection()) {
        retired.abort();
        throw new ImapReadingError();
      }
    } };
    assertImapReadingCurrent(reading);
    return { reading, dispose };
  } catch { dispose(); throw new ImapReadingError(); }
}
