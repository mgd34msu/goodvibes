/**
 * AutoHealer, three-stage pipeline to fix write/edit validation failures.
 *
 * Pipeline (opt-in via tools.autoHeal config):
 *   1. Formatter: the `formatter` a user languages/{id}.json file sets for the
 *      file's language; otherwise the project's prettier or biome
 *   2. Linter fix: the language's `linter` from the same file; otherwise the project's eslint --fix
 *   3. ToolLLM: LLM-assisted fix with error context
 *
 * Design constraints:
 *   - The tools run as the project runs them: the project's own binary
 *     (node_modules/.bin first, then PATH), in the project directory, on the
 *     file's real path, so the project's configuration applies; and they run
 *     asynchronously, so the terminal keeps responding
 *   - A project's formatter or linter is a program the project chose, so it
 *     runs contained (runContained, origin `project`): no network, a scrubbed
 *     environment, and nothing writable but the one hidden copy a configured
 *     language tool edits (prettier, biome and eslint read stdin and write
 *     stdout). Where no boundary with its own network exists, the stage is
 *     skipped with a warning that says why
 *   - Every stage starts from the content the agent wrote: a stage whose
 *     change was not accepted hands nothing on, so an accepted repair differs
 *     from what the agent wrote only by that stage's fix, and `method` names it
 *   - Each stage's change is accepted only when `engine.tools.heal-acceptance`
 *     reads that it fixes the listed errors (and, for the model's whole-file
 *     rewrite, that it changes nothing else); otherwise the next stage runs
 *   - Returns {healed: false, content: originalContent} with warnings whenever
 *     repair cannot safely produce validated replacement content
 *   - A JudgmentError (or a missing judgment port) propagates to the caller;
 *     every other failure is caught and reported as a warning
 */

import { existsSync } from 'node:fs';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { unifiedDiff } from '../../state/file-cache.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { hasCapturedToolInvocation } from './captured-input-tools.js';
import { healAcceptance } from '../batteries/heal-acceptance.js';
import { languageToolArgv, type CommandSpec, type ResolvedLanguages } from '../../intelligence/config.js';
import { runContained } from '../../runtime/sandbox/contained-spawn.js';

const HEAL_ACCEPTANCE_SITE = 'tools.auto-heal.acceptance';

/**
 * Most characters of a repair's diff the acceptance readings carry. A larger change cannot be read
 * whole inside one decision request (about 32,000 tokens of state and question), so it is not
 * accepted and the warning says so.
 */
const MAX_CHECKED_CHANGE_CHARS = 80_000;

/** Internal execution boundary supplied by the captured repair owner. */
export interface AutoHealExecution {
  readonly signal?: AbortSignal | undefined;
  readonly check: () => Promise<void>;
  readonly checkSynchronous: () => void;
  readonly transform: (stage: 'formatter' | 'linter', file: string, content: string, warnings: string[]) => Promise<string>;
}

/** Result of an auto-heal attempt. */
export interface HealResult {
  healed: boolean;
  content: string;
  method?: 'formatter' | 'linter' | 'llm' | undefined;
  warnings?: string[] | undefined;
}

/** Jev could not answer, or no judgment port is installed: the heal cannot decide and the caller is told. */
function isJudgmentFailure(error: unknown): boolean {
  return error instanceof JudgmentError || error instanceof JudgmentPortMissingError;
}

function addWarning(warnings: string[], message: string, error?: unknown): void {
  const warning = error === undefined ? message : `${message}: ${summarizeError(error)}`;
  warnings.push(warning);
}

/**
 * AutoHealer, attempts to fix content with validation errors via a staged pipeline.
 *
 * Usage:
 *   const healer = new AutoHealer();
 *   const result = await healer.heal(filePath, content, errors);
 *   if (result.healed) { // use result.content }
 */
export class AutoHealer {
  constructor(
    private readonly configManager: Pick<ConfigManager, 'get'>,
    private readonly toolLLM: Pick<ToolLLM, 'chat'>,
    private readonly execution?: AutoHealExecution,
    private readonly assertInvocation?: () => void,
    private readonly invocationSignal?: AbortSignal,
    private readonly reading?: JudgmentPortCapture,
    /** The workspace's language facts, read only when a heal runs. */
    private readonly languages?: () => ResolvedLanguages | undefined,
    /** The project directory the tools run in and resolve their binaries from. */
    private readonly projectRoot?: () => string | undefined,
  ) {}

