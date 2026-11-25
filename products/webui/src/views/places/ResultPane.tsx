/**
 * ResultPane: what an action answered when it is longer than the outcome line
 * holds (more than its done line and two more sentences: a message read, a
 * report, a status review), shown whole and scrollable in its own pane until
 * the person goes back to the list (Esc, or the button). The outcome line says
 * in one sentence what was done. A value shown once (a reveal) has its own
 * pane instead (RevealPane.tsx); nothing here is kept.
 */
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { plainText } from '../../lib/places';

export interface PlaceResult {
  readonly title: string;
  readonly text: string;
}

export function ResultPane({ result, onClose }: { readonly result: PlaceResult; readonly onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={result.title}
      footer={<Button variant="primary" onClick={onClose}>Back to the list</Button>}
    >
      <div className="place-result" tabIndex={0} aria-label={result.title}>
        {plainText(result.text).split(/\n{2,}/).map((block, index) => <p key={index} className="place-result__block">{block}</p>)}
      </div>
    </Dialog>
  );
}
