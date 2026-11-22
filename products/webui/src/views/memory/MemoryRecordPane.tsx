import { Trash2 } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';
import type { MemoryRecord, MemoryScope, MemoryUpdateInput, MemoryUpdateReviewInput } from '../../lib/goodvibes';
import { DetailPane, DetailSection } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { sentence } from '../library/library-data';
import { MemoryRecordDetail } from './MemoryRecordDetail';
import { MEMORY_REVIEW_STATES, MEMORY_SCOPE_LINES, MEMORY_SCOPES, confidenceMeaning, isFlaggedReviewState, splitTags } from './memory-helpers';

interface MemoryRecordPaneProps {
  record: MemoryRecord;
  onClose: () => void;
  onDelete: (record: MemoryRecord) => void;
  deleting: boolean;
  onSaveReview: (id: string, input: MemoryUpdateReviewInput) => void;
  saving: boolean;
  /** Saves edited words, tags or scope in place (memory.records.update), keeping the record's history. */
  onSaveEdit: (id: string, input: MemoryUpdateInput) => void;
  savingEdit: boolean;
  /** An error from the last review save or delete, shown in the pane. */
  error?: string | null;
  /** The store's recall floor from the search that listed the record: below it, a record is not brought into answers. */
  recallFloor?: number;
}

/** The right-hand pane for one memory record: detail, an edit form for its summary,
 * detail, tags and scope (memory.records.update, the record keeps its id, confidence and
 * provenance), the review form (state, confidence, reason; memory.records.update-review)
 * and a confirmed delete. Each form commits only on its own Save. Keyed by record id by
 * the caller so drafts reset per record. */
export function MemoryRecordPane({ record, onClose, onDelete, deleting, onSaveReview, saving, onSaveEdit, savingEdit, error, recallFloor }: MemoryRecordPaneProps) {
  const formId = useId();
  const editFormId = useId();
  const [summary, setSummary] = useState(record.summary);
  const [detail, setDetail] = useState(record.detail ?? '');
  const [tags, setTags] = useState(record.tags.join(', '));
  const [scope, setScope] = useState<MemoryScope>(record.scope);
  const editTags = splitTags(tags);
  const edit: MemoryUpdateInput = {
    ...(summary.trim() !== record.summary ? { summary: summary.trim() } : {}),
    ...(detail.trim() !== (record.detail ?? '') ? { detail: detail.trim() } : {}),
    ...(editTags.join('\n') !== record.tags.join('\n') ? { tags: editTags } : {}),
    ...(scope !== record.scope ? { scope } : {}),
  };
  const editChanged = Object.keys(edit).length > 0;
  const summaryValid = summary.trim() !== '';
  const [state, setState] = useState(record.reviewState);
  const [confidence, setConfidence] = useState(String(Math.round(record.confidence)));
  const [staleReason, setStaleReason] = useState(record.staleReason ?? '');
  const confirm = useConfirm();
  const flagged = isFlaggedReviewState(state);
  const parsed = Number(confidence);
  const confidenceValid = confidence.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confidenceValid) return;
    onSaveReview(record.id, {
      state,
      confidence: parsed,
      ...(flagged && staleReason.trim() ? { staleReason: staleReason.trim() } : {}),
    });
  }

  function submitEdit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editChanged || !summaryValid) return;
    onSaveEdit(record.id, edit);
  }

  async function handleDelete(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this memory?',
      target: record.summary,
      description: 'It is removed for good and cannot be brought back.',
      confirmLabel: 'Delete memory',
      tone: 'danger',
    });
    if (ok) onDelete(record);
  }

  return (
    <>
      <DetailPane
        title={record.summary}
        meta={`${sentence(record.cls)} · ${record.scope}`}
        onClose={onClose}
        actions={(
          <Button variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" />} disabled={deleting} onClick={() => void handleDelete()}>
            Delete
          </Button>
        )}
        footer={(
          <Button type="submit" form={formId} variant="secondary" disabled={saving || !confidenceValid} aria-busy={saving}>
            {saving ? 'Saving…' : 'Save review'}
          </Button>
        )}
      >
        {error && <div className="dv-notice dv-notice--bad" role="alert"><span>{error}</span></div>}
        <MemoryRecordDetail record={record} recallFloor={recallFloor} />
        <DetailSection title="Edit">
          <form id={editFormId} className="lib-form" onSubmit={submitEdit}>
            <Field label="Summary" error={summaryValid ? undefined : 'A memory needs a summary.'}>
              <Input value={summary} aria-label={`Summary of ${record.summary}`} onChange={(event) => setSummary(event.target.value)} />
            </Field>
            <Field label="Detail">
              <Textarea value={detail} rows={4} aria-label={`Detail of ${record.summary}`} onChange={(event) => setDetail(event.target.value)} />
            </Field>
            <Field label="Tags" help="Comma separated.">
              <Input value={tags} aria-label={`Tags of ${record.summary}`} onChange={(event) => setTags(event.target.value)} />
            </Field>
            <Field label="Scope" help={MEMORY_SCOPE_LINES[scope]}>
              <Select<MemoryScope>
                value={scope}
                aria-label={`Scope of ${record.summary}`}
                onChange={setScope}
                options={MEMORY_SCOPES.map((option) => ({ value: option, label: sentence(option) }))}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={savingEdit || !editChanged || !summaryValid} aria-busy={savingEdit}>
              {savingEdit ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        </DetailSection>
        <DetailSection title="Review">
          <form id={formId} className="lib-form" onSubmit={submit}>
            <Field label="Review state">
              <Select
                value={state}
                aria-label={`Review state for ${record.summary}`}
                onChange={setState}
                options={MEMORY_REVIEW_STATES.map((option) => ({ value: option, label: sentence(option) }))}
              />
            </Field>
            <Field
              label="How sure it is said to be (0 to 100)"
              help={confidenceMeaning(recallFloor)}
              error={confidence.trim() !== '' && !confidenceValid ? 'Enter a number from 0 to 100.' : undefined}
            >
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                value={confidence}
                aria-label={`How sure "${record.summary}" is said to be, 0 to 100`}
                onChange={(event) => setConfidence(event.target.value)}
              />
            </Field>
            {flagged && (
              <Field label="Reason">
                <Input
                  value={staleReason}
                  placeholder="Why is this flagged?"
                  aria-label={`Stale/contradicted reason for ${record.summary}`}
                  onChange={(event) => setStaleReason(event.target.value)}
                />
              </Field>
            )}
          </form>
        </DetailSection>
      </DetailPane>

      {confirm.element}
    </>
  );
}
