/**
 * The daemon's services are merged property by property, never by spreading: a spread reads every getter of the graph
 * it copies, and a getter opens what it guards (the graph's on-demand code index, `runtime-graph.ts`
 * `codeIndexStore`), so spreading the graph opened a code index for the daemon's own folder, which is no project.
 * Each own property of `base`, then of `extra`, is defined on a new object as it is: a getter stays a getter.
 */
export function mergeKeepingGetters<Base extends object, Extra extends object>(base: Base, extra: Extra): Omit<Base, keyof Extra> & Extra {
  const merged = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base));
  return Object.defineProperties(merged, Object.getOwnPropertyDescriptors(extra)) as Omit<Base, keyof Extra> & Extra;
}
