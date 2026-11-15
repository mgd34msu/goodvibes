/** Shared memory verb aliases and argument rewriting; product handlers retain storage/confirmation authority. */
export function createRecallDispatch<Context>(ports: {
  readonly add: (args: string[], context: Context) => unknown;
  readonly search: (args: string[], context: Context) => unknown;
  readonly vector: (args: string[], context: Context) => unknown;
  readonly capture: (args: string[], context: Context) => unknown;
  readonly get: (args: string[], context: Context) => unknown;
  readonly queue: (args: string[], context: Context) => unknown;
  readonly review: (args: string[], context: Context) => unknown;
  readonly explain: (args: string[], context: Context) => unknown;
  readonly promote: (args: string[], context: Context) => unknown;
  readonly link: (args: string[], context: Context) => unknown;
  readonly list: (args: string[], context: Context) => unknown;
  readonly remove: (args: string[], context: Context) => unknown;
  readonly export: (args: string[], context: Context) => unknown;
  readonly import: (args: string[], context: Context) => unknown;
  readonly handoffExport: (args: string[], context: Context) => unknown;
  readonly handoffInspect: (args: string[], context: Context) => unknown;
  readonly handoffImport: (args: string[], context: Context) => unknown;
}) {
  // `stale <id> <reason words> [--by <name>]`: the words after the id are the reason, read by the review grammar.
  const reviewAs = (state: 'stale' | 'contradicted') => (args: string[], context: Context): unknown => {
    const [id = '', ...rest] = args;
    const reasonFirst = rest.length > 0 && !rest[0]!.startsWith('--');
    return ports.review([id, state, ...(reasonFirst ? ['--reason'] : []), ...rest], context);
  };
  const handlers = new Map<string, (args: string[], context: Context) => unknown>([
    ['add', ports.add],
    ['search', ports.search],
    ['find', ports.search],
    ['vector', ports.vector],
    ['vectors', ports.vector],
    ['capture', ports.capture],
    ['get', ports.get],
    ['show', ports.get],
    ['queue', ports.queue],
    ['review', ports.review],
    ['stale', reviewAs('stale')],
    ['contradict', reviewAs('contradicted')],
    ['explain', ports.explain],
    ['promote', ports.promote],
    ['link', ports.link],
    ['list', ports.list],
    ['ls', ports.list],
    ['remove', ports.remove],
    ['delete', ports.remove],
    ['rm', ports.remove],
    ['export', ports.export],
    ['import', ports.import],
    ['handoff-export', ports.handoffExport],
    ['share', ports.handoffExport],
    ['handoff-inspect', ports.handoffInspect],
    ['handoff-import', ports.handoffImport],
  ]);
  return (sub: string | undefined, rest: string[], context: Context): boolean | Promise<boolean> => {
    const handler = sub === undefined ? undefined : handlers.get(sub === 'contradicted' ? 'contradict' : sub);
    if (!handler) return false;
    const result = handler(rest, context);
    return result instanceof Promise ? result.then(() => true) : true;
  };
}
