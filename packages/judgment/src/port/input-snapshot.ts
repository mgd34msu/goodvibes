import { toJson, type JudgmentRequest, type Questions } from './types.ts';

type Input<Q extends Questions> = Pick<JudgmentRequest<Q>, 'state' | 'questions' | 'sharedContext' | 'withoutSharedContext'>;
// Questions may outlive a call. Their provenance must not keep its private
// state alive: a collected snapshot simply takes the ordinary capture path.
const recordedInputs = new WeakMap<object, WeakRef<Input<Questions>>>();

const sameNames = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((name, index) => name === right[index]));

/**
 * The questions asked without the shared context, as data: the names of
 * questions this request asks, each once, in the order given. None (or no
 * shared context to leave out) is no list.
 */
function captureWithout(value: unknown, questions: unknown, sharedContext: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')
    || new Set(value).size !== value.length
    || questions === null || typeof questions !== 'object' || value.some(name => !Object.hasOwn(questions, name as string))) {
    throw new TypeError('questions asked without the shared context must be names of this request\'s questions');
  }
  return sharedContext === undefined || value.length === 0 ? undefined : [...value as string[]];
}

/** Capture data only. Provenance never transfers signals, hooks, settings or authority.
 * A recorder's genuine frozen pair can cross a new request envelope without a
 * second full JSON round trip. Frozen lookalikes and replaced members cannot.
 * The shared context is text; an empty one is no context.
 */
export function captureJudgmentInput<Q extends Questions>(request: Input<Q>, options: { readonly immutable?: boolean } = {}): Input<Q> {
  const state = request.state, questions = request.questions, shared: unknown = request.sharedContext;
  if (shared !== undefined && typeof shared !== 'string') throw new TypeError('a shared context must be text');
  const sharedContext = shared || undefined;
  const withoutSharedContext = captureWithout(request.withoutSharedContext, questions, sharedContext);
  const known = questions !== null && typeof questions === 'object' ? recordedInputs.get(questions)?.deref() : undefined;
  if (known && known.questions === questions && Object.is(known.state, state) && known.sharedContext === sharedContext
    && sameNames(known.withoutSharedContext, withoutSharedContext)) return known as Input<Q>;
  const input = toJson({
    state, questions,
    ...(sharedContext === undefined ? {} : { sharedContext }),
    ...(withoutSharedContext === undefined ? {} : { withoutSharedContext }),
  }) as unknown as Input<Q>;
  if (options.immutable) {
    const pending: object[] = [input];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      for (const value of Object.values(node)) if (value !== null && typeof value === 'object') pending.push(value);
      Object.freeze(node);
    }
    if (input.questions !== null && typeof input.questions === 'object') recordedInputs.set(input.questions, new WeakRef(input));
  }
  return input;
}
