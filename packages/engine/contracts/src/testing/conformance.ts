/**
 * testing/conformance.ts, the descriptor/handler drift gate, shipped from the
 * contracts package so every consuming front-end (terminal-shell, the tui and
 * agent forks, the webui) runs the SAME gate against its own composition rather
 * than keeping a divergent local copy.
 *
 * A gateway method catalog registers DESCRIPTORS (the contract surface) and,
 * separately, HANDLERS (what actually answers an invoke). A descriptor with no
 * attached handler answers 501 "Gateway method is not invokable" over both
 * websocket and HTTP invoke, a whole verb family can look present in the
 * contract yet be dead. That is the exact regression this gate catches: run
 * `assertEveryDescriptorHasHandler` against a FULLY-composed catalog in the
 * consumer's test suite and it fails loudly the moment any registered
 * descriptor is left handler-less.
 *
 * The catalog is accepted through a narrow structural view, so a consumer can
 * pass its concrete GatewayMethodCatalog (or any equivalent) without the
 * contracts package depending on the catalog's full type.
 */

/** The minimal catalog surface this gate reads. GatewayMethodCatalog satisfies it structurally. */
export interface GatewayCatalogConformanceView {
  /** Every registered method descriptor. Only the `id` field is read here. */
  list(): ReadonlyArray<{ readonly id: string }>;
  /** True when the descriptor with this id has a handler attached. */
  hasHandler(id: string): boolean;
}

export interface ConformanceOptions {
  /**
   * Restrict the check to these descriptor ids. A hand-kept list misses any
   * family nobody added to it; prefer a full sweep with `ignoreIds`.
   */
  readonly onlyIds?: readonly string[];
  /**
   * Descriptor ids allowed to have no handler: those a composition answers
   * another way (a dedicated HTTP route module) or declares `invokable: false`.
   * Derive the set from the descriptors, not by hand, and sweep the rest.
   */
  readonly ignoreIds?: readonly string[];
}

/**
 * Return the sorted ids of every registered descriptor that has no attached
 * handler (the 501 set), honoring `onlyIds` / `ignoreIds`. Empty means every
 * checked descriptor is invokable.
 */
export function findMethodsMissingHandlers(
  catalog: GatewayCatalogConformanceView,
  options: ConformanceOptions = {},
): string[] {
  const only = options.onlyIds ? new Set(options.onlyIds) : null;
  const ignore = options.ignoreIds ? new Set(options.ignoreIds) : null;
  return catalog
    .list()
    .map((descriptor) => descriptor.id)
    .filter((id) => (only ? only.has(id) : true))
    .filter((id) => (ignore ? !ignore.has(id) : true))
    .filter((id) => !catalog.hasHandler(id))
    .sort();
}

/**
 * Assert every registered descriptor (honoring `onlyIds` / `ignoreIds`) has a
 * handler attached. Throws with the full list of offending ids when any is
 * handler-less. This is the consumer-facing gate: call it in your CI against
 * the same catalog your daemon serves.
 */
export function assertEveryDescriptorHasHandler(
  catalog: GatewayCatalogConformanceView,
  options: ConformanceOptions = {},
): void {
  const missing = findMethodsMissingHandlers(catalog, options);
  if (missing.length === 0) return;
  throw new Error(
    `Gateway catalog has ${missing.length} descriptor(s) with no attached handler, `
    + `each answers 501 "Gateway method is not invokable" over websocket and HTTP invoke. `
    + `Attach handlers together with the descriptors at composition time. Offending ids:\n  `
    + missing.join('\n  '),
  );
}
