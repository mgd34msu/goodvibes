// ============================================================================
// HEADLESS TASK RUNNER SERVICE (8.1) - Run Claude tasks without UI
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from './logger.js';
import { getWorkspaceService } from './workspacePreparation.js';
import {
  getTaskDefinition,
  getAllTaskDefinitions,
  recordTaskRun,
} from '../database/primitives.js';
import {
  validateCommandName,
  validatePath,
  validateEnvironment,
  logSecurityEvent,
} from './inputSanitizer.js';

const logger = new Logger('HeadlessRunner');

// ============================================================================
// TYPES
// ============================================================================

export interface HeadlessTaskConfig {
  name?: string;
  cwd: string;
  prompt: string;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'bypassPermissions';
  allowedTools?: string[];
  deniedTools?: string[];
  maxTokens?: number;
  timeoutMs?: number;
  claudeMdContent?: string;
  env?: Record<string, string>;
  outputFormat?: 'text' | 'json' | 'stream';
  captureOutput?: boolean;
  onOutput?: (data: string) => void;
  onError?: (error: string) => void;
  onComplete?: (result: HeadlessTaskResult) => void;
}

export interface HeadlessTaskResult {
  taskId: string;
  success: boolean;
  exitCode: number | null;
  output: string;
  error: string;
  durationMs: number;
  startTime: number;
  endTime: number;
  tokensUsed?: number;
  costUSD?: number;
}

export interface RunningTask {
  id: string;
  config: HeadlessTaskConfig;
  process: ChildProcess;
  startTime: number;
  output: string;
  error: string;
}

// ============================================================================
// HEADLESS RUNNER SERVICE
// ============================================================================

class HeadlessRunnerService extends EventEmitter {
  private runningTasks: Map<string, RunningTask> = new Map();
  private taskQueue: Array<{ id: string; config: HeadlessTaskConfig }> = [];
  private maxConcurrentTasks = 3;
  private processing = false;
  private claudeCommand: string = 'claude';

  constructor() {
    super();
    this.setMaxListeners(50);
    this.detectClaudeCommand();
  }

  // ============================================================================
  // COMMAND DETECTION
  // ============================================================================

