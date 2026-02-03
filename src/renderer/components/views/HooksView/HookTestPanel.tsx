// ============================================================================
// HOOK TEST PANEL COMPONENT
// Allows testing hook commands with sample input
// ============================================================================

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Play, Copy, Check, AlertTriangle, Terminal, RotateCcw, Info } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { EVENT_TYPES, type HookEventType } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface HookTestPanelProps {
  eventType: HookEventType;
  hookType: 'command' | 'prompt';
  command: string;
  prompt: string;
  matcher: string;
}

interface TestResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generates sample input JSON based on the event type's schema
 */
function generateSampleInput(
  eventType: HookEventType,
  matcher: string
): Record<string, unknown> {
  const eventMetadata = EVENT_TYPES.find((e) => e.value === eventType);
  if (!eventMetadata) {
    return {};
  }

  // Start with the event type's input schema example
  const baseInput = { ...eventMetadata.inputSchemaExample };

  // Override with realistic test values
  const sampleOverrides: Record<string, unknown> = {
    session_id: 'test-session-123',
    transcript_path: '/tmp/test-transcript.json',
    cwd: '/project/directory',
    permission_mode: 'default',
  };

  // Apply matcher-specific overrides for tool-related events
  if (eventMetadata.matcherType === 'tool' && matcher && matcher !== '*') {
    sampleOverrides.tool_name = matcher;
  } else if (!baseInput.tool_name && eventMetadata.matcherType === 'tool') {
    sampleOverrides.tool_name = 'Bash';
  }

  // Add event-specific sample data
  switch (eventType) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      if (!baseInput.tool_input) {
        sampleOverrides.tool_input = { command: 'echo "Hello, World!"' };
      }
      break;
    case 'UserPromptSubmit':
      sampleOverrides.prompt = 'Sample user prompt for testing';
      break;
    case 'Notification':
      if (matcher && matcher !== '*') {
        sampleOverrides.notification_type = matcher;
      }
      break;
    case 'SubagentStart':
    case 'SubagentStop':
      if (matcher && matcher !== '*') {
        sampleOverrides.subagent_name = matcher;
      }
      break;
    case 'PreCompact':
      if (matcher && matcher !== '*') {
        sampleOverrides.trigger = matcher;
      }
      break;
    case 'SessionStart':
      if (matcher && matcher !== '*') {
        sampleOverrides.source = matcher;
      }
      break;
  }

  return { ...baseInput, ...sampleOverrides };
}

/**
 * Formats JSON with proper indentation
 */
function formatJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}

// ============================================================================
// COMPONENT
// ============================================================================

export function HookTestPanel({
  eventType,
  hookType,
  command,
  prompt: _prompt,
  matcher,
}: HookTestPanelProps) {
  // Generate initial sample input
  const defaultSampleInput = useMemo(
    () => formatJson(generateSampleInput(eventType, matcher)),
    [eventType, matcher]
  );

  // State
  const [sampleInput, setSampleInput] = useState<string>(defaultSampleInput);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset sample input when event type or matcher changes
  useEffect(() => {
    setSampleInput(defaultSampleInput);
    setResult(null);
    setError(null);
  }, [defaultSampleInput]);

  // Copy to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleInput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [sampleInput]);

  // Reset to default sample
  const handleReset = useCallback(() => {
    setSampleInput(defaultSampleInput);
    setResult(null);
    setError(null);
  }, [defaultSampleInput]);

  // Run the test
  const handleRunTest = useCallback(async () => {
    if (!command.trim()) {
      setError('No command specified');
      return;
    }

    // Validate JSON input
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(sampleInput);
    } catch {
      setError('Invalid JSON input');
      return;
    }

    setIsRunning(true);
    setResult(null);
    setError(null);

    try {
      // Check if testHook API exists
      if (!window.goodvibes?.testHook) {
        setError('Hook testing API not available. Please ensure the hook server is running.');
        setIsRunning(false);
        return;
      }

      const startTime = Date.now();
      const testResult = await window.goodvibes.testHook({
        command,
        input: parsedInput,
      });
      const duration = Date.now() - startTime;

      setResult({
        stdout: testResult.stdout || '',
        stderr: testResult.stderr || '',
        exitCode: testResult.exitCode ?? 0,
        duration,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test execution failed');
    } finally {
      setIsRunning(false);
    }
  }, [command, sampleInput]);

  // Get exit code badge styling
  const getExitCodeBadge = (exitCode: number) => {
    if (exitCode === 0) {
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    } else if (exitCode === 2) {
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    }
    return 'bg-red-500/20 text-red-400 border-red-500/30';
  };

  // Render prompt type message
  if (hookType === 'prompt') {
    return (
      <CollapsibleSection
        title="Test Hook"
        icon={<Terminal className="w-4 h-4" />}
        defaultExpanded={false}
      >
        <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm text-blue-300 font-medium">
              Prompt hooks cannot be tested locally
            </p>
            <p className="text-xs text-blue-400/80">
              Prompt hooks are evaluated by an LLM at runtime. They cannot be tested locally.
              The prompt will be processed by Claude when the hook is triggered during actual usage.
            </p>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      title="Test Hook"
      icon={<Terminal className="w-4 h-4" />}
      defaultExpanded={false}
    >
      <div className="space-y-4">
        {/* Sample Input Section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-surface-300">
              Sample Input (JSON)
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="flex items-center gap-1 px-2 py-1 text-xs text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
                title="Reset to default"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 text-xs text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-green-400" />
                    <span className="text-green-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
          <textarea
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
            className="font-mono text-xs bg-surface-950 w-full h-40 p-3 rounded-lg border border-surface-700 text-surface-200 resize-y focus:outline-none focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            placeholder="Enter JSON input..."
            spellCheck={false}
          />
        </div>

        {/* Run Test Button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunTest}
            disabled={isRunning || !command.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-accent-purple hover:bg-accent-purple/80 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-md transition-colors font-medium text-sm"
          >
            {isRunning ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run Test
              </>
            )}
          </button>
          {!command.trim() && (
            <span className="text-xs text-surface-500">
              Enter a command above to enable testing
            </span>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Results Display */}
        {result && (
          <div className="space-y-3">
            {/* Result Header */}
            <div className="flex items-center gap-3">
              <span
                className={`px-2 py-1 text-xs font-medium rounded border ${getExitCodeBadge(result.exitCode)}`}
              >
                Exit Code: {result.exitCode}
              </span>
              <span className="text-xs text-surface-500">
                Executed in {result.duration}ms
              </span>
            </div>

            {/* Stdout */}
            {result.stdout && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-surface-400 uppercase tracking-wider">
                  stdout
                </label>
                <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20 overflow-x-auto">
                  <pre className="font-mono text-xs text-green-300 whitespace-pre-wrap break-words">
                    {result.stdout}
                  </pre>
                </div>
              </div>
            )}

            {/* Stderr */}
            {result.stderr && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-surface-400 uppercase tracking-wider">
                  stderr
                </label>
                <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20 overflow-x-auto">
                  <pre className="font-mono text-xs text-red-300 whitespace-pre-wrap break-words">
                    {result.stderr}
                  </pre>
                </div>
              </div>
            )}

            {/* Empty output message */}
            {!result.stdout && !result.stderr && (
              <p className="text-sm text-surface-500 italic">
                Command completed with no output
              </p>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default HookTestPanel;
