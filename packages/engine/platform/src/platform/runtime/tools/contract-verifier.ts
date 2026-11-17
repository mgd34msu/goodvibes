/**
 * Tool Contract Verifier, contract checks for registered tools.
 *
 * Five contract dimensions:
 * 1. Schema validity: checked by ToolRegistry.register for every tool, so a
 *    tool with a malformed schema is refused where it enters.
 * 2. Permission class: the category on the tool's definition (an engine tool's
 *    comes from ENGINE_TOOL_CATEGORIES), the one the gate classes its calls by.
 * 3-5. Timeout/cancellation, output policy and idempotency: metadata a tool
 *    object may carry beside its definition (ToolContractMetadata); a tool
 *    without it is not checked on those dimensions.
 *
 * Every check is code except one: whether the description explains what the
 * tool does and when to use it is read by Jev for a single tool
 * (`verify`, one request per distinct description, remembered). Verifying
 * every tool (`verifyAll`) runs the code checks only.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../decision-policy.js';
import { PERMISSION_CATEGORIES, toolCategoryOf, type Tool, type ToolDefinition } from '../../types/tools.js';
import { descriptionQuality } from './batteries/description-quality.js';
import { TOOL_CLASS_BY_CATEGORY } from './output-policy.js';

/** Contract metadata a tool object may carry beside its definition. */
export interface ToolContractMetadata {
  /** The tool's category, which selects its output policy. */
  readonly category?: 'read' | 'write' | 'execute' | 'delegate' | 'network' | undefined;
  /** Per-step timeouts in milliseconds. */
  readonly phaseTimeouts?: Readonly<Record<string, number>> | undefined;
  /** Whether the tool stops when its abort signal fires. */
  readonly cancellable?: boolean | undefined;
  /** Whether repeating a call with the same arguments is safe. */
  readonly idempotent?: unknown;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Tool categories that produce side effects and require idempotency declarations. */
const SIDE_EFFECTING_CATEGORIES: ReadonlySet<string> = new Set([
  'write',
  'execute',
  'network',
  'delegate',
]);

/** Valid JSON Schema primitive types. */
const VALID_JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of a single contract violation. */
export type ContractViolationSeverity = 'error' | 'warn';

/** A single contract check that failed or produced a warning. */
export interface ContractViolation {
  /** Which of the 5 contract dimensions this belongs to. */
  readonly dimension:
    | 'schema'
    | 'timeout-cancellation'
    | 'permission-class'
    | 'output-policy'
    | 'idempotency';
  /** Severity of the violation. */
  readonly severity: ContractViolationSeverity;
  /** Human-readable explanation of what is wrong. */
  readonly message: string;
  /** Optional hint for how to fix the violation. */
  readonly hint?: string | undefined;
}

/** Full contract verification result for a single tool. */
export interface ContractVerificationResult {
  /** Tool name. */
  readonly toolName: string;
  /** Whether the tool passed all required (error-level) checks. */
  readonly passed: boolean;
  /** All violations found. May include warnings even if passed. */
  readonly violations: readonly ContractViolation[];
  /** Unix timestamp (ms) when this result was produced. */
  readonly verifiedAt: number;
  /** Whether the tool carries contract metadata (a category on the tool object). */
  readonly isPhasedTool: boolean;
  /** Structural checks never certify the semantic quality of a description. */
  readonly descriptionQuality?: 'assessed' | 'not-evaluated';
  readonly provenance?: 'classic';
}

/**
 * Options controlling which contract checks run and how strictly.
 */
export interface ContractVerifierOptions {
  /**
   * Whether to treat missing idempotency declarations on side-effecting tools
   * as errors (true, default) or warnings (false).
   *
   * Set to false while tightening tool metadata requirements incrementally.
   */
  strictIdempotency?: boolean | undefined;
  /**
   * Whether to treat missing permission class metadata as errors (true) or
   * warnings (false, default for tool definitions that omit that metadata).
   */
  strictPermissionClass?: boolean | undefined;
}

// ── Dimension checkers ────────────────────────────────────────────────────────

/**
 * Check 1, Schema validity.
 *
 * Validates that the tool definition's parameters object is a structurally
 * sound JSON Schema. Does not make network calls or validate against a meta-schema;
 * checks for the most common structural mistakes that cause LLM call failures.
 */
export function checkToolSchema(def: ToolDefinition, options: {
  /**
   * Whether a schema with no `type` is an error. Registration passes false: an
   * untyped schema is reported by verification, not refused where it enters.
   */
  readonly requireType?: boolean | undefined;
} = {}): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const params = def.parameters;