  /**
   * Detect the Claude CLI command
   */
  private async detectClaudeCommand(): Promise<void> {
    const possiblePaths = [
      'claude',
      path.join(os.homedir(), '.claude', 'bin', 'claude'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      '/usr/local/bin/claude',
    ];

    for (const cmdPath of possiblePaths) {
      try {
        const result = spawn(cmdPath, ['--version'], { stdio: 'pipe' });
        await new Promise<void>((resolve, reject) => {
          result.on('close', (code) => {
            if (code === 0) {
              this.claudeCommand = cmdPath;
              logger.info(`Detected Claude CLI at: ${cmdPath}`);
              resolve();
            } else {
              reject(new Error(`Claude CLI at ${cmdPath} exited with code ${code}`));
            }
          });
          result.on('error', reject);
        });
        break;
      } catch (error) {
        // Log the failure at debug level and try the next path
        // This is expected behavior as we're probing multiple locations
        logger.debug(`Claude CLI not found at: ${cmdPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Set custom Claude command path
   * Security: Validates the command path before accepting it
   */
  setClaudeCommand(command: string): boolean {
    const validation = validateCommandName(command);
    if (!validation.valid) {
      logger.error(`Invalid Claude command path: ${validation.error}`);
      logSecurityEvent('headless-runner-set-command', command, [], validation.error || 'Invalid command');
      return false;
    }
    this.claudeCommand = validation.sanitized || command;
    return true;
  }

  // ============================================================================
  // TASK EXECUTION
  // ============================================================================

  /**
   * Run a headless task
   */
  async runTask(config: HeadlessTaskConfig): Promise<HeadlessTaskResult> {
    const taskId = uuidv4();

    logger.info(`Starting headless task: ${config.name || taskId}`, {
      cwd: config.cwd,
      prompt: config.prompt.slice(0, 100) + '...',
    });

    // Prepare workspace if CLAUDE.md content provided
    let cleanupFn: (() => Promise<void>) | null = null;

    if (config.claudeMdContent) {
      const workspace = await getWorkspaceService().prepare({
        cwd: config.cwd,
        claudeMdContent: config.claudeMdContent,
        cleanupOnExit: true,
      });
      cleanupFn = workspace.cleanupFn;
    }

    try {
      const result = await this.executeTask(taskId, config);

      // Record if this is a defined task
      if (config.name) {
        const taskDef = getAllTaskDefinitions().find(t => t.name === config.name);
        if (taskDef) {
          recordTaskRun(taskDef.id, result.success ? 'success' : 'failure');
        }
      }

      return result;
    } finally {
      if (cleanupFn) {
        await cleanupFn();
      }
    }
  }

  /**
   * Execute a task
   */
  private executeTask(taskId: string, config: HeadlessTaskConfig): Promise<HeadlessTaskResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const timeoutMs = config.timeoutMs ?? 5 * 60 * 1000; // 5 minute default

      // Security: Validate the claude command
      const cmdValidation = validateCommandName(this.claudeCommand);
      if (!cmdValidation.valid) {
        logger.error(`Invalid Claude command: ${cmdValidation.error}`);
        logSecurityEvent('headless-task', this.claudeCommand, [], cmdValidation.error || 'Invalid command');
        resolve({
          taskId,
          success: false,
          exitCode: null,
          output: '',
          error: `Security: ${cmdValidation.error}`,
          durationMs: Date.now() - startTime,
          startTime,
          endTime: Date.now(),
        });
        return;
      }

      // Security: Validate the cwd
      const cwdValidation = validatePath(config.cwd);
      if (!cwdValidation.valid) {
        logger.error(`Invalid task cwd: ${cwdValidation.error}`);
        logSecurityEvent('headless-task', this.claudeCommand, [config.cwd], cwdValidation.error || 'Invalid cwd');
        resolve({
          taskId,
          success: false,
          exitCode: null,
          output: '',
          error: `Security: ${cwdValidation.error}`,
          durationMs: Date.now() - startTime,
          startTime,
          endTime: Date.now(),
        });
        return;
      }

      // Security: Validate custom environment variables
      if (config.env && Object.keys(config.env).length > 0) {
        const envValidation = validateEnvironment(config.env);
        if (!envValidation.valid) {
          logger.error(`Invalid task environment: ${envValidation.error}`);
          logSecurityEvent('headless-task', this.claudeCommand, [], envValidation.error || 'Invalid environment');
          resolve({
            taskId,
            success: false,
            exitCode: null,
            output: '',
            error: `Security: ${envValidation.error}`,
            durationMs: Date.now() - startTime,
            startTime,
            endTime: Date.now(),
          });
          return;
        }
      }

      // Build command arguments
      const args = this.buildClaudeArgs(config);

      // Set up environment
      const env = {
        ...process.env,
        ...config.env,
      };

      // Use validated values
      const safeCommand = cmdValidation.sanitized || this.claudeCommand;
      const safeCwd = cwdValidation.sanitized || config.cwd;

      // Spawn Claude process
      const child = spawn(safeCommand, args, {
        cwd: safeCwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const runningTask: RunningTask = {
        id: taskId,
        config,
        process: child,
        startTime,
        output: '',
        error: '',
      };

      this.runningTasks.set(taskId, runningTask);
      this.emit('task:start', { taskId, config });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (this.runningTasks.has(taskId)) {
          child.kill('SIGTERM');
          runningTask.error += '\n[Task timed out]';
        }
      }, timeoutMs);

      // Collect stdout
      child.stdout?.on('data', (data) => {
        const text = data.toString();
        runningTask.output += text;

        if (config.onOutput) {
          config.onOutput(text);
        }
        if (config.outputFormat === 'stream') {
          this.emit('task:output', { taskId, data: text });
        }
      });

      // Collect stderr
      child.stderr?.on('data', (data) => {
        const text = data.toString();
        runningTask.error += text;

        if (config.onError) {
          config.onError(text);
        }
        this.emit('task:error', { taskId, data: text });
      });

      // Write prompt to stdin
      if (config.prompt) {
        child.stdin?.write(config.prompt);
        child.stdin?.end();
      }

      // Handle completion
      child.on('close', (exitCode) => {
        clearTimeout(timeoutId);
        this.runningTasks.delete(taskId);

        const endTime = Date.now();
        const result: HeadlessTaskResult = {
          taskId,
          success: exitCode === 0,
          exitCode,
          output: runningTask.output,
          error: runningTask.error,
          durationMs: endTime - startTime,
          startTime,
          endTime,
        };

        // Try to extract token/cost info from output
        const tokenMatch = runningTask.output.match(/Tokens?:\s*(\d+)/i);
        if (tokenMatch) {
          result.tokensUsed = parseInt(tokenMatch[1], 10);
        }

        const costMatch = runningTask.output.match(/Cost:\s*\$?([\d.]+)/i);
        if (costMatch) {
          result.costUSD = parseFloat(costMatch[1]);
        }

        if (config.onComplete) {
          config.onComplete(result);
        }

        this.emit('task:complete', result);
        logger.info(`Headless task completed: ${taskId}`, {
          success: result.success,
          durationMs: result.durationMs,
        });

        resolve(result);
      });

      // Handle errors
      child.on('error', (error) => {
        clearTimeout(timeoutId);
        this.runningTasks.delete(taskId);

        const result: HeadlessTaskResult = {
          taskId,
          success: false,
          exitCode: null,
          output: runningTask.output,
          error: `Process error: ${error.message}`,
          durationMs: Date.now() - startTime,
          startTime,
          endTime: Date.now(),
        };

        if (config.onComplete) {
          config.onComplete(result);
        }

        this.emit('task:complete', result);
        logger.error(`Headless task failed: ${taskId}`, error);

        resolve(result);
      });
    });
  }

  /**
   * Build Claude CLI arguments
   */
  private buildClaudeArgs(config: HeadlessTaskConfig): string[] {
    const args: string[] = ['--print'];

    if (config.model) {
      args.push('--model', config.model);
    }

    if (config.permissionMode === 'plan') {
      args.push('--plan');
    } else if (config.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    }

    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push('--allowedTools', config.allowedTools.join(','));
    }

    if (config.deniedTools && config.deniedTools.length > 0) {
      args.push('--deniedTools', config.deniedTools.join(','));
    }

    if (config.maxTokens) {
      args.push('--max-turns', config.maxTokens.toString());
    }

    if (config.outputFormat === 'json') {
      args.push('--output-format', 'json');
    }

    // Add the prompt as positional argument
    args.push(config.prompt);

    return args;
  }

  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================

  /**
   * Queue a task for execution
   */
  queueTask(config: HeadlessTaskConfig): string {
    const taskId = uuidv4();
    this.taskQueue.push({ id: taskId, config });
    this.emit('task:queued', { taskId, config });

    // Process queue
    this.processQueue();

    return taskId;
  }

  /**
   * Process the task queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.taskQueue.length > 0 && this.runningTasks.size < this.maxConcurrentTasks) {
      const item = this.taskQueue.shift();
      if (item) {
        // Don't await - run concurrently
        this.runTask(item.config).catch((error) => {
          logger.error(`Queued task failed: ${item.id}`, error);
        });
      }
    }

    this.processing = false;
  }

  /**
   * Set max concurrent tasks
   */
  setMaxConcurrentTasks(max: number): void {
    this.maxConcurrentTasks = max;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.taskQueue = [];
    this.emit('queue:cleared');
  }

  // ============================================================================
  // TASK DEFINITIONS
  // ============================================================================

  /**
   * Run a defined task by ID
   */
  async runDefinedTask(taskDefId: number): Promise<HeadlessTaskResult | null> {
    const taskDef = getTaskDefinition(taskDefId);
    if (!taskDef) {
      logger.error(`Task definition not found: ${taskDefId}`);
      return null;
    }

    return this.runTask({
      name: taskDef.name,
      cwd: process.cwd(), // Use current directory or get from template
      prompt: taskDef.prompt,
    });
  }

  /**
   * Run all enabled scheduled tasks
   */
  async runScheduledTasks(): Promise<HeadlessTaskResult[]> {
    const tasks = getAllTaskDefinitions().filter(t => t.enabled && t.schedule);
    const results: HeadlessTaskResult[] = [];

    for (const task of tasks) {
      const result = await this.runDefinedTask(task.id);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  // ============================================================================
  // RUNNING TASK MANAGEMENT
  // ============================================================================

  /**
   * Get running tasks
   */
  getRunningTasks(): RunningTask[] {
    return Array.from(this.runningTasks.values());
  }

  /**
   * Get a running task by ID
   */
  getRunningTask(taskId: string): RunningTask | undefined {
    return this.runningTasks.get(taskId);
  }

  /**
   * Cancel a running task
   */
  cancelTask(taskId: string): boolean {
    const task = this.runningTasks.get(taskId);
    if (task) {
      task.process.kill('SIGTERM');
      this.runningTasks.delete(taskId);
      this.emit('task:cancelled', { taskId });
      logger.info(`Cancelled task: ${taskId}`);
      return true;
    }
    return false;
  }

  /**
   * Cancel all running tasks
   */
  cancelAllTasks(): void {
    for (const task of this.runningTasks.values()) {
      task.process.kill('SIGTERM');
    }
    this.runningTasks.clear();
    this.emit('tasks:cancelled');
    logger.info('Cancelled all running tasks');
  }

  // ============================================================================
  // BATCH OPERATIONS
  // ============================================================================

  /**
   * Run multiple tasks in parallel
   */
  async runBatch(
    configs: HeadlessTaskConfig[],
    options?: { maxConcurrent?: number }
  ): Promise<HeadlessTaskResult[]> {
    const maxConcurrent = options?.maxConcurrent ?? this.maxConcurrentTasks;
    const results: HeadlessTaskResult[] = [];

    // Process in batches
    for (let i = 0; i < configs.length; i += maxConcurrent) {
      const batch = configs.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((config) => this.runTask(config))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Run tasks sequentially
   */
  async runSequential(configs: HeadlessTaskConfig[]): Promise<HeadlessTaskResult[]> {
    const results: HeadlessTaskResult[] = [];

    for (const config of configs) {
      const result = await this.runTask(config);
      results.push(result);

      // Stop if a task fails and it's critical
      if (!result.success) {
        logger.warn('Sequential task failed, continuing with remaining tasks');
      }
    }

    return results;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Shutdown the service
   */
  shutdown(): void {
    this.cancelAllTasks();
    this.clearQueue();
    this.removeAllListeners();
    logger.info('Headless Runner shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let headlessRunner: HeadlessRunnerService | null = null;

export function getHeadlessRunner(): HeadlessRunnerService {
  if (!headlessRunner) {
    headlessRunner = new HeadlessRunnerService();
  }
  return headlessRunner;
}

export function shutdownHeadlessRunner(): void {
  if (headlessRunner) {
    headlessRunner.shutdown();
    headlessRunner = null;
  }
}

// Export the class for testing
export { HeadlessRunnerService };