  /** The project's own binary for a tool: node_modules/.bin under the project first, then PATH. */
  private projectBinary(name: string): string | null {
    const root = this.projectRoot?.();
    const local = root ? join(root, 'node_modules', '.bin', name) : '';
    if (local && existsSync(local)) return local;
    return Bun.which(name, root ? { cwd: root } : undefined);
  }

  /**
   * Runs a tool contained, in the project directory (read-only); stdin when
   * given; `writable` names the only files it may change. Aborts with the
   * heal. Rejects with ContainmentUnavailableError where no boundary without a
   * network can be built (the stage reports it and is skipped).
   */
  private async runTool(argv: readonly string[], stdin?: string, writable: readonly string[] = []): Promise<{ readonly exitCode: number; readonly stdout: string }> {
    const signal = this.execution?.signal ?? this.invocationSignal;
    const result = await runContained({
      argv,
      cwd: this.projectRoot?.() ?? process.cwd(),
      env: 'scrubbed',
      ...(stdin !== undefined ? { stdin } : {}),
      ...(signal ? { signal } : {}),
      origin: 'project',
      // Network off is never met by a host process, so a boundary is required whatever the composition's exec posture.
      containment: { boundary: 'required', network: 'off', writable, reason: 'a project formatter or linter is repairing a file the agent wrote' },
    });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout };
  }

  /**
   * A user-configured language tool works on a file: a hidden copy beside the
   * real one, so the project's configuration for that directory applies.
   */
  private async runOnSiblingCopy(spec: CommandSpec, filePath: string, content: string): Promise<{ readonly exitCode: number; readonly output: string }> {
    const copy = join(dirname(resolve(filePath)), `.${basename(filePath)}.heal-${randomBytes(4).toString('hex')}${extname(filePath)}`);
    this.checkSynchronous();
    await writeFile(copy, content, 'utf-8');
    try {
      const run = await this.runTool(languageToolArgv(spec, copy), undefined, [copy]);
      return { exitCode: run.exitCode, output: await readFile(copy, 'utf-8') };
    } finally {
      await unlink(copy).catch(() => undefined);
    }
  }

  /**
   * The formatter or linter a user languages file set for this file's
   * language, with its command located on PATH (or given as a path).
   */
  private languageTool(filePath: string, kind: 'formatter' | 'linter', warnings: string[]): CommandSpec | null | undefined {
    const languages = this.languages?.();
    const lang = languages?.detect(filePath);
    const spec = lang ? languages?.tool(lang, kind) : undefined;
    if (!spec || !lang) return undefined;
    const located = spec.command.includes('/') ? (existsSync(spec.command) ? spec.command : null) : Bun.which(spec.command);
    if (!located) {
      addWarning(warnings, `Auto-heal ${kind} '${spec.command}' set for ${lang} is not installed; skipped`);
      return null;
    }
    return { command: located, args: spec.args };
  }

  private async check(): Promise<void> {
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
    if (this.execution) await this.execution.check();
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
  }
  private readonly checkSynchronous = (): void => {
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
    this.execution?.checkSynchronous();
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
  };

  /**
   * Attempt to auto-heal content with validation errors.
   *
   * @param filePath     Original file path (used to determine extension/context).
   * @param content      File content that failed validation.
   * @param errors       Validation error messages from the failed write/edit.
   * @returns            Heal result, healed=true means content was fixed.
   */
  async heal(filePath: string, content: string, errors: string[]): Promise<HealResult> {
    const warnings: string[] = [];
    if (hasCapturedToolInvocation() && !this.execution) throw new Error('Captured repair requires its construction-owned backend');
    await this.check();
    if (isClassicOperation()) return { healed: false, content,
      warnings: ['Automatic semantic repair is unavailable without a decision model. The original validation errors are retained; submit an explicit corrected edit.'] };
    try {
      // Config gate: only run when tools.autoHeal is enabled
      if (!this.configManager.get('tools.autoHeal')) {
        return { healed: false, content };
      }

      if (!errors.length) {
        return { healed: false, content };
      }

      // Each stage starts from the content the agent wrote; a change that was
      // not accepted is dropped, never handed to the next stage.
      let result: HealResult = await this._tryFormatter(filePath, content, errors, warnings);
      if (!result.healed) result = await this._tryLinter(filePath, content, errors, warnings);
      if (!result.healed) result = await this._tryLLM(filePath, content, errors, warnings);
      if (!result.healed) result = { healed: false, content };

      await this.check();
      return warnings.length > 0 ? { ...result, warnings } : result;
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer.heal: unexpected error', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal failed unexpectedly', err);
      return { healed: false, content, warnings };
    }
  }

  /**
   * Stage 1: the language's configured formatter, else the project's prettier
   * (`--stdin-filepath`) or biome (`--stdin-file-path`), which read the
   * project's configuration for the file's real path.
   */
  private async _tryFormatter(filePath: string, content: string, errors: string[], warnings: string[]): Promise<HealResult> {
    try {
      await this.check();
      if (this.execution) return await this._tryContained('formatter', filePath, content, errors, warnings);
      const configured = this.languageTool(filePath, 'formatter', warnings);
      if (configured === null) return { healed: false, content };
      if (configured) {
        const run = await this.runOnSiblingCopy(configured, filePath, content);
        await this.check();
        if (run.exitCode !== 0) {
          addWarning(warnings, `Auto-heal formatter '${configured.command}' exited ${run.exitCode}; continuing to later repair stages`);
          return { healed: false, content };
        }
        return await this._acceptStage('formatter', filePath, content, run.output, errors, warnings);
      }
      const target = resolve(filePath);
      const prettier = this.projectBinary('prettier');
      const biome = prettier ? null : this.projectBinary('biome');
      if (!prettier && !biome) {
        logger.debug('AutoHealer: no project formatter found (prettier/biome), skipping stage 1');
        return { healed: false, content };
      }
      const run = prettier
        ? await this.runTool([prettier, '--stdin-filepath', target, '--log-level', 'silent'], content)
        : await this.runTool([biome!, 'format', `--stdin-file-path=${target}`], content);
      await this.check();
      if (run.exitCode !== 0) {
        addWarning(warnings, `Auto-heal formatter ${prettier ? 'prettier' : 'biome'} exited ${run.exitCode} (a formatter cannot read a file that does not parse); continuing to later repair stages`);
        return { healed: false, content };
      }
      return await this._acceptStage('formatter', filePath, content, run.stdout, errors, warnings);
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: formatter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal formatter stage failed; continuing to later repair stages', err);
      return { healed: false, content };
    }
  }

  /**
   * Stage 2: the language's configured linter, else the project's eslint
   * (`--stdin --stdin-filename --fix-dry-run`), which applies the project's
   * rules for the file's real path and reports the fixed text.
   */
  private async _tryLinter(filePath: string, content: string, errors: string[], warnings: string[]): Promise<HealResult> {
    try {
      await this.check();
      if (this.execution) return await this._tryContained('linter', filePath, content, errors, warnings);
      const configured = this.languageTool(filePath, 'linter', warnings);
      if (configured === null) return { healed: false, content };
      if (configured) {
        // A linter exits non-zero when problems remain; what it fixed is in the file either way.
        const run = await this.runOnSiblingCopy(configured, filePath, content);
        await this.check();
        return await this._acceptStage('linter', filePath, content, run.output, errors, warnings);
      }
      const eslint = this.projectBinary('eslint');
      if (!eslint) {
        logger.debug('AutoHealer: no project eslint found, skipping stage 2');
        return { healed: false, content };
      }
      const run = await this.runTool([eslint, '--stdin', '--stdin-filename', resolve(filePath), '--fix-dry-run', '--format', 'json'], content);
      await this.check();
      // eslint exits 1 when problems remain; the fixed text is in its report either way.
      let fixed: string | undefined;
      try {
        const report = JSON.parse(run.stdout) as readonly { readonly output?: unknown }[];
        fixed = typeof report[0]?.output === 'string' ? report[0].output : undefined;
      } catch {
        addWarning(warnings, `Auto-heal linter eslint exited ${run.exitCode} without a readable report; continuing to LLM repair`);
        return { healed: false, content };
      }
      return fixed === undefined ? { healed: false, content } : await this._acceptStage('linter', filePath, content, fixed, errors, warnings);
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: linter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal linter stage failed; continuing to LLM repair', err);
      return { healed: false, content };
    }
  }

  /** A stage's output is the repair only when accepted; otherwise the content the stage was given stands. */
  private async _acceptStage(stage: 'formatter' | 'linter', filePath: string, content: string, candidate: string, errors: string[], warnings: string[]): Promise<HealResult> {
    if (candidate === content) return { healed: false, content };
    if (await this._accepted(filePath, content, candidate, errors, stage, warnings)) {
      return { healed: true, content: candidate, method: stage };
    }
    return { healed: false, content };
  }

  private async _tryContained(stage: 'formatter' | 'linter', filePath: string, content: string, errors: string[], warnings: string[]): Promise<HealResult> {
    await this.check();
    const candidate = await executePolicyCheck(() => this.execution!.transform(stage, filePath, content, warnings), this.execution!.signal);
    await this.check();
    if (candidate === content) return { healed: false, content };
    const accepted = await this._accepted(filePath, content, candidate, errors, stage, warnings);
    return accepted ? { healed: true, content: candidate, method: stage } : { healed: false, content };
  }

  /**
   * Stage 3: Try ToolLLM with error context.
   */
  private async _tryLLM(
    filePath: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
      const prompt = [
        `You are a code repair assistant. The following file has validation errors that need to be fixed.`,
        ``,
        `File: ${filePath}`,
        ``,
        `Errors:`,
        errorList,
        ``,
        `Current content:`,
        `\`\`\``,
        content,
        `\`\`\``,
        ``,
        `Return ONLY the corrected file content, no explanation, no markdown fences.`,
      ].join('\n');

      await this.check();
      const signal = this.execution?.signal ?? this.invocationSignal;
      const response = await executePolicyCheck(() => { this.checkSynchronous(); return this.toolLLM.chat(prompt, {
        systemPrompt: 'You are a code repair tool. Output only the corrected file content with no additional text or markdown.',
        ...(signal ? { signal } : {}),
        beforeAttempt: () => this.check(),
      }); }, this.execution?.signal ?? this.invocationSignal);
      await this.check();

      if (!response || response.trim() === '') {
        logger.debug('AutoHealer: LLM returned empty response');
        addWarning(warnings, 'Auto-heal LLM returned an empty response');
        return { healed: false, content };
      }

      if (!(await this._accepted(filePath, content, response, errors, 'llm', warnings))) {
        logger.debug('AutoHealer: LLM response was not accepted as the repair');
        addWarning(warnings, 'Auto-heal LLM response was not accepted: it does not fix the validation errors, or it changes more than the fix');
        return { healed: false, content };
      }

      logger.debug('AutoHealer: errors resolved by LLM');
      return { healed: true, content: response, method: 'llm' };
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: LLM stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal LLM stage failed', err);
      return { healed: false, content };
    }
  }

  /**
   * Whether a stage's output is accepted as the repair. A JavaScript or
   * TypeScript result that Bun's parser rejects is not a repaired file (the
   * grammar settles it). Otherwise the change from the stage's input is read
   * by `engine.tools.heal-acceptance`: `fixes_errors` for every stage, and
   * `only_the_fix` for the model's whole-file rewrite. It is accepted only
   * when every reading is a yes that acts. A change too large to read whole
   * is not accepted.
   */
  private async _accepted(
    filePath: string,
    before: string,
    after: string,
    errors: string[],
    stage: NonNullable<HealResult['method']>,
    warnings: string[],
  ): Promise<boolean> {
    const ext = extname(filePath).toLowerCase();
    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      const loader = (ext === '.mjs' || ext === '.cjs') ? 'js' : ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
      try {
        new Bun.Transpiler({ loader }).transformSync(after);
      } catch {
        return false;
      }
    }
    const change = unifiedDiff(before, after, filePath);
    if (change.length > MAX_CHECKED_CHANGE_CHARS) {
      addWarning(warnings, `Auto-heal ${stage} change to '${filePath}' is ${change.length} characters, too large to check whole; not applied`);
      return false;
    }
    const asked = stage === 'llm' ? (['fixes_errors', 'only_the_fix'] as const) : (['fixes_errors'] as const);
    await this.check();
    const capture = this.reading ?? captureJudgmentPort(HEAL_ACCEPTANCE_SITE, { assertCurrent: this.checkSynchronous, signal: this.execution?.signal ?? this.invocationSignal });
    const run = await executePolicyCheck(() => healAcceptance.run(capture.port, { file: filePath, errors, change }, {
      site: HEAL_ACCEPTANCE_SITE, only: [...asked], beforeAttempt: capture.assertCurrent,
      beforeAsyncAttempt: async () => { await this.check(); capture.assertCurrent(); }, signal: capture.signal,
    }), capture.signal);
    await this.check();
    const accepted = asked.every((question) => {
      const reading = run.readings[question];
      return reading?.verdict === 'yes' && reading.outcome === 'act';
    });
    capture.assertCurrent();
    run.recordAction(`${stage} ${accepted ? 'accepted' : 'not accepted'}`);
    return accepted;
  }
}
