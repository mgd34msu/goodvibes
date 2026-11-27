/**
 * Places: every place the terminal programs draw, drawn in the browser from
 * the same declarations (`@goodvibes/engine/terminal-shell/places/browser`).
 *
 * The navigation lists the fourteen function groups in their order, each with
 * its count where something is waiting or wrong (the place's own `count`, made
 * by the daemon for every place in one call, `places.counts`), under the
 * project chooser: every read and act bound to a project is for the project
 * chosen there (lib/place-project.ts). An action that runs only in a terminal
 * program is shown greyed with one line saying where it runs.
 * A place shows its lists as tabs, each read by itself from the daemon and
 * kept current by the event stream (hooks/usePlaceLists); the selected item's
 * detail; and its actions as buttons, only those that apply to the item in its
 * state, each a capability run with `capabilities.run` as the person's own
 * request. Inputs the item does not give open a form built from the
 * capability's inputs. Only an act that cannot be undone or weakens a
 * protection asks first, opening on the refusing choice, and never an answer
 * to a waiting item: the item is the question. The line after an action says
 * what happened, with the item named by its title and how to undo it.
 *
 * URL: `?view=places&tab=<place id>`; `filter[list]=<list id>` keeps the tab.
 */
import { ArrowLeft, Compass, Inbox, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ActionValues } from '@goodvibes/engine/terminal-shell/command-actions/data';
import { DataPage, DetailPane, EmptyState, ListDetail, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { PHONE_QUERY, useMediaQuery } from '../../components/ui/overlay';
import { Row, RowList } from '../../components/ui/Row';
import { Select } from '../../components/ui/Select';
import { StatusDot, type StatusTone } from '../../components/ui/StatusDot';
import { usePlaceLists, type PlaceListState } from '../../hooks/usePlaceLists';
import { formatError } from '../../lib/errors';
import { useEventStreamState } from '../../lib/event-stream';
import {
  asksFirst, capabilityButton, capabilityRiskSentences, capabilitySentence, displayValues, loadCapabilities, opensForm, outcomeLine, resolvePlaceCapability,
  runPlaceCapability, useCapabilityIndex, type CapabilityReveal, type PlaceCapability,
} from '../../lib/place-capabilities';
import { EVERY_PROJECT, projectName, usePlaceProjects, type PlaceProjects } from '../../lib/place-project';
import {
  PLACE_GROUPS, RICHER_VIEWS, actionOfferedFor, allActionsOf, answersItem, elsewhereOf, filledFrom, itemActions, paneOf, placeActions, placeById, plainText, startingValues, undoActionOf, webListsOf, wholeActions,
  type AnyPlace, type PlaceAnswer, type PlaceCapabilityAction, type PlaceCount, type PlaceDetailLine, type PlaceItem, type PlaceList, type PlaceRow,
  type RicherView,
} from '../../lib/places';
import type { ViewId } from '../../lib/router';
import { PlaceForm, type PlaceFormRequest } from './PlaceForm';
import { PLACE_PANES } from './place-panes';
import { RevealPane } from './RevealPane';
import { ResultPane, type PlaceResult } from './ResultPane';
import '../../styles/components/places.css';

export interface PlacesViewProps {
  /** The open place's id ('' for the list of places). */
  tab?: string | undefined;
  /** The open list's id within the place. */
  list?: string | undefined;
  onOpenPlace: (placeId: string) => void;
  onOpenList: (listId: string) => void;
  onNavigate: (view: ViewId, options?: { tab?: string }) => void;
  onOpenSettings: (section?: string) => void;
}

const MARK_TONES: Readonly<Record<NonNullable<PlaceRow['mark']>, StatusTone>> = {
  ok: 'ok', paused: 'idle', attention: 'warn', running: 'live', waiting: 'info',
};
const MARK_WORDS: Readonly<Record<NonNullable<PlaceRow['mark']>, string>> = {
  ok: 'fine', paused: 'paused', attention: 'needs a look', running: 'running', waiting: 'waiting on you',
};

/** The project chooser: the projects the daemon knows, opening on the one last chosen in this browser. */
function ProjectChooser({ projects }: { readonly projects: PlaceProjects }) {
  if (projects.status === 'failed') return <p className="place-project__note" role="status">{`Could not read the projects the daemon knows: ${projects.reason ?? 'no reason was given'}. They are read again by themselves when the daemon answers.`}</p>;
  if (projects.projects.length === 0) return null;
  return (
    <label className="place-project">
      <span className="place-project__label">Project</span>
      <Select
        aria-label="Project"
        value={projects.project ?? ''}
        onChange={projects.choose}
        options={[...projects.projects.map((project) => ({ value: project, label: projectName(project) })), { value: EVERY_PROJECT, label: 'Every project' }]}
      />
    </label>
  );
}

/** A row as its declaration draws it; an item whose data the row cannot read is named by its id. */
function rowOf(list: PlaceList<PlaceItem>, item: PlaceItem): PlaceRow {
  try { return list.row(item); } catch { return { title: item.id }; }
}

/** A tab's number, as the terminal's place counts it: an item marked `uncounted` ("not set up", a repeat's later occurrence) is left out. */
function countedItems(items: readonly PlaceItem[]): number {
  return items.filter((item) => item.uncounted !== true).length;
}

function detailOf(list: PlaceList<PlaceItem>, item: PlaceItem): readonly PlaceDetailLine[] {
  try { return list.detail(item); } catch (error) { return [{ text: `This item could not be shown: ${formatError(error)}`, tone: 'warning' }]; }
}

/** First letter up: an action's words on a button ("pause" becomes "Pause"). */
function upperFirst(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The detail lines: label and value rows, paragraphs, a blank line as a gap. */
function DetailLines({ lines }: { readonly lines: readonly PlaceDetailLine[] }) {
  const blocks: ReactNode[] = [];
  let facts: PlaceDetailLine[] = [];
  const flush = () => {
    if (facts.length === 0) return;
    const rows = facts;
    blocks.push(
      <dl key={`f${blocks.length}`} className="dv-facts place-facts">
        {rows.map((line, index) => (
          <div key={`${line.label}-${index}`} className="dv-facts__row" data-tone={line.tone ?? undefined}>
            <dt>{line.label}</dt>
            <dd>{plainText(line.text)}</dd>
          </div>
        ))}
      </dl>,
    );
    facts = [];
  };
  lines.forEach((line, index) => {
    if (line.label) { facts.push(line); return; }
    flush();
    if (line.text === '') return;
    blocks.push(<p key={`p${index}`} className="place-paragraph" data-tone={line.tone ?? undefined}>{plainText(line.text)}</p>);
  });
  flush();
  return <div className="place-detail">{blocks}</div>;
}

interface Outcome {
  readonly text: string;
  readonly tone: 'plain' | 'warning';
  /** The action that undoes what just ran, on the same item. */
  readonly undo?: { readonly action: PlaceCapabilityAction<PlaceItem>; readonly label: string; readonly item?: PlaceItem | undefined } | undefined;
}

export function PlacesView({ tab, list: listParam, onOpenPlace, onOpenList, onNavigate, onOpenSettings }: PlacesViewProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const place = tab ? placeById(tab) : undefined;
  const elsewhere = tab && !place ? PLACE_GROUPS.find((row) => row.group === tab && row.elsewhere) : undefined;
  const projects = usePlaceProjects();
  // A project-bound place's lists wait for the projects to be read, so nothing is read for a folder not chosen.
  const lists = usePlaceLists(place, projects.status === 'reading' ? null : projects.project);
  const showRail = !phone || (!place && !elsewhere);
  return (
    <div className="places" data-phone={phone ? '' : undefined}>
      {showRail && (
        <nav className="places-rail" aria-label="Places">
          {phone && <h2 className="places-rail__title">Places</h2>}
          <ProjectChooser projects={projects} />
          {lists.countsFailed ? <p className="place-project__note" role="status">{`What waits in each place could not be read: ${lists.countsFailed}. It is read again by itself when the daemon answers.`}</p> : null}
          <ul className="places-rail__list">
            {PLACE_GROUPS.map((row) => {
              const target = row.place?.id ?? row.group;
              const count: PlaceCount | undefined = row.place ? lists.counts[row.place.id]?.count : undefined;
              const current = target === tab;
              return (
                <li key={row.group}>
                  <button
                    type="button"
                    className="places-rail__row"
                    aria-current={current ? 'page' : undefined}
                    data-elsewhere={row.place ? undefined : ''}
                    onClick={() => onOpenPlace(target)}
                  >
                    <span className="places-rail__text">
                      <span className="places-rail__name">{row.title}</span>
                      <span className="places-rail__line">{row.place ? row.line : 'In the terminal app and the Agent'}</span>
                    </span>
                    {count && count.count > 0 ? (
                      <span className="gv-chip gv-chip--sm places-rail__count" data-tone={count.tone} title={count.words}>
                        <span className={`gv-dot gv-dot--${count.tone === 'wrong' ? 'bad' : 'warn'}`} aria-hidden="true" />
                        <span className="gv-sr-only">{count.words}: </span>
                        {count.count > 99 ? '99+' : count.count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {place ? (
        <PlaceScreen
          key={place.id}
          place={place}
          listParam={listParam}
          lists={lists}
          projects={projects}
          onOpenList={onOpenList}
          onBack={phone ? () => onOpenPlace('') : undefined}
          onNavigate={onNavigate}
          onOpenSettings={onOpenSettings}
        />
      ) : elsewhere ? (
        <div className="places-main">
          <DataPage title={elsewhere.title} description={elsewhere.line} action={phone ? <BackButton onBack={() => onOpenPlace('')} /> : undefined}>
            <EmptyState icon={<Compass />}>{elsewhere.elsewhere}</EmptyState>
          </DataPage>
        </div>
      ) : !phone ? (
        <div className="places-main">
          <DataPage title="Places" description="Every place GoodVibes keeps, in the same groups as the terminal app and the Agent">
            <EmptyState icon={<Compass />}>Choose a place on the left: its lists read by themselves, and every action is a button on the thing it acts on.</EmptyState>
          </DataPage>
        </div>
      ) : null}
    </div>
  );
}

function BackButton({ onBack }: { readonly onBack: () => void }) {
  return <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden="true" />} onClick={onBack}>All places</Button>;
}

function RicherLinks({ views, onNavigate, onOpenSettings }: {
  readonly views: readonly RicherView[]; readonly onNavigate: PlacesViewProps['onNavigate']; readonly onOpenSettings: PlacesViewProps['onOpenSettings'];
}) {
  if (views.length === 0) return null;
  return (
    <div className="place-richer" aria-label="Also in">
      <span className="place-richer__label">Also in</span>
      {views.map((view) => (
        <Button
          key={view.label}
          variant="ghost"
          size="sm"
          onClick={() => (view.settings ? onOpenSettings(view.settings) : view.view ? onNavigate(view.view, view.tab ? { tab: view.tab } : undefined) : undefined)}
        >
          {view.label}
        </Button>
      ))}
    </div>
  );
}

function PlaceScreen({ place, listParam, lists, projects, onOpenList, onBack, onNavigate, onOpenSettings }: {
  readonly place: AnyPlace;
  readonly listParam: string | undefined;
  readonly lists: ReturnType<typeof usePlaceLists>;
  readonly projects: PlaceProjects;
  readonly onOpenList: (listId: string) => void;
  readonly onBack: (() => void) | undefined;
  readonly onNavigate: PlacesViewProps['onNavigate'];
  readonly onOpenSettings: PlacesViewProps['onOpenSettings'];
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const { shown, elsewhere } = useMemo(() => webListsOf(place), [place]);
  const list = shown.find((candidate) => candidate.id === listParam) ?? shown[0];
  const state: PlaceListState | undefined = list ? lists.stateOf(place, list) : undefined;
  // What each action's capability is and where it runs: the daemon's own registry, read at run time.
  const capabilities = useCapabilityIndex();
  const stream = useEventStreamState('app');
  // A read of the registry that failed (the daemon was down) is made again when the daemon's stream is live.
  useEffect(() => {
    if (stream.status === 'live' && !capabilities) void loadCapabilities().catch(() => undefined);
  }, [stream.status, capabilities]);
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Readonly<Record<string, string | undefined>>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<CapabilityReveal | undefined>();
  const [result, setResult] = useState<PlaceResult | undefined>();
  const [form, setForm] = useState<{ readonly request: PlaceFormRequest; readonly action: PlaceCapabilityAction<PlaceItem>; readonly item?: PlaceItem | undefined } | undefined>();
  /** An act whose result shows on another list (`doneOn`): that list's rows before it, so its next read selects the row it added. */
  const [afterAct, setAfterAct] = useState<{ readonly list: string; readonly before: ReadonlySet<string> } | undefined>();
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = state?.items ?? [];
  // The list an act opened on (`doneOn`) selects the row the act added once it is read with it.
  useEffect(() => {
    if (!afterAct || list?.id !== afterAct.list) return;
    const added = items.find((candidate) => !afterAct.before.has(candidate.id));
    if (!added) return;
    setSelected((now) => ({ ...now, [afterAct.list]: added.id }));
    setDetailOpen(true);
    setAfterAct(undefined);
  }, [afterAct, items, list?.id]);
  const selectedId = list ? selected[list.id] : undefined;
  // The selection stays on the same item across reads; a desktop opens on the first one, a phone on the list.
  const item = items.find((candidate) => candidate.id === selectedId) ?? (phone ? undefined : items[0]);
  const open = phone ? detailOpen && item !== undefined : item !== undefined;

  const resolve = useCallback((action: PlaceCapabilityAction<PlaceItem>): PlaceCapability | undefined => {
    const capability = resolvePlaceCapability(capabilities, action.capability);
    return capability?.runsOnDaemon ? capability : undefined;
  }, [capabilities]);
  const labelOf = useCallback((action: PlaceCapabilityAction<PlaceItem>, capability: PlaceCapability) => upperFirst(action.label ?? capability.action.label.toLowerCase()), []);

  const titleOf = useCallback((target: PlaceItem | undefined): string | undefined => {
    if (!target || !list) return undefined;
    return rowOf(list, target).title;
  }, [list]);

  /** Run a capability with these values (after the form, and the one question when it asks first). */
  const run = useCallback(async (
    action: PlaceCapabilityAction<PlaceItem>, capability: PlaceCapability, values: ActionValues, names: Readonly<Record<string, string>>,
    target: PlaceItem | undefined, answer: PlaceAnswer | undefined,
  ) => {
    const shownValues = displayValues(capability, values, names);
    const risk = asksFirst(capability, values, answersItem(action));
    if (risk) {
      const yes = await confirm.ask({
        title: `${capability.action.label}?`,
        description: `${capabilitySentence(capability, shownValues)} ${capabilityRiskSentences(capability, values)}`,
        confirmLabel: capabilityButton(capability),
        tone: 'danger',
      });
      if (!yes) return;
    }
    setBusy(true);
    setOutcome({ text: `${capability.action.label}…`, tone: 'plain' });
    try {
      const answered = await runPlaceCapability(capability.id, values, projects.project);
      const title = titleOf(target);
      const line = outcomeLine(capability, values, shownValues, answered, target && title ? { id: target.id, title } : undefined,
        answer ? { said: answer.said ?? answer.label, values: answer.values } : undefined);
      // A value the person must see once goes to its own pane, never into the line.
      if (answered.reveal) setReveal(answered.reveal);
      // An answer longer than the line holds (its done line and two more sentences) opens whole in the result pane;
      // the line then says in one sentence what was done.
      const whole = (answered.detail ?? answered.text).trim();
      const sentences = whole.split(/(?<=[.!?:])\s+|\n+/).filter((part) => part.trim() !== '').length;
      const long = !answered.reveal && (sentences > 3 || whole.length > 400);
      if (long) setResult({ title: capability.action.label, text: whole });
      // How to undo it: the place's action whose capability is the one that undoes this.
      const undoneBy = capability.action.undoneBy;
      const undoAction = undoneBy ? undoActionOf(place, action.list, undoneBy, (candidate) => resolve(candidate)?.action.id) : undefined;
      const undoCapability = undoAction ? resolve(undoAction) : undefined;
      setOutcome({
        text: long ? `${capability.action.label}: the whole answer is shown in its own pane.` : line, tone: 'plain',
        ...(undoAction && undoCapability ? { undo: { action: undoAction, label: labelOf(undoAction, undoCapability), item: target } } : {}),
      });
      // What it made shows on another list (`doneOn`, as the terminal place does): that list opens, on the row it added.
      // A list not read yet has no rows to tell the new one from: it opens without moving the selection.
      const doneOn = action.doneOn !== undefined ? shown.find((candidate) => candidate.id === action.doneOn) : undefined;
      if (doneOn) {
        const before = lists.stateOf(place, doneOn);
        if (before.read) setAfterAct({ list: doneOn.id, before: new Set(before.items.map((entry) => entry.id)) });
        if (doneOn.id !== list?.id) onOpenList(doneOn.id);
      }
    } catch (error) {
      setOutcome({ text: `Not done: ${formatError(error)}`, tone: 'warning' });
    } finally {
      setBusy(false);
      lists.readPlace(place);
    }
  }, [confirm, labelOf, list?.id, lists, onOpenList, place, projects.project, resolve, shown, titleOf]);

  /**
   * The actions here that run only in a terminal program: shown greyed, never hidden, each group with the one line
   * that says where it runs.
   */
  const greyed = (scope: 'place' | 'whole' | 'item', target?: PlaceItem): ReactNode => {
    const actions = allActionsOf(place).filter((action) => (scope === 'place' ? action.list === undefined
      : action.list === list?.id && (scope === 'whole'
        ? action.kind !== 'program' && action.whole === true
        : (action.kind === 'program' || action.whole !== true) && target !== undefined && actionOfferedFor(action, target))));
    const byWhere = new Map<string, string[]>();
    for (const action of actions) {
      const capability = action.kind === 'program' ? undefined : resolvePlaceCapability(capabilities, action.capability);
      if (action.kind !== 'program' && !capability) continue;
      const where = elsewhereOf(action, capability?.runsIn, capability?.group);
      if (!where) continue;
      const label = upperFirst(action.label ?? capability?.action.label.toLowerCase() ?? '');
      byWhere.set(where, [...(byWhere.get(where) ?? []), label]);
    }
    if (byWhere.size === 0) return null;
    return [...byWhere.entries()].map(([where, labels]) => (
      <div key={where} className="place-elsewhere-actions">
        <div className="place-elsewhere-actions__buttons">
          {labels.map((label) => <Button key={label} size="sm" variant="secondary" disabled title={where}>{label}</Button>)}
        </div>
        <p className="place-elsewhere-actions__where">{where}</p>
      </div>
    ));
  };

  /** A pressed button: the item fills what it gives, a form asks for the rest, then it runs. */
  const press = useCallback((action: PlaceCapabilityAction<PlaceItem>, target: PlaceItem | undefined, answer?: PlaceAnswer) => {
    const capability = resolve(action);
    if (!capability) return;
    const values: Record<string, string> = { ...filledFrom(action, target), ...(answer?.values ?? {}) };
    const title = titleOf(target);
    const names: Record<string, string> = target && title ? { [target.id]: `"${title}"` } : {};
    // A form when a required input is left, or always for an action that declares `form`.
    if (opensForm(capability, values, action.form === true)) {
      setForm({ request: { capability, place: place.title, given: values, start: startingValues(action, target), names }, action, item: target });
      return;
    }
    void run(action, capability, values, names, target, answer);
  }, [place.title, resolve, run, titleOf]);

  const buttonsFor = (actions: readonly PlaceCapabilityAction<PlaceItem>[], target: PlaceItem | undefined): ReactNode[] => actions.flatMap((action) => {
    const capability = resolve(action);
    if (!capability) return [];
    if (action.answers && target) {
      let answers: readonly PlaceAnswer[] = [];
      try { answers = action.answers(target); } catch { answers = []; }
      return answers.map((answer) => (
        <Button
          key={`${action.capability}-${answer.key}-${answer.label}`}
          size="sm"
          variant={answer.opensOn ? 'primary' : 'secondary'}
          data-refuses={answer.refuses ? '' : undefined}
          disabled={busy}
          onClick={() => press(action, target, answer)}
        >
          {upperFirst(answer.said ?? answer.label)}
        </Button>
      ));
    }
    return [(
      <Button key={`${action.id ?? action.capability}-${action.label ?? ''}`} size="sm" variant="secondary" disabled={busy} onClick={() => press(action, target)}>
        {labelOf(action, capability)}
      </Button>
    )];
  });

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!list || items.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const index = Math.max(0, items.findIndex((candidate) => candidate.id === item?.id));
    const nextIndex = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    setSelected((now) => ({ ...now, [list.id]: items[nextIndex]!.id }));
    listRef.current?.querySelectorAll<HTMLButtonElement>('.gv-row__main')[nextIndex]?.focus();
  };

  const lost = stream.status === 'paused' || stream.status === 'ended';
  const placeWide = buttonsFor(placeActions(place), undefined);
  const whole = list ? buttonsFor(wholeActions(place, list.id), undefined) : [];
  const forItem = list && item ? buttonsFor(itemActions(place, list.id, item), item) : [];
  const greyedItem = item ? greyed('item', item) : null;
  const pane = list ? paneOf(list) : undefined;
  const Twin = pane ? PLACE_PANES[pane] : undefined;

  const tabs = shown.length > 1 ? (
    phone || shown.length > 6 ? (
      <Select
        aria-label={`${place.title}: lists`}
        value={list?.id ?? ''}
        onChange={onOpenList}
        options={shown.map((candidate) => ({ value: candidate.id, label: `${candidate.label} (${countedItems(lists.stateOf(place, candidate).items)})` }))}
      />
    ) : (
      <div className="place-tabs" role="tablist" aria-label={`${place.title}: lists`}>
        {shown.map((candidate) => {
          const count = countedItems(lists.stateOf(place, candidate).items);
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === list?.id}
              className="place-tabs__tab"
              onClick={() => onOpenList(candidate.id)}
            >
              {candidate.label}
              {count > 0 ? <span className="place-tabs__count">{count}</span> : null}
            </button>
          );
        })}
      </div>
    )
  ) : null;

  const listPane = list && state ? (
    <div ref={listRef} className="place-list" onKeyDown={onListKey}>
      {/* The place's own actions, then the ones on this tab's kind of thing: a row that wraps, never the page title's. */}
      {placeWide.length + whole.length > 0 ? <div className="place-toolbar" aria-label="Actions">{placeWide}{whole}</div> : null}
      {greyed('place')}
      {greyed('whole')}
      {state.status === 'failed' ? (
        <div className="dv-notice dv-notice--warn place-notice" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p>{`Could not read ${list.noun}: ${state.reason ?? 'no reason was given'}.`.replace(/\.\.$/, '.')}</p>
            <p>{state.unreachable ? 'It is read again by itself when the daemon answers.' : 'It is read again by itself when it changes.'}</p>
            <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={() => lists.readPlace(place)}>Read again</Button>
          </div>
        </div>
      ) : null}
      {!state.read && state.status === 'reading' ? (
        <SkeletonRows count={4} label={`Reading ${list.noun}`} />
      ) : items.length === 0 && state.status !== 'failed' ? (
        <EmptyState icon={<Inbox />}>{list.empty}</EmptyState>
      ) : (
        <RowList aria-label={list.label}>
          {items.map((candidate) => {
            const row = rowOf(list, candidate);
            const mark = row.mark;
            return (
              <Row
                key={candidate.id}
                className="place-row"
                title={plainText(row.title)}
                leading={mark ? <StatusDot tone={MARK_TONES[mark]} srLabel={MARK_WORDS[mark]} /> : undefined}
                trailing={row.right ? <span className="place-row__right">{plainText(row.right)}</span> : undefined}
                selected={candidate.id === item?.id}
                onSelect={() => { setSelected((now) => ({ ...now, [list.id]: candidate.id })); setDetailOpen(true); }}
              />
            );
          })}
        </RowList>
      )}
    </div>
  ) : (
    <EmptyState icon={<Compass />}>Everything in this place is kept by the terminal program you work in, so it opens there.</EmptyState>
  );

  const detailPane = list && item ? (
    <DetailPane
      title={plainText(rowOf(list, item).title)}
      meta={rowOf(list, item).right ? plainText(rowOf(list, item).right ?? '') : undefined}
      onClose={() => { setSelected((now) => ({ ...now, [list.id]: undefined })); setDetailOpen(false); }}
      footer={forItem.length > 0 || greyedItem ? (
        <>
          {forItem.length > 0 ? <div className="place-actions" aria-label="Actions">{forItem}</div> : null}
          {greyedItem}
        </>
      ) : undefined}
    >
      {Twin ? <Twin item={item} /> : <DetailLines lines={detailOf(list, item)} />}
    </DetailPane>
  ) : undefined;

  return (
    <div className="places-main">
      <DataPage
        title={place.title}
        description={PLACE_GROUPS.find((row) => row.group === place.group)?.line}
        action={onBack ? <BackButton onBack={onBack} /> : undefined}
        filters={(
          <>
            {phone ? <ProjectChooser projects={projects} /> : null}
            {tabs}
            <RicherLinks views={RICHER_VIEWS[place.id] ?? []} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />
          </>
        )}
      >
        <div className="place-body">
          {outcome ? (
            <div className="place-outcome" data-tone={outcome.tone} role="status" aria-live="polite">
              <p>{outcome.text}</p>
              {outcome.undo ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => press(outcome.undo!.action, outcome.undo!.item)}>
                  {`Undo: ${outcome.undo.label.toLowerCase()}`}
                </Button>
              ) : null}
            </div>
          ) : <div className="place-outcome" role="status" aria-live="polite" data-empty="" />}
          {lost ? (
            <p className="place-stale" role="status">These lists may be out of date: live updates from the daemon stopped. They are read again by themselves when it answers.</p>
          ) : null}
          {elsewhere.length > 0 ? (
            <p className="place-elsewhere">{`${elsewhere.join(', ')}: kept by the terminal program you work in, so ${elsewhere.length === 1 ? 'it opens' : 'they open'} there.`}</p>
          ) : null}
          <ListDetail
            list={listPane}
            detail={detailPane}
            detailOpen={open}
            onCloseDetail={() => { setDetailOpen(false); if (list) setSelected((now) => ({ ...now, [list.id]: undefined })); }}
            listLabel={list?.label ?? place.title}
            detailLabel={item && list ? plainText(rowOf(list, item).title) : place.title}
            backLabel={list?.label ?? 'Back'}
          />
        </div>
      </DataPage>
      {form ? (
        <PlaceForm
          request={form.request}
          onClose={() => setForm(undefined)}
          onSubmit={(values, names) => {
            const { action, item: target, request } = form;
            setForm(undefined);
            void run(action, request.capability, values, names, target, undefined);
          }}
        />
      ) : null}
      {reveal ? <RevealPane reveal={reveal} onClose={() => setReveal(undefined)} /> : null}
      {result && !reveal ? <ResultPane result={result} onClose={() => setResult(undefined)} /> : null}
      {confirm.element}
    </div>
  );
}
