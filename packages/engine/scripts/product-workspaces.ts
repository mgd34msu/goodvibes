import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspectProductWorkspaces, productCheckCommands, readProductWorkspaces, selectProductWorkspaces, type ProductCheckCommand } from './product-workspace-contract.ts';
import { engineSourcesBuild, runTscStep, TSC_ENV } from './tsc-run.ts';
import { typecheckFailures } from './typecheck-output-rule.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

interface ProductCommandResult { readonly status: number | null; readonly signal?: NodeJS.Signals | null | undefined; readonly stdout: string | null; readonly stderr: string | null; readonly error?: Error | undefined; }
type ProductCommandRunner = (executable: string, args: string[], cwd: string) => ProductCommandResult;

/** A failed command must not exit while its diagnostic tail is still queued. */
async function writeOutput(stream: NodeJS.WriteStream, output: string): Promise<void> {
  if (output.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    stream.write(output, (error) => error ? reject(error) : resolve());
  });
}

/**
 * Where a product program keeps its incremental state. The state is keyed by
 * file content, not mtimes, so a second run after a small edit checks only
 * what the edit reached. A torn or foreign file is ignored by the compiler.
 */
function buildInfoFile(root: string, command: Extract<ProductCheckCommand, { kind: 'tsconfig' }>): string {
  const file = resolve(root, 'packages/engine/.tmp/typecheck', `${command.label.replace(/[^\w.-]+/g, '_')}.tsbuildinfo`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/** Run real product commands and refuse nonzero exits or printed TS diagnostics. */
export async function executeProductCommands(root: string, commands: readonly ProductCheckCommand[], mode: 'build' | 'test' | 'typecheck', runCommand: ProductCommandRunner = (executable, args, cwd) => spawnSync(executable, args, {
  cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  // Test/build children own their output and lifecycle. Inherit the real sinks
  // so progress is visible before exit without another pipe/drain layer.
  // Compiler output must remain captured: printed errors also fail exit zero.
  stdio: mode === 'typecheck' ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  env: mode === 'typecheck' ? TSC_ENV : process.env,
})): Promise<void> {
  for (const command of commands) {
    console.log(`[products] ${command.label} ...`);
    const executable = command.kind === 'tsconfig' ? 'node' : 'bun';
    const args = command.kind === 'tsconfig'
      ? [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', command.file, '--noEmit', '--pretty', 'false', '--incremental', '--tsBuildInfoFile', buildInfoFile(root, command)]
      : ['run', command.script];
    const run = runCommand(executable, args, command.cwd);
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    await writeOutput(process.stdout, run.stdout ?? '');
    await writeOutput(process.stderr, run.stderr ?? '');
    const failures = mode === 'typecheck' ? typecheckFailures({ label: command.label, exitCode: run.status, output }) : [];
    if (run.error || run.signal || run.status !== 0 || failures.length > 0) {
      for (const failure of failures) console.error(failure);
      throw new Error(`${command.label} failed (exit code ${run.status ?? 'null'}, signal ${run.signal ?? 'none'})${run.error ? `: ${run.error.message}` : ''}`);
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..');
  const modes = ['check', 'build', 'test', 'typecheck'] as const;
  const requested = process.argv[2] ?? 'check';
  if (!(modes as readonly string[]).includes(requested)) throw new Error(`Unknown product check mode ${requested}`);
  const mode = requested as typeof modes[number];
  // The typecheck gate passes this after it built the engine sources itself.
  const declarationsCurrent = mode === 'typecheck' && process.argv.includes('--declarations-current');
  const selectors = process.argv.slice(3).filter((arg) => !(declarationsCurrent && arg === '--declarations-current'));
  if (selectors.length > 0 && mode === 'check') throw new Error(`${mode} does not accept product selectors`);
  if (mode === 'check') {
    const inspection = inspectProductWorkspaces(root);
    if (inspection.findings.length > 0) {
      for (const finding of inspection.findings) console.error(`[products] ${finding}`);
      process.exit(1);
    }
    console.log(`[products] ${inspection.products.length} present, ${inspection.missing.length} absent${inspection.missing.length > 0 ? ` (${inspection.missing.join(', ')})` : ''}`);
  } else {
    const selected = selectProductWorkspaces(readProductWorkspaces(root), selectors);
    const commands = productCheckCommands(root, selected, mode);
    if (mode !== 'typecheck' || declarationsCurrent || !selected.some((product) => product.readsEngineDeclarations)) {
      await executeProductCommands(root, commands, mode);
    } else {
      // A program that reads engine declarations is checked against current
      // ones: the incremental engine build rewrites only what changed and is an
      // up-to-date check when nothing did. The build lock is held until the
      // check ends, so no other build rewrites a declaration while it is read.
      await withWorkspaceLock('product typecheck', async () => {
        const declarationFailures = await runTscStep(engineSourcesBuild(false), true);
        await executeProductCommands(root, commands, 'typecheck');
        if (declarationFailures.length > 0) {
          for (const failure of declarationFailures) console.error(`[products] ${failure}`);
          throw new Error('the engine declarations these products read did not build cleanly (diagnostics above)');
        }
      });
    }
  }
}