  if (!params || typeof params !== 'object') {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters must be a non-null object (JSON Schema).`,
      hint: 'Set parameters to at least { type: "object", properties: {} }.',
    });
    return violations;
  }

  // Must have a type field
  if (!('type' in params)) {
    if (options.requireType !== false) violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters schema missing required 'type' field.`,
      hint: 'Add type: "object" to your parameters schema.',
    });
  } else if (!VALID_JSON_SCHEMA_TYPES.has((params as Record<string, unknown>).type as string)) {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters schema has invalid 'type' value '${(params as Record<string, unknown>).type}'.`,
      hint: `Use one of: ${[...VALID_JSON_SCHEMA_TYPES].join(', ')}.`,
    });
  }

  // If type is object, should have properties
  if ((params as Record<string, unknown>).type === 'object' && !('properties' in params)) {
    violations.push({
      dimension: 'schema',
      severity: 'warn',
      message: `Tool '${def.name}': object schema has no 'properties' field.`,
      hint: 'Add a properties object even if empty to clarify tool interface.',
    });
  }

  // Name must be non-empty and safe for LLM function naming
  if (!def.name || typeof def.name !== 'string' || def.name.trim().length === 0) {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool has an empty or missing name.`,
      hint: 'Set a non-empty name string on the tool definition.',
    });
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(def.name)) {
    violations.push({
      dimension: 'schema',
      severity: 'warn',
      message: `Tool '${def.name}': name contains characters that may be rejected by some LLM providers.`,
      hint: 'Use only letters, digits, underscores, or hyphens, starting with a letter or underscore.',
    });
  }

  // Description must be present; whether it explains the tool is read by checkDescription
  if (!def.description || typeof def.description !== 'string') {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': missing or non-string description.`,
      hint: 'Provide a clear description so the LLM knows when to call this tool.',
    });
  }

  return violations;
}

/** Decision site for the description reading. */
export const TOOL_DESCRIPTION_SITE = 'runtime.tools.contract-verifier';

/** Readings of each distinct description, so tools sharing a description and repeat verifications ask once. */
const MEMO_LIMIT = 512;
const descriptionMemo = new Map<string, Promise<boolean>>();

/** Whether Jev reads `description` as explaining what the tool does and when to use it. */
function descriptionExplains(description: string): Promise<boolean> {
  const known = descriptionMemo.get(description);
  if (known !== undefined) return known;
  const reading = (async () => {
    const run = await descriptionQuality.run(judgmentPort(TOOL_DESCRIPTION_SITE), description, { site: TOOL_DESCRIPTION_SITE });
    return run.readings.explains.verdict === 'yes';
  })();
  if (descriptionMemo.size >= MEMO_LIMIT) descriptionMemo.delete(descriptionMemo.keys().next().value!);
  descriptionMemo.set(description, reading);
  reading.catch(() => descriptionMemo.delete(description));
  return reading;
}

/** Forgets remembered description readings; for tests that swap the judgment port. */
export function forgetDescriptionReadings(): void {
  descriptionMemo.clear();
}

/**
 * Check 1b, Description quality. A description that does not explain what the
 * tool does and when to use it is a warning. A missing description is already
 * a schema error, and a blank one explains nothing, so neither is read.
 */
async function checkDescription(def: ToolDefinition): Promise<ContractViolation[]> {
  if (!def.description || typeof def.description !== 'string') return [];
  if (def.description.trim().length > 0 && await descriptionExplains(def.description)) return [];
  return [{
    dimension: 'schema',
    severity: 'warn',
    message: `Tool '${def.name}': description does not clearly explain what the tool does and when to use it.`,
    hint: 'Say what the tool does and in which situations the LLM should call it.',
  }];
}

/**
 * Check 2, Timeout and cancellation semantics.
 *
 * For a tool with metadata: validates that its timeouts are positive integers and that
 * long-running tool categories declare cancellable=true.
 */
