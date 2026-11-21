/**
 * StepUpHost, the inline WebAuthn step-up ceremony, run at the point a mutating relay call
 * demands it.
 *
 * The transport layer (routedFetch) does not open modals; when a mutating relay call comes
 * back `401 STEP_UP_REQUIRED`, it calls the prompter this component registers. The prompter
 * opens a modal, runs the passkey ceremony (mint a server challenge, navigator.credentials.get,
 * encode the assertion header), and resolves the header value the transport then retries with.
 * Cancelling, or any ceremony failure, resolves null, so the original 401 surfaces honestly
 * rather than the call hanging or silently skipping verification.
 *
 * The transport opens this only when the daemon has a passkey that could sign (a daemon with
 * none answers `register-locally`, and that refusal surfaces with its own next step). The
 * ceremony asks the daemon which passkeys it lists and offers only those on this device.
 *
 * One ceremony runs at a time: a second requirement arriving while one is open waits its turn
 * and opens when the first settles, rather than stacking a second modal or failing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { client as platformClient } from '../../lib/goodvibes';
import {
  describeStepUpError,
  runAssertion,
  stepUpAvailability,
  StepUpError,
} from '../../lib/stepup';
import { registerStepUpPrompter, type StepUpContext, type StepUpPrompter } from '../../lib/stepup-prompter';

interface StepUpRequest {
  readonly context: StepUpContext;
  readonly resolve: (value: string | null) => void;
  readonly releaseAbort: () => void;
}

interface StepUpVerification {
  readonly request: StepUpRequest;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export function StepUpHost() {
  const requestRef = useRef<StepUpRequest | null>(null);
  // Requirements that arrived while a ceremony was open, oldest first.
  const queueRef = useRef<StepUpRequest[]>([]);
  const verificationRef = useRef<StepUpVerification | null>(null);
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((next: StepUpRequest) => {
    requestRef.current = next;
    setRequest(next);
    setRunning(false);
    setError(null);
  }, []);

  const settle = useCallback((ownedRequest: StepUpRequest, value: string | null) => {
    const queued = queueRef.current.indexOf(ownedRequest);
    if (queued >= 0) {
      // A waiting requirement whose caller gave up leaves the queue without ever opening.
      queueRef.current.splice(queued, 1);
      ownedRequest.releaseAbort();
      ownedRequest.resolve(value);
      return;
    }
    if (requestRef.current !== ownedRequest) return;
    requestRef.current = null;
    ownedRequest.releaseAbort();
    const verification = verificationRef.current;
    if (value === null && verification?.request === ownedRequest) verification.controller.abort();
    setRequest(null);
    setRunning(false);
    setError(null);
    ownedRequest.resolve(value);
    // A cancelled verification still owns its native work; the next one opens when it drains.
    if (!verificationRef.current) {
      const next = queueRef.current.shift();
      if (next) open(next);
    }
  }, [open]);

  const prompter = useCallback<StepUpPrompter>((context) => {
    const signal = context.signal;
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(ownedRequest, null);
      const ownedRequest: StepUpRequest = { context, resolve,
        releaseAbort: () => signal?.removeEventListener('abort', onAbort) };
      signal?.addEventListener('abort', onAbort, { once: true });
      // A cancelled verification still owns its native work until it settles, so a new one waits too.
      if (requestRef.current || verificationRef.current) { queueRef.current.push(ownedRequest); return; }
      open(ownedRequest);
    });
  }, [settle, open]);

  useEffect(() => {
    registerStepUpPrompter(prompter);
    return () => {
      registerStepUpPrompter(null);
      const ownedRequest = requestRef.current;
      requestRef.current = null;
      ownedRequest?.releaseAbort();
      verificationRef.current?.controller.abort();
      ownedRequest?.resolve(null);
      for (const waiting of queueRef.current.splice(0)) { waiting.releaseAbort(); waiting.resolve(null); }
    };
  }, [prompter]);

  const verify = useCallback((ownedRequest: StepUpRequest) => {
    if (requestRef.current !== ownedRequest || verificationRef.current) return;
    const controller = new AbortController();
    const isCurrent = () => requestRef.current === ownedRequest && !controller.signal.aborted;
    setRunning(true);
    setError(null);
    const completion = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return;
        // The mint and the daemon's passkey list are independent reads; one round trip covers both.
        const [challenge, listed] = await Promise.all([
          platformClient.operator.stepup.mintChallenge(
            // Bound to the request being retried, so the assertion cannot authorize any other call.
            { method: ownedRequest.context.method, path: ownedRequest.context.path },
            controller.signal,
          ),
          // A failed list read only loses the hint; the device then offers any passkey it holds.
          platformClient.operator.stepup.listCredentials(controller.signal).catch(() => null),
        ]);
        if (!isCurrent()) return;
        if (listed && listed.credentials.length === 0) {
          throw new StepUpError('no-credential', 'The daemon has no registered passkey.');
        }
        const { headerValue } = await runAssertion({
          challenge: challenge.challenge,
          credentialIds: listed?.credentials.map((credential) => credential.credentialId),
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        settle(ownedRequest, headerValue);
      } catch (ceremonyError) {
        if (!isCurrent()) return;
        setRunning(false);
        setError(describeStepUpError(ceremonyError));
      } finally {
        if (verificationRef.current?.controller === controller) {
          verificationRef.current = null;
          if (!requestRef.current) {
            const next = queueRef.current.shift();
            if (next) open(next);
          }
        }
      }
    });
    verificationRef.current = { request: ownedRequest, controller, completion };
  }, [settle, open]);

  if (!request) return null;

  const availability = stepUpAvailability();

  return (
    <Dialog
      open
      onClose={() => settle(request, null)}
      title="Verify to continue"
      footer={(
        <>
          <Button onClick={() => settle(request, null)}>
            Cancel
          </Button>
          {availability.supported && (
            <Button variant="primary" onClick={() => verify(request)} disabled={running}>
              {running ? 'Waiting for passkey…' : 'Verify with passkey'}
            </Button>
          )}
        </>
      )}
    >
      <div className="stepup-ceremony">
        <p className="stepup-lead">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>This action changes something over the relay connection, so it needs a passkey confirmation.</span>
        </p>
        <p className="stepup-target">
          <code>{`${request.context.method} ${request.context.path}`}</code>
        </p>

        {!availability.supported && (
          <div className="banner warning" role="alert">
            {availability.reason ?? 'Passkeys are not supported in this browser.'}
          </div>
        )}

        {error && (
          <div className="banner warning" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
