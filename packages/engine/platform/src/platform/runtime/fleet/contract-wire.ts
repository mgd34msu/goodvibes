/**
 * How contract rows travel between the daemon and a client.
 *
 * In process, every contract, group and unit node points at the one contract
 * view. On the wire only the contract node carries that view; a group or unit
 * node carries its own group or unit and the contract's id, and the receiving
 * client joins the view back from the contract node in the same snapshot. A
 * snapshot's size then grows with the contract once, not once per group and
 * unit.
 */
import type { ProcessNode } from './types.js';
import { contractNodeId } from './adapters/contract.js';

/** The `raw` a group or unit node carries on the wire. */
interface WireContractPartRaw {
  readonly contractId: string;
  readonly group?: unknown;
  readonly unit?: unknown;
}

/** The `raw` of a contract, group or unit node as it leaves the daemon. */
export function contractRawForWire(node: ProcessNode): unknown {
  if (node.kind === 'contract') return node.raw;
  const raw = node.raw as { contract?: { id?: unknown }; group?: unknown; unit?: unknown } | undefined;
  const contractId = raw?.contract?.id;
  if (typeof contractId !== 'string') return undefined;
  if (node.kind === 'contract-group') return { contractId, group: raw?.group } satisfies WireContractPartRaw;
  if (node.kind === 'contract-unit') return { contractId, unit: raw?.unit } satisfies WireContractPartRaw;
  return undefined;
}

/**
 * Give each group and unit node of a received snapshot its contract view back,
 * from the contract node in the same snapshot. A node whose contract node is
 * not in the snapshot (a capped or filtered answer) keeps its part without the
 * view, so a reader that needs the view finds none rather than a guess.
 */
export function joinWireContractViews(nodes: readonly ProcessNode[]): readonly ProcessNode[] {
  let contracts: Map<string, unknown> | undefined;
  return nodes.map((node) => {
    if (node.kind !== 'contract-group' && node.kind !== 'contract-unit') return node;
    const raw = node.raw as Partial<WireContractPartRaw> & { contract?: unknown } | undefined;
    if (!raw || typeof raw.contractId !== 'string' || raw.contract !== undefined) return node;
    contracts ??= new Map(nodes.filter((candidate) => candidate.kind === 'contract').map((candidate) => [candidate.id, candidate.raw]));
    const contract = contracts.get(contractNodeId(raw.contractId));
    if (contract === undefined) return node;
    return { ...node, raw: { ...raw, contract } };
  });
}