function checkTimeoutCancellation(phased: ToolContractMetadata, toolName: string): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (phased.phaseTimeouts !== undefined) {
    for (const [phase, ms] of Object.entries(phased.phaseTimeouts)) {
      if (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0) {
        violations.push({
          dimension: 'timeout-cancellation',
          severity: 'error',
          message: `Tool '${toolName}': phaseTimeouts['${phase}'] must be a positive integer (got ${JSON.stringify(ms)}).`,
          hint: 'Set phase timeouts to positive integer values in milliseconds.',
        });
      } else if (ms > 600_000) {
        violations.push({
          dimension: 'timeout-cancellation',
          severity: 'warn',
          message: `Tool '${toolName}': phaseTimeouts['${phase}'] = ${ms}ms exceeds 10 minutes.`,
          hint: 'Consider whether a timeout above 10 minutes is intentional. Use cancellable=true for long-running tools.',
        });
      }
    }
  }

  // Side-effecting tools should support cancellation to avoid dangling state
  if (phased.category !== undefined && SIDE_EFFECTING_CATEGORIES.has(phased.category)) {
    if (phased.cancellable === false) {
      violations.push({
        dimension: 'timeout-cancellation',
        severity: 'warn',
        message: `Tool '${toolName}' (category='${phased.category}') declares cancellable=false.`,
        hint: 'Side-effecting tools (write/execute/network/delegate) should support cancellation to prevent dangling state on abort.',
      });
    }
  }

  return violations;
}

/**
 * Check 3, Permission class: the category the gate classes the tool's calls
 * by, read from its definition. A tool that declares none is classed 'delegate'
 * (every call goes to the gate's full decision), which is reported.
 */
function checkPermissionClass(definition: ToolDefinition, strict: boolean): ContractViolation[] {
  const category = toolCategoryOf(definition);
  if (category !== undefined) return [];
  return [{
    dimension: 'permission-class',
    severity: strict ? 'error' : 'warn',
    message: `Tool '${definition.name}': no permission category declared; its calls are classed 'delegate'.`,
    hint: `Set category on the tool definition to one of: ${PERMISSION_CATEGORIES.join(', ')}.`,
  }];
}

/**
 * Check 4, Output policy alignment.
 *
 * For a tool with metadata: validates that its category maps to a known ToolClass
 * with a configured output policy. All default policies exist, but third-party
 * categories would fail this check.
 */
function checkOutputPolicy(phased: ToolContractMetadata, toolName: string): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (phased.category === undefined) {
    // Already flagged in permission-class check; skip to avoid duplicate messages
    return violations;
  }

  const toolClass = TOOL_CLASS_BY_CATEGORY[phased.category];
  if (toolClass === undefined) {
    violations.push({
      dimension: 'output-policy',
      severity: 'error',
      message: `Tool '${toolName}': category '${phased.category}' has no output policy mapping.`,
      hint: `Add a TOOL_CLASS_BY_CATEGORY entry or register a custom output policy for '${phased.category}'.`,
    });
  }

  return violations;
}

/** Check idempotency declarations on side-effecting tools.
 * Strict mode requires an explicit idempotent boolean on the tool object.
 */
function checkIdempotency(phased: ToolContractMetadata, toolName: string, strict: boolean): ContractViolation[] {
  const violations: ContractViolation[] = [];

  // Only applies to side-effecting categories
  if (phased.category === undefined || !SIDE_EFFECTING_CATEGORIES.has(phased.category)) {
    return violations;
  }

  if (!('idempotent' in phased) || phased.idempotent === undefined) {
    violations.push({
      dimension: 'idempotency',
      severity: strict ? 'error' : 'warn',
      message: `Tool '${toolName}' (category='${phased.category}') has no idempotency declaration.`,
      hint: 'Add idempotent: true|false to the tool to declare whether repeated calls with the same args are safe.',
    });
  } else if (typeof phased.idempotent !== 'boolean') {
    violations.push({
      dimension: 'idempotency',
      severity: 'error',
      message: `Tool '${toolName}': idempotent field must be boolean (got ${typeof phased.idempotent}).`,
      hint: 'Set idempotent to exactly true or false.',
    });
  }

  return violations;
}

// ── Main verifier ─────────────────────────────────────────────────────────────

/**
 * ToolContractVerifier, runs all 5 contract checks on a single tool.
 *
 * Usage:
 * ```ts
 * const verifier = new ToolContractVerifier();
 * const result = await verifier.verify(myTool);
 * if (!result.passed) {
 *   for (const v of result.violations.filter(v => v.severity === 'error')) {
 *     throw new Error(v.message);
 *   }
 * }
 * ```
 */
export class ToolContractVerifier {
  private readonly _opts: Required<ContractVerifierOptions>;

  constructor(opts: ContractVerifierOptions = {}) {
    this._opts = {
      strictIdempotency: opts.strictIdempotency ?? true,
      strictPermissionClass: opts.strictPermissionClass ?? false,
    };
  }

