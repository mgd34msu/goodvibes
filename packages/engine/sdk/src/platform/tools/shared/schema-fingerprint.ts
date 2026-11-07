/** Exact top-level tool-result key sets for optional shape diagnostics. */

import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';

export interface SchemaFingerprintOptions {
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
}

/**
 * Checks the runtime capability gates explicitly supplied by the composition root.
 */
export function isSchemaFingerprintEnabled(options: SchemaFingerprintOptions = {}): boolean {
  return options.featureFlags?.isEnabled('output-schema-fingerprint') ?? false;
}

// ── Core fingerprinting ───────────────────────────────────────────────────────

/**
 * Canonical schema shape IDs per tool and output mode.
 *
 * The shape ID is the stable, human-readable identifier for what the schema
 * looks like. It encodes the tool name and mode
 * so that diagnostics can group / filter by shape without needing to know the
 * full key set.
 */
export const SCHEMA_SHAPE_IDS: Record<string, string> = {
  // find tool modes
  'find:files':      'find.files.v1',
  'find:content':    'find.content.v1',
  'find:symbols':    'find.symbols.v1',
  'find:references': 'find.references.v1',
  'find:structural': 'find.structural.v1',
  'find:multi':      'find.multi.v1',

  // analyze tool modes
  'analyze:impact':       'analyze.impact.v1',
  'analyze:dependencies': 'analyze.dependencies.v1',
  'analyze:dead_code':    'analyze.dead_code.v1',
  'analyze:security':     'analyze.security.v1',
  'analyze:coverage':     'analyze.coverage.v1',
  'analyze:bundle':       'analyze.bundle.v1',
  'analyze:preview':      'analyze.preview.v1',
  'analyze:diff':         'analyze.diff.v1',
  'analyze:surface':      'analyze.surface.v1',
  'analyze:breaking':     'analyze.breaking.v1',
  'analyze:semantic_diff':'analyze.semantic_diff.v1',
  'analyze:upgrade':      'analyze.upgrade.v1',
  'analyze:permissions':  'analyze.permissions.v1',
  'analyze:env_audit':    'analyze.env_audit.v1',
  'analyze:test_find':    'analyze.test_find.v1',

  // inspect tool modes
  'inspect:project':         'inspect.project.v1',
  'inspect:api':             'inspect.api.v1',
  'inspect:database':        'inspect.database.v1',
  'inspect:components':      'inspect.components.v1',
  'inspect:layout':          'inspect.layout.v1',
  'inspect:accessibility':   'inspect.accessibility.v1',
  'inspect:api_spec':        'inspect.api_spec.v1',
  'inspect:api_validate':    'inspect.api_validate.v1',
  'inspect:api_sync':        'inspect.api_sync.v1',
  'inspect:scaffold':        'inspect.scaffold.v1',
  'inspect:component_state': 'inspect.component_state.v1',
  'inspect:render_triggers': 'inspect.render_triggers.v1',
  'inspect:hooks':           'inspect.hooks.v1',
  'inspect:overflow':        'inspect.overflow.v1',
  'inspect:sizing':          'inspect.sizing.v1',
  'inspect:stacking':        'inspect.stacking.v1',
  'inspect:responsive':      'inspect.responsive.v1',
  'inspect:events':          'inspect.events.v1',
  'inspect:tailwind':        'inspect.tailwind.v1',
  'inspect:client_boundary': 'inspect.client_boundary.v1',
  'inspect:error_boundary':  'inspect.error_boundary.v1',
};

/**
 * Returns the canonical shape ID for a given tool and mode combination.
 * Falls back to `<tool>.<mode>.v1` for unknown combinations.
 */
export function getSchemaShapeId(tool: string, mode: string): string {
  const key = `${tool}:${mode}`;
  return SCHEMA_SHAPE_IDS[key] ?? `${tool}.${mode}.v1`;
}

/** Exact sorted field names, without hashing or truncation. */
export async function computeSchemaFingerprint(result: Record<string, unknown>): Promise<string> {
  return computeSchemaFingerprintSync(result);
}

/** The same representation in every runtime. */
export function computeSchemaFingerprintSync(result: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(result).sort());
}

// ── Result augmentation ───────────────────────────────────────────────────────

/**
 * Schema fingerprint metadata appended to tool results.
 */
export interface SchemaFingerprintMeta {
  /** Canonical shape ID (human-readable, e.g. `find.files.v1`). */
  schemaShapeId: string;
  /** JSON array of exact sorted top-level field names. */
  outputSchemaFingerprint: string;
}

/**
 * Append `_meta.outputSchemaFingerprint` to a result object when the feature
 * flag is enabled. Returns the original object unchanged when the flag is
 * disabled.
 *
 * @param result   The mode result object (plain, not yet JSON-stringified).
 * @param tool     Tool name: `'find'`, `'analyze'`, or `'inspect'`.
 * @param mode     The active output mode string (e.g. `'files'`, `'impact'`).
 * @returns        The augmented (or original) result object.
 */
export function appendSchemaFingerprint(
  result: Record<string, unknown>,
  tool: string,
  mode: string,
  options: SchemaFingerprintOptions = {},
): Record<string, unknown> {
  if (!isSchemaFingerprintEnabled(options)) {
    return result;
  }

  const shapeId = getSchemaShapeId(tool, mode);
  const fingerprint = computeSchemaFingerprintSync(result);

  const existingMeta =
    typeof result._meta === 'object' && result._meta !== null
      ? (result._meta as Record<string, unknown>)
      : undefined;

  return {
    ...result,
    _meta: {
      ...(existingMeta ?? {}),
      schemaShapeId: shapeId,
      outputSchemaFingerprint: fingerprint,
    } satisfies SchemaFingerprintMeta,
  };
}
