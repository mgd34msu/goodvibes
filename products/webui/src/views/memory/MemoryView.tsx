/**
 * The Memory tab of the Library, the web UI's consumer of the canonical, cross-surface
 * memory store (memory.records.* platform 1.1.0): search and browse, record detail with its
 * review form and confirmed delete, and the store's point-in-time copies with the owner's
 * confirmed restore (MemoryCopiesPanel). The Agent's persona is its VIBE.md file, not memory
 * records; records an earlier import left tagged `vibe` are listed as ordinary memory,
 * to keep, edit or delete like any other. Adding a record is the page's primary action (AddMemoryDialog, in LibraryView).
 *
 * HONESTY. The recall-honesty contract (memory-recall-contract.ts) is applied
 * server-side and surfaced here verbatim via MemorySearchHonestyNote: which search
 * mode actually ran (literal vs semantic), the stated reason when the semantic index
 * could not be consulted (never a silent empty result), the soft hashed-provider
 * caveat, and the recall-filter exclusion counts. A daemon that does not serve memory
 * at all (METHOD_NOT_FOUND on the list query) gets an honest "this daemon does not
 * serve memory" state, never a blank list that reads as "nothing is stored".
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Database, Plus, SlidersHorizontal, X } from 'lucide-react';
import {
  client as platformClient,
  type MemoryClass,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchInput,
} from '../../lib/goodvibes';
import { NO_EVENT_LIST_FRESHNESS, queryKeys } from '../../lib/queries';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { EmptyState, ListDetail, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { ReadAt } from '../../components/data-view/ReadAt';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { ErrorState } from '../../components/feedback/ErrorState';
import { sentence, useDebouncedValue, useMemoryRecordMutations } from '../library/library-data';
import { MemoryRecordRow } from './MemoryRecordRow';
import { MemoryRecordPane } from './MemoryRecordPane';
import { MemorySearchHonestyNote } from './MemorySearchHonestyNote';
import { MemoryCopiesPanel } from './MemoryCopiesPanel';
import { ratingsMeaning, MEMORY_CLASSES, MEMORY_SCOPES, splitTags } from './memory-helpers';
import '../../styles/components/memory.css';

/** One page of records; "Show more" asks for the next page on top. */
const LIMIT = 100;

export interface MemoryViewProps {
  /** The Library's shared search text (already settled). */
  query?: string;
  /** Opens the Add memory dialog (the empty state's action). */
  onAddMemory?: () => void;
  /** Told whether the daemon serves memory at all, so the page can drop actions that would only fail. */
  onServedChange?: (served: boolean) => void;
  /** The store's copies and restore are open (the Library header's "Copies and restore"). */
  showCopies?: boolean;
}

