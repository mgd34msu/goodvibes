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
  return async (sub: string | undefined, rest: string[], context: Context): Promise<boolean> => {
    switch (sub) {
      case 'add':
        await ports.add(rest, context);
        break;
      case 'search':
      case 'find':
        await ports.search(rest, context);
        break;
      case 'vector':
      case 'vectors':
        ports.vector(rest, context);
        break;
      case 'capture':
        await ports.capture(rest, context);
        break;
      case 'get':
      case 'show':
        await ports.get(rest, context);
        break;
      case 'queue':
        await ports.queue(rest, context);
        break;
      case 'review':
        await ports.review(rest, context);
        break;
      case 'stale':
        await ports.review([rest[0] ?? '', 'stale', '--reason', ...rest.slice(1)], context);
        break;
      case 'contradict':
      case 'contradicted':
        await ports.review([rest[0] ?? '', 'contradicted', '--reason', ...rest.slice(1)], context);
        break;
      case 'explain':
        await ports.explain(rest, context);
        break;
      case 'promote':
        await ports.promote(rest, context);
        break;
      case 'link':
        await ports.link(rest, context);
        break;
      case 'list':
      case 'ls':
        await ports.list(rest, context);
        break;
      case 'remove':
      case 'delete':
      case 'rm':
        await ports.remove(rest, context);
        break;
      case 'export':
        await ports.export(rest, context);
        break;
      case 'import':
        await ports.import(rest, context);
        break;
      case 'handoff-export':
      case 'share':
        await ports.handoffExport(rest, context);
        break;
      case 'handoff-inspect':
        ports.handoffInspect(rest, context);
        break;
      case 'handoff-import':
        await ports.handoffImport(rest, context);
        break;
      default:
        return false;
    }
    return true;
  };
}
