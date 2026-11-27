/**
 * A piece of work the daemon runs, in plain words: what it is, where it stands, what it waits for, what it changed.
 * The run's own records (ids, revisions, receipts) are not shown: they say nothing a person acts on.
 */
import type { ReactNode } from 'react';
import { DetailSection } from '../../components/data-view/DataView';
import type { ContractRecord } from './ContractTree';

function Text({ children }: { children: ReactNode }) {
  return <p className="contract-tree__text">{children}</p>;
}

const STANDING: Readonly<Record<string, string>> = {
  queued: 'waiting to start', planning: 'its plan is being written', running: 'running', judging: 'its result is being checked',
  fixing: 'a part is being fixed', 'awaiting-owner': 'waiting for you', committing: 'its result is being put in the project',
  passed: 'done', failed: 'failed', cancelled: 'stopped',
};

/** The first line of a question: what the work waits for, in its own words. */
const firstLine = (text: string): string => text.split('\n')[0]!.trim();

export function NativeContractDetails({ contract }: { contract: ContractRecord; onShowInputFiles?: (() => void) | undefined }) {
  const { nativeSource, nativeWaiting, inputSnapshot } = contract;
  const goal = nativeSource?.goal || contract.goal;
  const criteria = nativeSource?.criteria ?? [];
  const waitsFor = contract.escalations.filter((entry) => entry.resolvedAt === undefined).map((entry) => firstLine(entry.question)).filter(Boolean);
  const retrying = nativeWaiting?.requests.length ?? 0;
  const changed = [...new Set(contract.units.flatMap((unit) => unit.touchedPaths))].sort();
  return <>
    <DetailSection title="What the work is">
      <Text>{goal || 'Not recorded.'}</Text>
      {criteria.length > 0 && <ol className="contract-tree__list contract-tree__ordered" aria-label="Done when">
        {criteria.map((criterion, i) => <li key={i}><Text>{criterion}</Text></li>)}
      </ol>}
    </DetailSection>
    <DetailSection title="Where it stands">
      <Text>{contract.statusLine || `It is ${STANDING[contract.status] ?? contract.status}.`}</Text>
    </DetailSection>
    <DetailSection title="What it waits for">
      {waitsFor.length > 0
        ? waitsFor.map((line, i) => <Text key={i}>{line}</Text>)
        : retrying > 0
          ? <Text>{retrying === 1 ? 'A call to the model did not go through; it is tried again.' : `${retrying} calls to the model did not go through; they are tried again.`}</Text>
          : <Text>Nothing: it waits for no one.</Text>}
    </DetailSection>
    <DetailSection title="What it changed">
      {changed.length > 0
        ? <ul className="contract-tree__list" aria-label="Files it changed">{changed.map((path) => <li key={path}><Text>{path}</Text></li>)}</ul>
        : <Text>No files so far.</Text>}
      {inputSnapshot?.dirty === true && <Text>It started from your files as they were, your uncommitted edits included; those stay yours.</Text>}
    </DetailSection>
  </>;
}
