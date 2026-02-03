// ============================================================================
// ENVIRONMENT VARIABLES COMPONENT
// Displays available environment variables for hooks
// ============================================================================

import { Terminal } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { type HookEventType } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface EnvironmentVariablesProps {
  eventType: HookEventType;
}

interface EnvVariable {
  name: string;
  description: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const COMMON_VARIABLES: EnvVariable[] = [
  {
    name: 'CLAUDE_PROJECT_DIR',
    description: 'Absolute path to project root',
  },
  {
    name: 'CLAUDE_CODE_REMOTE',
    description: '"true" if running in web environment',
  },
];

const SESSION_START_VARIABLES: EnvVariable[] = [
  {
    name: 'CLAUDE_ENV_FILE',
    description: 'File path for persisting environment variables',
  },
];

// ============================================================================
// SUBCOMPONENTS
// ============================================================================

function VariableRow({ name, description }: EnvVariable) {
  return (
    <div className="flex items-start gap-4 py-1.5">
      <code className="font-mono bg-surface-800 px-1.5 py-0.5 rounded text-cyan-400 text-xs shrink-0">
        ${name}
      </code>
      <span className="text-surface-400 text-xs">{description}</span>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function EnvironmentVariables({ eventType }: EnvironmentVariablesProps): React.JSX.Element {
  const isSessionStart = eventType === 'SessionStart';

  return (
    <CollapsibleSection
      title="Environment Variables"
      icon={<Terminal className="w-4 h-4" />}
    >
      <div className="space-y-3">
        {/* Common Variables */}
        <div className="space-y-1">
          {COMMON_VARIABLES.map((variable) => (
            <VariableRow key={variable.name} {...variable} />
          ))}
        </div>

        {/* SessionStart-specific Variables */}
        {isSessionStart && (
          <div className="space-y-2 pt-2 border-t border-surface-700">
            <span className="text-xs text-surface-500 font-medium">
              SessionStart only:
            </span>
            <div className="space-y-1">
              {SESSION_START_VARIABLES.map((variable) => (
                <div key={variable.name} className="space-y-1">
                  <VariableRow {...variable} />
                  <p className="text-xs text-surface-500 italic pl-0">
                    Write export statements to this file to persist env vars
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default EnvironmentVariables;