  /**
   * Verify a single tool against all 5 contract dimensions, including the
   * description reading.
   *
   * @param tool - The tool to verify.
   * @returns A ContractVerificationResult with all violations and a pass/fail flag.
   */
  async verify(tool: Tool): Promise<ContractVerificationResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      const structure = this.verifyStructure(tool);
      const description = tool.definition.description;
      // Missing and blank descriptions have native diagnostics in every mode.
      const needsReading = typeof description === 'string' && description.trim().length > 0;
      const described = needsReading
        ? await decisionOrClassic<ContractViolation[] | null>(() => checkDescription(tool.definition), () => null)
        : await checkDescription(tool.definition);
      return {
        ...structure,
        violations: [...structure.violations, ...(described ?? [])],
        descriptionQuality: needsReading && described !== null ? 'assessed' : 'not-evaluated',
        ...(isClassicOperation() ? { provenance: 'classic' as const } : {}),
        verifiedAt: Date.now(),
      };
    });
  }

  /**
   * Verify a single tool against every check that is code (all 5 dimensions,
   * without the description reading). Every error-level violation comes from
   * these checks.
   *
   * @param tool - The tool to verify.
   * @returns A ContractVerificationResult with all violations and a pass/fail flag.
   */
  verifyStructure(tool: Tool): ContractVerificationResult {
    const phased = tool as Tool & ToolContractMetadata;
    const isPhasedTool = 'category' in phased && phased.category !== undefined;

    const violations: ContractViolation[] = [
      ...checkToolSchema(tool.definition),
      ...checkTimeoutCancellation(phased, tool.definition.name),
      ...checkPermissionClass(tool.definition, this._opts.strictPermissionClass!),
      ...checkOutputPolicy(phased, tool.definition.name),
      ...checkIdempotency(phased, tool.definition.name, this._opts.strictIdempotency!),
    ];

    const passed = !violations.some((v) => v.severity === 'error');

    return {
      toolName: tool.definition.name,
      passed,
      violations,
      verifiedAt: Date.now(),
      isPhasedTool,
      descriptionQuality: 'not-evaluated',
    };
  }

  /**
   * Verify multiple tools at once, with the code checks only: a command over
   * every tool never waits on one decision-model request per description.
   * `verify` reads one tool's description.
   *
   * @param tools - Array of tools to verify.
   * @returns Map of tool name to verification result.
   */
  async verifyAll(tools: readonly Tool[]): Promise<Map<string, ContractVerificationResult>> {
    return new Map(tools.map((tool) => {
      const result = this.verifyStructure(tool);
      return [result.toolName, result] as const;
    }));
  }

  /**
   * Format a verification result as a human-readable diagnostic string.
   * Suitable for printing to the console or a diagnostics panel.
   *
   * @param result - The result to format.
   * @returns Multi-line formatted diagnostic string.
   */
  static formatResult(result: ContractVerificationResult): string {
    const lines: string[] = [];
    const status = result.passed ? 'PASS' : 'FAIL';
    const phasedNote = result.isPhasedTool ? ' [metadata]' : ' [basic]';
    lines.push(`[${status}] ${result.toolName}${phasedNote}`);

    if (result.violations.length === 0) {
      lines.push(result.descriptionQuality === 'not-evaluated'
        ? '  All structural contract checks passed.' : '  All contract checks passed.');
    } else {
      for (const v of result.violations) {
        const prefix = v.severity === 'error' ? '  [ERROR]' : '  [WARN] ';
        lines.push(`${prefix} [${v.dimension}] ${v.message}`);
        if (v.hint) {
          lines.push(`           Hint: ${v.hint}`);
        }
      }
    }

    if (result.descriptionQuality === 'not-evaluated') lines.push('  Description quality was not assessed (verify one tool by name to read it).');
    return lines.join('\n');
  }

  /**
   * Format a map of results (from verifyAll) as a human-readable summary.
   *
   * @param results - Map of tool name to verification result.
   * @returns Multi-line formatted diagnostic string.
   */
  static formatAllResults(results: Map<string, ContractVerificationResult>): string {
    const lines: string[] = [];
    let passed = 0;
    let failed = 0;
    let warned = 0;

    for (const result of results.values()) {
      lines.push(ToolContractVerifier.formatResult(result));
      if (result.passed) {
        if (result.violations.some((v) => v.severity === 'warn')) warned++;
        else passed++;
      } else {
        failed++;
      }
    }

    lines.push('');
    lines.push(`Summary: ${passed} passed, ${warned} passed with warnings, ${failed} failed.`);
    return lines.join('\n');
  }
}
