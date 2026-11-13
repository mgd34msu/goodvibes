/**
 * One declared lifecycle: every state, and the states each can move to.
 *
 * A lifecycle that exists only as assignments spread over a module can be
 * read three ways: by the person changing it, who has to find every
 * assignment to learn what is legal; by the person using the product, who is
 * shown whatever state a missed case left behind; and by an agent, which is
 * told "failed" with nothing about what it may do next. Declaring the table
 * once answers all three from the same place: `Record<S, …>` makes a new state
 * a compile error until its row exists, an illegal move is refused where it is
 * attempted, and the refusal names the moves that are legal.
 *
 * This is pure data and pure functions. It holds no current state and has no
 * side effects; the owner of a record still stores its state and decides what
 * to do with a refusal.
 */

/** For every state, the states it may move to. A state with no targets is terminal. */
export type LifecycleTransitions<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Whether one move is legal, and when it is not, why and what would be. */
export type LifecycleCheck<S extends string> =
  | { readonly ok: true; readonly from: S; readonly to: S }
  | { readonly ok: false; readonly from: S; readonly to: S; readonly reason: string; readonly allowed: readonly S[] };

/** Thrown by {@link LifecycleMachine.assert}. Carries the same facts as a refused {@link LifecycleCheck}. */
export class IllegalLifecycleTransitionError<S extends string = string> extends Error {
  readonly machine: string;
  readonly from: S;
  readonly to: S;
  readonly allowed: readonly S[];

  constructor(machine: string, from: S, to: S, allowed: readonly S[], reason: string) {
    super(reason);
    this.name = 'IllegalLifecycleTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

export interface LifecycleMachine<S extends string> {
  /** What this lifecycle is of, as it should read in a message: "task", "MCP server". */
  readonly name: string;
  /** Every state, in declaration order. */
  readonly states: readonly S[];
  /** The declared table. */
  readonly transitions: LifecycleTransitions<S>;
  /** Narrows an untrusted value (a persisted record, a wire payload) to a state of this lifecycle. */
  isState(value: unknown): value is S;
  /** Whether `from` may move to `to`. A state may move to itself only where the table says so. */
  can(from: S, to: S): boolean;
  /** The states reachable from `from` in one move. Empty for a terminal state. */
  next(from: S): readonly S[];
  /** True when nothing is reachable from `state`. */
  isTerminal(state: S): boolean;
  /** {@link can}, with the reason and the legal moves when it is refused. */
  check(from: S, to: S): LifecycleCheck<S>;
  /** Throws {@link IllegalLifecycleTransitionError} when the move is not legal. */
  assert(from: S, to: S): void;
  /** The whole table as text, one state per line, for documentation and tool descriptions. */
  describe(): string;
}

/**
 * Declares a lifecycle. `transitions` must have a row for every state; the
 * type enforces that for a literal union, and a target that is not itself a
 * row is rejected here, at module load, rather than at the first move.
 */
export function defineLifecycle<S extends string>(name: string, transitions: LifecycleTransitions<S>): LifecycleMachine<S> {
  const states = Object.freeze(Object.keys(transitions) as S[]);
  const known = new Set<string>(states);
  const table = new Map<S, readonly S[]>();
  for (const state of states) {
    const targets = Object.freeze([...transitions[state]]);
    for (const target of targets) {
      if (!known.has(target)) throw new Error(`${name} lifecycle: '${state}' names '${target}', which is not a declared state`);
    }
    table.set(state, targets);
  }
  const frozen = Object.freeze(Object.fromEntries(table)) as LifecycleTransitions<S>;

  const next = (from: S): readonly S[] => table.get(from) ?? [];
  const can = (from: S, to: S): boolean => next(from).includes(to);
  const check = (from: S, to: S): LifecycleCheck<S> => {
    if (can(from, to)) return { ok: true, from, to };
    const allowed = next(from);
    const reason = !known.has(from)
      ? `${name} is in an unknown state '${String(from)}'`
      : !known.has(to)
        ? `${name} has no state '${String(to)}'`
        : allowed.length === 0
          ? `${name} is ${from}, which is final; it cannot become ${to}`
          : `${name} is ${from} and cannot become ${to}; from ${from} it can become ${allowed.join(', ')}`;
    return { ok: false, from, to, reason, allowed };
  };

  return Object.freeze({
    name,
    states,
    transitions: frozen,
    isState: (value: unknown): value is S => typeof value === 'string' && known.has(value),
    can,
    next,
    isTerminal: (state: S) => next(state).length === 0,
    check,
    assert: (from: S, to: S) => {
      const result = check(from, to);
      if (!result.ok) throw new IllegalLifecycleTransitionError(name, from, to, result.allowed, result.reason);
    },
    describe: () => states.map(state => `${state} → ${next(state).length ? next(state).join(' | ') : '(final)'}`).join('\n'),
  });
}
