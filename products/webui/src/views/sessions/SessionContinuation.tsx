/** Authoritative session classification shared by conversation and Fleet text actions. */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { NativeHostedSessionLookup } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import { inspectNativeSession } from '../../lib/native-session';
import { formatError } from '../../lib/errors';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../../lib/client-lifetime';
import { NativeIntakeForm } from '../work/NativeIntakeForm';
import { Button } from '../../components/ui/Button';
import { Field, Textarea } from '../../components/ui/Field';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/steer-composer.css';

export interface NativeSessionContinuationBinding {
  sessionId: string;
  projectId: string;
  lifetime: ClientLifetime;
  /** Text typed while the session was being classified. */
  draft: string;
}

interface SessionContinuationProps {
  sessionId: string;
  closed?: boolean;
  streamPaused?: boolean;
  /** Mounted only after the host explicitly classifies this session as legacy. */
  children: ReactNode;
  /** A source-aware surface can share classification without flattening its context into text. */
  renderNative?: (binding: NativeSessionContinuationBinding) => ReactNode;
  renderPending?: (content: ReactNode) => ReactNode;
}

const ContinuationDraft = createContext('');
/** Text typed before the session's composer was chosen; a composer seeds its box with it. */
export function useContinuationDraft(): string {
  return useContext(ContinuationDraft);
}

export function SessionContinuation(props: SessionContinuationProps) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  return <ScopedSessionContinuation key={`${lifetime.revision}:${props.sessionId}`} {...props} lifetime={lifetime} />;
}

function ScopedSessionContinuation(props: SessionContinuationProps & { lifetime: ClientLifetime }) {
  const { sessionId, lifetime, closed, streamPaused } = props;
  const [discovery, setDiscovery] = useState<NativeHostedSessionLookup>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => {
      controller.abort();
      if (!disposed && isClientLifetimeCurrent(lifetime)) setError('The daemon did not answer within 15 seconds.');
    }, 15_000);
    // Runs behind the composer: the box is already on screen while this answers.
    void inspectNativeSession(lifetime, sessionId, controller.signal).then(
      (found) => {
        if (!disposed && isClientLifetimeCurrent(lifetime)) setDiscovery(found);
      },
      (cause: unknown) => {
        if (!disposed && isClientLifetimeCurrent(lifetime))
          setError(controller.signal.aborted ? 'The daemon did not answer within 15 seconds.' : formatError(cause));
      }
    ).finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [lifetime, sessionId, attempt]);

  if (discovery?.kind === 'legacy')
    return <ContinuationDraft.Provider value={draft}>{props.children}</ContinuationDraft.Provider>;
  if (discovery?.kind === 'native' && props.renderNative)
    return props.renderNative({ sessionId, projectId: discovery.projectId, lifetime, draft });
  if (discovery?.kind === 'native') return (
    <div className="steer-composer">
      {discovery.busy && (
        <p className="steer-composer__mode"><StatusDot tone="live" />
          The session is replying. A new message goes after the reply in progress.
        </p>
      )}
      {streamPaused && <p role="status">Live updates are paused. A sent message's status still refreshes by itself.</p>}
      <NativeIntakeForm lifetime={lifetime} continuationSessionId={sessionId} projectId={discovery.projectId} closed={closed} initialText={draft} />
    </div>
  );
  // The box is drawn at once; Send waits until the daemon says how this session takes messages.
  const pending = (
    <div className="steer-composer">
      <Field label="Message">
        <Textarea rows={3} value={draft} disabled={closed} onChange={(event) => setDraft(event.target.value)} />
      </Field>
      {error ? <>
        <p role="alert">Cannot send to this session yet: {error} Nothing was sent; your text is kept.</p>
        <Button onClick={() => { setError(undefined); setAttempt((value) => value + 1); }}>Try again</Button>
      </> : <p role="status" className="dv-muted">Connecting to the session…</p>}
      <Button variant="primary" disabled>Send</Button>
    </div>
  );
  return props.renderPending ? props.renderPending(pending) : pending;
}