export function MemoryView({ query = '', onAddMemory, onServedChange, showCopies = false }: MemoryViewProps) {
  const [semantic, setSemantic] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<MemoryScope | ''>('');
  const [clsFilter, setClsFilter] = useState<MemoryClass | ''>('');
  const [tagsInput, setTagsInput] = useState('');
  const [recall, setRecall] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The filters stay folded behind one button until asked for; the ones in force show as chips.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const tagsSettled = useDebouncedValue(tagsInput);

  const { remove, saveReview, saveEdit } = useMemoryRecordMutations();

  // The page size grows with "Show more" and starts over whenever the search changes.
  const filterKey = JSON.stringify([query.trim(), semantic, scopeFilter, clsFilter, tagsSettled, recall]);
  const [page, setPage] = useState({ filterKey, limit: LIMIT });
  const limit = page.filterKey === filterKey ? page.limit : LIMIT;

  const appliedFilters = useMemo<MemorySearchInput>(() => {
    const tags = splitTags(tagsSettled);
    return {
      limit,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(semantic ? { semantic: true } : {}),
      ...(scopeFilter ? { scope: scopeFilter } : {}),
      ...(clsFilter ? { cls: clsFilter } : {}),
      ...(tags.length ? { tags } : {}),
      ...(recall ? { recall: true } : {}),
    };
  }, [limit, query, semantic, scopeFilter, clsFilter, tagsSettled, recall]);
  const browsing = Object.keys(appliedFilters).length === 1;

  const list = useQuery({
    queryKey: [...queryKeys.memoryList, appliedFilters],
    queryFn: () => platformClient.operator.memory.search(appliedFilters),
    placeholderData: keepPreviousData,
    ...NO_EVENT_LIST_FRESHNESS,
  });
  const records = useMemo(() => list.data?.records ?? [], [list.data]);

  const selected: MemoryRecord | undefined = useMemo(
    () => (selectedId === null ? undefined : records.find((r) => r.id === selectedId)),
    [selectedId, records],
  );

  const activeFilters: { key: string; label: string; clear: () => void }[] = [
    ...(scopeFilter ? [{ key: 'scope', label: `Applies: ${sentence(scopeFilter)}`, clear: () => setScopeFilter('') }] : []),
    ...(clsFilter ? [{ key: 'cls', label: `Kind: ${sentence(clsFilter)}`, clear: () => setClsFilter('') }] : []),
    ...(tagsInput.trim() ? [{ key: 'tags', label: `Tagged: ${tagsInput.trim()}`, clear: () => setTagsInput('') }] : []),
    ...(semantic ? [{ key: 'semantic', label: 'By meaning', clear: () => setSemantic(false) }] : []),
    ...(recall ? [{ key: 'recall', label: 'Only what the agent would recall', clear: () => setRecall(false) }] : []),
  ];
  function resetFilters() {
    setSemantic(false);
    setRecall(false);
    setScopeFilter('');
    setClsFilter('');
    setTagsInput('');
  }

  // Honest degrade: this daemon build genuinely does not serve the memory verbs at all
  // (a real 404 METHOD_NOT_FOUND on the capability, not a transient failure).
  const notServed = list.isError && isMethodUnavailableError(list.error);
  useEffect(() => { onServedChange?.(!notServed); }, [notServed, onServedChange]);
  if (notServed) {
    return (
      <div className="lib-tab">
        <EmptyState icon={<Database />} title="This daemon does not serve memory">
          The connected daemon build has no memory.records.* service. Upgrade it to browse, add, review, or delete memory records here.
        </EmptyState>
      </div>
    );
  }

  // The mutations are shared by every row: an error belongs to the record it was for.
  const mutationError = (remove.error && remove.variables?.id === selectedId ? remove.error : null)
    ?? (saveReview.error && saveReview.variables?.id === selectedId ? saveReview.error : null)
    ?? (saveEdit.error && saveEdit.variables?.id === selectedId ? saveEdit.error : null);
  // A full page means more records may exist past it: say so and offer the next page.
  const pageFull = (list.data?.records.length ?? 0) >= limit;

  const listPane = (
    <>
      <div aria-live="polite" aria-atomic="false">
        {list.error && (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Search failed" />
        )}
        {list.data && <MemorySearchHonestyNote result={list.data} limit={limit} />}
      </div>
      {list.isPending && <SkeletonRows count={6} label="Loading memory" />}
      {list.data?.records.length === 0 && (
        <EmptyState
          icon={<Database />}
          title={browsing ? 'No memory recorded yet' : 'Nothing matches'}
          action={onAddMemory && <Button variant="secondary" icon={<Plus aria-hidden="true" />} onClick={onAddMemory}>Add memory</Button>}
        >
          {browsing ? 'Add a memory to start building what GoodVibes remembers.' : 'Nothing matches this search. Try fewer filters.'}
        </EmptyState>
      )}
      {list.data && records.length > 0 && (
        <p className="memory-rating-note">{ratingsMeaning(list.data.recallFloor)}</p>
      )}
      {list.data && records.length > 0 && (
        <RowGroup label="Records" count={records.length} unit={['record', 'records']}>
          {records.map((record) => (
            <MemoryRecordRow
              key={record.id}
              record={record}
              recallFloor={list.data.recallFloor}
              selected={record.id === selected?.id}
              onOpen={(r) => setSelectedId(r.id)}
            />
          ))}
        </RowGroup>
      )}
      {list.data && pageFull && (
        <div className="lib-toolbar" role="status">
          <span>{`Showing the first ${String(limit)} records${browsing ? '' : ' that match'}.`}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={list.isFetching}
            onClick={() => setPage({ filterKey, limit: limit + LIMIT })}
          >
            {list.isFetching ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </>
  );

  return (
    <ErrorBoundary
      fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Memory view failed" />}
    >
      <div className="lib-tab">
        <div className="lib-toolbar memory-filter-bar">
          <Button
            variant="secondary"
            size="sm"
            icon={<SlidersHorizontal aria-hidden="true" />}
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {activeFilters.length > 0 ? `Filters · ${String(activeFilters.length)}` : 'Filters'}
          </Button>
          {activeFilters.map((filter) => (
            <span key={filter.key} className="gv-chip gv-chip--sm memory-filter-chip">
              {filter.label}
              <button type="button" className="memory-filter-chip__remove" aria-label={`Remove filter: ${filter.label}`} onClick={filter.clear}>
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
          {activeFilters.length > 0 && <Button variant="ghost" size="sm" onClick={resetFilters}>Clear all</Button>}
          {/* Memory sends no live event: say when the records were read. */}
          <span className="memory-filter-bar__end">
            <ReadAt at={list.dataUpdatedAt} onRefresh={() => void list.refetch()} refreshing={list.isFetching} />
          </span>
        </div>
        {filtersOpen && (
        <div id={filtersId} className="lib-toolbar memory-filters" role="group" aria-label="Memory filters">
          {/* Each control under the question it answers. */}
          <div className="memory-filter">
            <span className="memory-filter__question" aria-hidden="true">Applies where?</span>
            <Select<MemoryScope | ''>
              value={scopeFilter}
              aria-label="Applies where?"
              onChange={setScopeFilter}
              options={[{ value: '', label: 'Any scope' }, ...MEMORY_SCOPES.map((s) => ({ value: s, label: sentence(s) }))]}
            />
          </div>
          <div className="memory-filter">
            <span className="memory-filter__question" aria-hidden="true">What kind?</span>
            <Select<MemoryClass | ''>
              value={clsFilter}
              aria-label="What kind?"
              onChange={setClsFilter}
              options={[{ value: '', label: 'Any type' }, ...MEMORY_CLASSES.map((c) => ({ value: c, label: sentence(c) }))]}
            />
          </div>
          <div className="memory-filter">
            <span className="memory-filter__question" aria-hidden="true">Tagged with?</span>
            <Input
              className="lib-toolbar__tags"
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="Tags, comma separated"
              aria-label="Tagged with?"
            />
          </div>
          <div className="memory-filter">
            <span className="memory-filter__question" aria-hidden="true">Match how?</span>
            <Checkbox checked={semantic} onChange={setSemantic}>By meaning, not exact words</Checkbox>
          </div>
          <div className="memory-filter">
            <span className="memory-filter__question" aria-hidden="true">Show which?</span>
            <Checkbox checked={recall} onChange={setRecall}>Only what the agent would recall</Checkbox>
            <span className="memory-filter__help">Leaves out flagged records and records rated below the floor.</span>
          </div>
        </div>
        )}

        {showCopies && <MemoryCopiesPanel />}

        {mutationError && (
          <div className="lib-toolbar"><div className="dv-notice dv-notice--bad" role="alert"><span>{formatError(mutationError)}</span></div></div>
        )}

        <ListDetail

          mode="peek"
          list={listPane}
          detail={selected && (
            <MemoryRecordPane
              key={selected.id}
              record={selected}
              onClose={() => setSelectedId(null)}
              onDelete={(record) => remove.mutate(record)}
              deleting={remove.isPending && remove.variables.id === selected.id}
              onSaveReview={(id, input) => saveReview.mutate({ id, input })}
              saving={saveReview.isPending && saveReview.variables.id === selected.id}
              onSaveEdit={(id, input) => saveEdit.mutate({ id, input })}
              savingEdit={saveEdit.isPending && saveEdit.variables.id === selected.id}
              recallFloor={list.data?.recallFloor}
            />
          )}
          detailOpen={selected !== undefined}
          onCloseDetail={() => setSelectedId(null)}
          listLabel="Memory records"
          detailLabel="Memory record"
          backLabel="All memory"
        />
      </div>
    </ErrorBoundary>
  );
}
