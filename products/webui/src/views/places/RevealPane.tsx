/**
 * RevealPane: a value the person must see once (a capability that `reveals`:
 * a new device's one-time token, a group's join key), shown whole in its own
 * pane with a copy button until the person leaves it. It lives only in this
 * pane's props: never in the outcome line, a notice, the address, the
 * browser's storage or a log.
 */
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { copyOutcomeMessage, copyText, type CopyOutcome } from '../../lib/copy-text';
import type { CapabilityReveal } from '../../lib/place-capabilities';

export function RevealPane({ reveal, onClose }: { readonly reveal: CapabilityReveal; readonly onClose: () => void }) {
  const [outcome, setOutcome] = useState<CopyOutcome | undefined>();
  const valueRef = useRef<HTMLPreElement | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={reveal.label}
      description={reveal.note || undefined}
      footer={(
        <>
          <Button onClick={() => { void copyText(reveal.value, valueRef.current).then(setOutcome, () => setOutcome('failed')); }}>
            {outcome === 'copied' ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      )}
    >
      <div className="place-reveal">
        <pre ref={valueRef} className="place-reveal__value" aria-label={reveal.label}>{reveal.value}</pre>
        {reveal.qr ? <pre className="place-reveal__qr" aria-hidden="true">{reveal.qr}</pre> : null}
        {outcome && outcome !== 'copied' && copyOutcomeMessage(outcome) ? <p className="place-reveal__note" role="status">{copyOutcomeMessage(outcome)}</p> : null}
      </div>
    </Dialog>
  );
}
