/**
 * CapabilityRunner: one capability, opened from the command palette (listed
 * there, or found by what it does through `capabilities.find`), run the way a
 * place runs it: a form from its inputs, the one question only when it cannot
 * be undone or weakens a protection (opening on the refusing choice), then
 * `capabilities.run` as the person's own request and the line after it as a
 * notice; a value it reveals is shown in its own pane. A capability that runs
 * only where a conversation is, or only inside a terminal program for now,
 * says where it does.
 */
import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useCommandCatalog } from '../../lib/command-catalog';
import { formatError } from '../../lib/errors';
import {
  asksFirst, capabilityButton, capabilityRiskWords, capabilitySentence, displayValues, outcomeLine, resolvePlaceCapability, runPlaceCapability,
  type CapabilityReveal,
} from '../../lib/place-capabilities';
import { useToast } from '../../lib/toast';
import { PlaceForm } from './PlaceForm';
import { RevealPane } from './RevealPane';

export function CapabilityRunner({ id, onClose }: { readonly id: string; readonly onClose: () => void }) {
  const catalog = useCommandCatalog(true);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [formOpen, setFormOpen] = useState(true);
  const [reveal, setReveal] = useState<CapabilityReveal | undefined>();
  if (!catalog) return null;
  const capability = resolvePlaceCapability(catalog.actions, id);
  if (!capability || !capability.runsOnDaemon) {
    return (
      <Dialog open onClose={onClose} title={capability?.action.label ?? id} size="confirm" footer={<Button onClick={onClose}>Close</Button>}>
        <p>
          {capability
            ? 'It acts on a conversation or on what a terminal program holds, so it is done in the terminal app or the Agent.'
            : 'This web UI does not know it yet: it is done in the terminal app or the Agent, or by a script with goodvibes do.'}
        </p>
      </Dialog>
    );
  }
  const submit = async (values: Readonly<Record<string, string>>, names: Readonly<Record<string, string>>) => {
    const shown = displayValues(capability, values, names);
    const risk = asksFirst(capability, values, false);
    if (risk) {
      const yes = await confirm.ask({
        title: `${capability.action.label}?`,
        description: `${capabilitySentence(capability, shown)} This ${capabilityRiskWords(risk)}.`,
        confirmLabel: capabilityButton(capability),
        tone: 'danger',
      });
      if (!yes) return;
    }
    setFormOpen(false);
    try {
      const answer = await runPlaceCapability(capability.id, values);
      toast({ title: outcomeLine(capability, values, shown, answer, undefined), tone: 'success' });
      if (answer.reveal) { setReveal(answer.reveal); return; }
    } catch (error) {
      toast({ title: `${capability.action.label}: not done.`, description: formatError(error), tone: 'warning', durationMs: 0 });
    }
    onClose();
  };
  return (
    <>
      {formOpen ? (
        <PlaceForm
          request={{ capability, place: capability.command.title, given: {}, names: {} }}
          onClose={onClose}
          onSubmit={(values, names) => { void submit(values, names); }}
        />
      ) : null}
      {reveal ? <RevealPane reveal={reveal} onClose={onClose} /> : null}
      {confirm.element}
    </>
  );
}
