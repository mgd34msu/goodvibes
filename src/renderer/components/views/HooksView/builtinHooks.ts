// ============================================================================
// HOOKS VIEW - BUILT-IN HOOK TEMPLATES
// ============================================================================

import type { HookEventType } from './types';

export interface BuiltinHook {
  id: string;
  name: string;
  description: string;
  eventType: HookEventType;
  matcher: string | null;
  command: string;
  hookType: 'command' | 'prompt';
  prompt: string | null;
  timeout: number;
  category: 'safety' | 'automation' | 'notifications' | 'workflow' | 'setup';
  tags: string[];
}

// Category colors for badges
export const CATEGORY_COLORS: Record<BuiltinHook['category'], string> = {
  safety: 'bg-red-500/10 text-red-400 border-red-500/20',
  automation: 'bg-green-500/10 text-green-400 border-green-500/20',
  notifications: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  workflow: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  setup: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
};

export const CATEGORY_LABELS: Record<BuiltinHook['category'], string> = {
  safety: 'Safety',
  automation: 'Automation',
  notifications: 'Notifications',
  workflow: 'Workflow',
  setup: 'Setup',
};

export const BUILT_IN_HOOKS: BuiltinHook[] = [
  // ============================================================================
  // SAFETY HOOKS (5)
  // ============================================================================
  {
    id: 'block-dangerous-commands',
    name: 'Block Dangerous Commands',
    description: 'Blocks rm -rf, format, and other destructive bash commands before execution',
    eventType: 'PreToolUse',
    matcher: 'Bash',
    command: `#!/bin/bash
# Block dangerous bash commands
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# List of dangerous patterns
DANGEROUS_PATTERNS=(
  "rm -rf /"
  "rm -rf /*"
  "rm -rf ~"
  "rm -rf $HOME"
  "format c:"
  "mkfs"
  ":(){:|:&};:"
  "dd if=/dev/zero"
  "chmod -R 777 /"
  "> /dev/sda"
)

for pattern in "\${DANGEROUS_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    echo '{"decision":"block","reason":"Blocked dangerous command: '"$pattern"'"}' | jq .
    exit 2
  fi
done

# Allow safe commands
echo '{"decision":"allow"}' | jq .
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'safety',
    tags: ['security', 'bash', 'destructive', 'block'],
  },
  {
    id: 'block-sensitive-file-access',
    name: 'Block Sensitive File Access',
    description: 'Prevents reading or writing sensitive files like .env, credentials, and SSH keys',
    eventType: 'PreToolUse',
    matcher: 'Read|Write|Edit',
    command: `#!/bin/bash
# Block access to sensitive files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')

# Sensitive file patterns
SENSITIVE_PATTERNS=(
  ".env"
  ".env.local"
  ".env.production"
  "credentials.json"
  "secrets.json"
  ".ssh/id_rsa"
  ".ssh/id_ed25519"
  ".aws/credentials"
  ".npmrc"
  ".pypirc"
)

for pattern in "\${SENSITIVE_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo '{"decision":"deny","reason":"Access to sensitive file blocked: '"$pattern"'"}'
    exit 0
  fi
done

echo '{"decision":"allow"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'safety',
    tags: ['security', 'sensitive', 'credentials', 'block'],
  },
  {
    id: 'require-confirmation-for-writes',
    name: 'Require Confirmation for New Files',
    description: 'Asks for confirmation before creating new files outside the project directory',
    eventType: 'PermissionRequest',
    matcher: 'Write',
    command: `#!/bin/bash
# Confirm writes outside project directory
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Check if file is outside project directory
if [[ ! "$FILE_PATH" == "$CWD"* ]] && [[ ! "$FILE_PATH" == "./"* ]]; then
  echo '{"decision":"deny","message":"File is outside project directory. Use absolute paths carefully."}'
  exit 0
fi

echo '{"decision":"allow"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'safety',
    tags: ['confirmation', 'write', 'directory', 'scope'],
  },
  {
    id: 'block-network-commands',
    name: 'Block Network Commands',
    description: 'Blocks curl, wget, and other network commands to prevent data exfiltration',
    eventType: 'PreToolUse',
    matcher: 'Bash',
    command: `#!/bin/bash
# Block network commands
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Network command patterns
NETWORK_PATTERNS=(
  "curl "
  "wget "
  "nc "
  "netcat "
  "telnet "
  "ssh "
  "scp "
  "rsync "
  "ftp "
)

for pattern in "\${NETWORK_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    echo '{"decision":"deny","reason":"Network commands are blocked for security"}'
    exit 0
  fi
done

echo '{"decision":"allow"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'safety',
    tags: ['network', 'security', 'exfiltration', 'block'],
  },
  {
    id: 'audit-log-all-commands',
    name: 'Audit Log All Commands',
    description: 'Logs all bash commands to an audit file for security review',
    eventType: 'PostToolUse',
    matcher: 'Bash',
    command: `#!/bin/bash
# Audit log all bash commands
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // 0')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Create audit log directory
AUDIT_DIR="$CWD/.claude-audit"
mkdir -p "$AUDIT_DIR"

# Log the command
echo "[$TIMESTAMP] exit=$EXIT_CODE cmd=$COMMAND" >> "$AUDIT_DIR/commands.log"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'safety',
    tags: ['audit', 'logging', 'security', 'compliance'],
  },

  // ============================================================================
  // AUTOMATION HOOKS (5)
  // ============================================================================
  {
    id: 'auto-approve-read-operations',
    name: 'Auto-Approve Read Operations',
    description: 'Automatically allows Read, Glob, and Grep tools without prompting',
    eventType: 'PreToolUse',
    matcher: 'Read|Glob|Grep',
    command: `#!/bin/bash
# Auto-approve read-only operations
echo '{"decision":"allow","reason":"Auto-approved read-only operation"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 1000,
    category: 'automation',
    tags: ['auto-approve', 'read-only', 'permissions'],
  },

  {
    id: 'run-linter-after-edit',
    name: 'Run Linter After Edit',
    description: 'Runs ESLint after file edits to catch issues immediately',
    eventType: 'PostToolUse',
    matcher: 'Edit|Write',
    command: `#!/bin/bash
# Run ESLint after edits
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Only lint JS/TS files
if [[ "$FILE_PATH" =~ \\.(js|jsx|ts|tsx)$ ]]; then
  cd "$CWD" 2>/dev/null || exit 0

  if command -v npx &> /dev/null && [ -f "node_modules/.bin/eslint" ]; then
    npx eslint --fix "$FILE_PATH" 2>&1 || true
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 30000,
    category: 'automation',
    tags: ['linting', 'eslint', 'code-quality', 'edit'],
  },
  {
    id: 'auto-format-on-save',
    name: 'Auto-Format on Save',
    description: 'Runs Prettier to format files after writes',
    eventType: 'PostToolUse',
    matcher: 'Write',
    command: `#!/bin/bash
# Auto-format with Prettier after writes
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if command -v npx &> /dev/null && [ -f "node_modules/.bin/prettier" ]; then
  npx prettier --write "$FILE_PATH" 2>&1 || true
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'automation',
    tags: ['formatting', 'prettier', 'code-style', 'write'],
  },
  {
    id: 'validate-json-schema',
    name: 'Validate JSON Files',
    description: 'Validates JSON files syntax after writes',
    eventType: 'PostToolUse',
    matcher: 'Write',
    command: `#!/bin/bash
# Validate JSON files after write
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check JSON files
if [[ "$FILE_PATH" =~ \\.json$ ]]; then
  # Try to parse the JSON to validate syntax
  if ! jq . "$FILE_PATH" > /dev/null 2>&1; then
    echo "[JSON Validation] Warning: Invalid JSON syntax in $FILE_PATH"
    exit 1
  fi
  echo "[JSON Validation] $FILE_PATH is valid JSON"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'automation',
    tags: ['json', 'validation', 'schema', 'write'],
  },
  {
    id: 'run-typecheck-after-edit',
    name: 'Run TypeScript Check After Edit',
    description: 'Runs TypeScript compiler check after editing TS files',
    eventType: 'PostToolUse',
    matcher: 'Edit|Write',
    command: `#!/bin/bash
# Run TypeScript check after edits
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Only check TS/TSX files
if [[ "$FILE_PATH" =~ \\.(ts|tsx)$ ]]; then
  cd "$CWD" 2>/dev/null || exit 0

  if command -v npx &> /dev/null && [ -f "node_modules/.bin/tsc" ]; then
    echo "[TypeCheck] Checking $FILE_PATH..."
    npx tsc --noEmit 2>&1 | head -20
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 60000,
    category: 'automation',
    tags: ['typescript', 'typecheck', 'code-quality', 'edit'],
  },

  // ============================================================================
  // NOTIFICATION HOOKS (5)
  // ============================================================================
  {
    id: 'desktop-notification-idle',
    name: 'Desktop Notification on Idle',
    description: 'Shows a system notification when Claude becomes idle and needs input',
    eventType: 'Notification',
    matcher: 'idle_prompt',
    command: `#!/bin/bash
# Cross-platform desktop notification
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude is waiting for input"')

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  osascript -e "display notification \\"$MESSAGE\\" with title \\"Claude Code\\""
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "$WINDIR" ]]; then
  # Windows (PowerShell)
  powershell -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $textNodes = $template.GetElementsByTagName('text'); $textNodes.Item(0).AppendChild($template.CreateTextNode('Claude Code')); $textNodes.Item(1).AppendChild($template.CreateTextNode('$MESSAGE')); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show([Windows.UI.Notifications.ToastNotification]::new($template))" 2>/dev/null || \\
  powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$MESSAGE', 'Claude Code')" 2>/dev/null
else
  # Linux
  if command -v notify-send &> /dev/null; then
    notify-send "Claude Code" "$MESSAGE"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'notifications',
    tags: ['notification', 'desktop', 'idle', 'alert'],
  },
  {
    id: 'sound-alert-permission',
    name: 'Sound Alert on Permission',
    description: 'Plays a system sound when Claude needs permission approval',
    eventType: 'Notification',
    matcher: 'permission_prompt',
    command: `#!/bin/bash
# Cross-platform sound alert
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS - play system sound
  afplay /System/Library/Sounds/Glass.aiff &
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "$WINDIR" ]]; then
  # Windows - play system beep
  powershell -Command "[console]::beep(800,300)" 2>/dev/null || echo -e "\\a"
else
  # Linux - try various methods
  if command -v paplay &> /dev/null; then
    paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null &
  elif command -v aplay &> /dev/null; then
    aplay /usr/share/sounds/sound-icons/glass-water-1.wav 2>/dev/null &
  else
    echo -e "\\a"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['sound', 'alert', 'permission', 'audio'],
  },
  {
    id: 'slack-notification',
    name: 'Slack Notification on Complete',
    description: 'Sends a Slack message when Claude finishes a task',
    eventType: 'Notification',
    matcher: 'idle_prompt',
    command: `#!/bin/bash
# Send Slack notification
# Set SLACK_WEBHOOK_URL in your environment
WEBHOOK_URL="\${SLACK_WEBHOOK_URL:-}"

if [ -z "$WEBHOOK_URL" ]; then
  echo "SLACK_WEBHOOK_URL not set, skipping notification"
  exit 0
fi

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude needs your attention"')

curl -s -X POST "$WEBHOOK_URL" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "🤖 Claude Code: '"$MESSAGE"'"}' \\
  > /dev/null 2>&1

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'notifications',
    tags: ['slack', 'webhook', 'notification', 'messaging'],
  },
  {
    id: 'email-notification-complete',
    name: 'Email on Task Complete',
    description: 'Sends an email notification when Claude finishes working',
    eventType: 'SessionEnd',
    matcher: null,
    command: `#!/bin/bash
# Send email notification on session end
# Requires mail/sendmail to be configured
INPUT=$(cat)
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')
EMAIL="\${CLAUDE_NOTIFICATION_EMAIL:-}"

if [ -z "$EMAIL" ]; then
  echo "CLAUDE_NOTIFICATION_EMAIL not set, skipping"
  exit 0
fi

if command -v mail &> /dev/null; then
  echo "Claude Code session ended. Reason: $REASON" | mail -s "Claude Code Session Complete" "$EMAIL"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'notifications',
    tags: ['email', 'notification', 'session', 'complete'],
  },
  {
    id: 'log-to-file-notification',
    name: 'Log Notifications to File',
    description: 'Writes all Claude notifications to a log file for review',
    eventType: 'Notification',
    matcher: '*',
    command: `#!/bin/bash
# Log all notifications to file
INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TYPE=$(echo "$INPUT" | jq -r '.type // "unknown"')
MESSAGE=$(echo "$INPUT" | jq -r '.message // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

LOG_FILE="$CWD/.claude-notifications.log"

echo "[$TIMESTAMP] [$TYPE] $MESSAGE" >> "$LOG_FILE"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['logging', 'file', 'audit', 'notifications'],
  },

  // ============================================================================
  // WORKFLOW HOOKS (5)
  // ============================================================================
  {
    id: 'inject-project-context',
    name: 'Inject Project Context',
    description: 'Adds project information and relevant context files to every prompt',
    eventType: 'UserPromptSubmit',
    matcher: null,
    command: `#!/bin/bash
# Inject project context into prompts
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Build context from project files
CONTEXT=""

# Add package.json info if present
if [ -f "$CWD/package.json" ]; then
  PKG_NAME=$(jq -r '.name // "unknown"' "$CWD/package.json" 2>/dev/null)
  PKG_DESC=$(jq -r '.description // ""' "$CWD/package.json" 2>/dev/null)
  CONTEXT="Project: $PKG_NAME"
  if [ -n "$PKG_DESC" ]; then
    CONTEXT="$CONTEXT - $PKG_DESC"
  fi
  CONTEXT="$CONTEXT\\n"
fi

# Add CLAUDE.md summary if present
if [ -f "$CWD/CLAUDE.md" ]; then
  CONTEXT="$CONTEXT\\nProject has CLAUDE.md with custom instructions."
fi

# Output the context to be injected
if [ -n "$CONTEXT" ]; then
  echo -e "[Project Context]\\n$CONTEXT\\n"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['context', 'injection', 'prompt', 'project'],
  },

  // ============================================================================
  // SessionStart Hooks - Initialization
  // ============================================================================
  {
    id: 'load-environment-variables',
    name: 'Load Environment Variables',
    description: 'Loads .env file variables into the Claude session environment',
    eventType: 'SessionStart',
    matcher: 'startup',
    command: `#!/bin/bash
# Load .env file into session
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

if [ -f "$CWD/.env" ]; then
  echo "[SessionStart] Loading environment from .env"

  # Export vars (excluding comments and empty lines)
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ $key =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue

    # Remove quotes from value if present
    value="\${value%\\"}"
    value="\${value#\\"}"
    value="\${value%\\'}"
    value="\${value#\\'}"

    export "$key=$value"
    echo "  Loaded: $key"
  done < "$CWD/.env"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['environment', 'env', 'startup', 'initialization'],
  },

  // ============================================================================
  // Stop Hooks - Validation
  // ============================================================================
  {
    id: 'run-tests-before-stop',
    name: 'Run Tests Before Stop',
    description: 'Ensures tests pass before allowing Claude to finish the task',
    eventType: 'Stop',
    matcher: null,
    command: `#!/bin/bash
# Run tests before allowing Claude to stop
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

# Check if package.json has test script
if [ -f "package.json" ] && jq -e '.scripts.test' package.json > /dev/null 2>&1; then
  echo "[Stop Hook] Running tests before completion..."

  if npm test 2>&1; then
    echo "[Stop Hook] Tests passed!"
    exit 0
  else
    echo "[Stop Hook] Tests failed! Please fix before stopping."
    echo '{"decision":"block","reason":"Tests are failing. Please fix the failing tests before completing the task."}'
    exit 2
  fi
fi

# No tests configured, allow stop
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 120000,
    category: 'workflow',
    tags: ['tests', 'validation', 'stop', 'quality'],
  },

  {
    id: 'git-status-after-edit',
    name: 'Git Status After Edit',
    description: 'Shows git status after file modifications to track changes',
    eventType: 'PostToolUse',
    matcher: 'Edit|Write',
    command: `#!/bin/bash
# Show git status after edits
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

# Only run if in a git repo
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "[Git] Changes after edit:"
  git status --short 2>/dev/null
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['git', 'status', 'tracking', 'edit'],
  },
  {
    id: 'auto-commit-checkpoint',
    name: 'Auto-Commit Checkpoints',
    description: 'Creates automatic git commits after successful edits as recovery checkpoints',
    eventType: 'PostToolUse',
    matcher: 'Edit|Write',
    command: `#!/bin/bash
# Auto-commit checkpoints after edits
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

cd "$CWD" 2>/dev/null || exit 0

# Only run if in a git repo
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  # Stage the modified file
  git add "$FILE_PATH" 2>/dev/null

  # Create checkpoint commit
  TIMESTAMP=$(date +"%H:%M:%S")
  git commit -m "checkpoint: $FILE_PATH [$TIMESTAMP]" --no-verify 2>/dev/null

  echo "[Checkpoint] Saved: $FILE_PATH"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['git', 'checkpoint', 'backup', 'recovery'],
  },

  // ============================================================================
  // PRETOOLUSE - Additional (need 1 more)
  // ============================================================================
  {
    id: 'rate-limit-tool-usage',
    name: 'Rate Limit Tool Usage',
    description: 'Limits how often a tool can be called to prevent runaway loops',
    eventType: 'PreToolUse',
    matcher: '*',
    command: `#!/bin/bash
# Rate limit tool usage
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
RATE_FILE="$CWD/.claude-rate-limit"
MAX_CALLS_PER_MINUTE=30

mkdir -p "$(dirname "$RATE_FILE")"
NOW=$(date +%s)
MINUTE_AGO=$((NOW - 60))

# Clean old entries and count recent calls
if [ -f "$RATE_FILE" ]; then
  RECENT=$(awk -v cutoff="$MINUTE_AGO" '$1 > cutoff' "$RATE_FILE" | wc -l)
  awk -v cutoff="$MINUTE_AGO" '$1 > cutoff' "$RATE_FILE" > "$RATE_FILE.tmp"
  mv "$RATE_FILE.tmp" "$RATE_FILE"
else
  RECENT=0
fi

if [ "$RECENT" -ge "$MAX_CALLS_PER_MINUTE" ]; then
  echo '{"decision":"deny","reason":"Rate limit exceeded. Please slow down."}'
  exit 0
fi

echo "$NOW $TOOL_NAME" >> "$RATE_FILE"
echo '{"decision":"allow"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'safety',
    tags: ['rate-limit', 'throttle', 'safety', 'loops'],
  },

  // ============================================================================
  // PERMISSIONREQUEST - Additional (need 4 more)
  // ============================================================================
  {
    id: 'auto-approve-project-dir',
    name: 'Auto-Approve in Project Directory',
    description: 'Automatically approves operations within the project directory',
    eventType: 'PermissionRequest',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Allow if file is within project directory
if [[ "$FILE_PATH" == "$CWD"* ]] || [[ "$FILE_PATH" == "./"* ]] || [[ "$FILE_PATH" != /* ]]; then
  echo '{"decision":"allow","reason":"File is within project directory"}'
else
  echo '{"decision":"deny","reason":"File is outside project directory"}'
fi
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'automation',
    tags: ['auto-approve', 'permissions', 'directory', 'scope'],
  },
  {
    id: 'approve-during-work-hours',
    name: 'Auto-Approve During Work Hours',
    description: 'Auto-approves operations during configured work hours (9am-6pm)',
    eventType: 'PermissionRequest',
    matcher: '*',
    command: `#!/bin/bash
HOUR=$(date +%H)
if [ "$HOUR" -ge 9 ] && [ "$HOUR" -lt 18 ]; then
  echo '{"decision":"allow","reason":"Within work hours"}'
else
  echo '{"decision":"ask","reason":"Outside work hours - manual approval required"}'
fi
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'automation',
    tags: ['work-hours', 'schedule', 'auto-approve', 'permissions'],
  },
  {
    id: 'confirm-delete-operations',
    name: 'Require Confirmation for Deletes',
    description: 'Always requires manual confirmation for delete operations',
    eventType: 'PermissionRequest',
    matcher: 'Bash',
    command: `#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ "$COMMAND" == *"rm "* ]] || [[ "$COMMAND" == *"del "* ]] || [[ "$COMMAND" == *"rmdir"* ]]; then
  echo '{"decision":"ask","reason":"Delete operation requires confirmation"}'
else
  echo '{"decision":"allow"}'
fi
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'safety',
    tags: ['delete', 'confirmation', 'safety', 'permissions'],
  },
  {
    id: 'allow-trusted-patterns',
    name: 'Allow Trusted Tool Patterns',
    description: 'Auto-approves specific trusted command patterns',
    eventType: 'PermissionRequest',
    matcher: 'Bash',
    command: `#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Trusted patterns
TRUSTED_PATTERNS=(
  "npm test"
  "npm run"
  "npx "
  "git status"
  "git diff"
  "git log"
  "ls "
  "pwd"
  "echo "
)

for pattern in "\${TRUSTED_PATTERNS[@]}"; do
  if [[ "$COMMAND" == "$pattern"* ]]; then
    echo '{"decision":"allow","reason":"Trusted command pattern"}'
    exit 0
  fi
done

echo '{"decision":"ask"}'
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'automation',
    tags: ['trusted', 'patterns', 'whitelist', 'permissions'],
  },

  // ============================================================================
  // POSTTOOLUSEFAILURE - All 5 (new event type)
  // ============================================================================
  {
    id: 'log-failed-commands',
    name: 'Log Failed Commands',
    description: 'Logs all failed tool executions to a file for debugging',
    eventType: 'PostToolUseFailure',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
ERROR=$(echo "$INPUT" | jq -r '.tool_response.stderr // .error // "unknown error"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

LOG_FILE="$CWD/.claude-failures.log"
echo "[$TIMESTAMP] FAILED: $TOOL_NAME - $ERROR" >> "$LOG_FILE"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['logging', 'errors', 'debugging', 'failures'],
  },
  {
    id: 'alert-repeated-failures',
    name: 'Alert on Repeated Failures',
    description: 'Shows alert when same tool fails multiple times in a row',
    eventType: 'PostToolUseFailure',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
FAILURE_FILE="$CWD/.claude-failure-count"

mkdir -p "$(dirname "$FAILURE_FILE")"

# Count consecutive failures for this tool
LAST_TOOL=$(head -1 "$FAILURE_FILE" 2>/dev/null || echo "")
COUNT=$(tail -1 "$FAILURE_FILE" 2>/dev/null || echo "0")

if [ "$LAST_TOOL" = "$TOOL_NAME" ]; then
  COUNT=$((COUNT + 1))
else
  COUNT=1
fi

echo "$TOOL_NAME" > "$FAILURE_FILE"
echo "$COUNT" >> "$FAILURE_FILE"

if [ "$COUNT" -ge 3 ]; then
  echo "[WARNING] $TOOL_NAME has failed $COUNT times consecutively!"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['alerts', 'failures', 'consecutive', 'monitoring'],
  },
  {
    id: 'capture-error-context',
    name: 'Capture Error Context',
    description: 'Saves full error context to help with debugging',
    eventType: 'PostToolUseFailure',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%s)

ERROR_DIR="$CWD/.claude-errors"
mkdir -p "$ERROR_DIR"

# Save full context
echo "$INPUT" | jq . > "$ERROR_DIR/error-$TIMESTAMP.json"

echo "[Error Context] Saved to $ERROR_DIR/error-$TIMESTAMP.json"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['errors', 'context', 'debugging', 'capture'],
  },
  {
    id: 'suggest-fix-for-failure',
    name: 'Suggest Fixes for Common Errors',
    description: 'Provides suggestions for common error patterns',
    eventType: 'PostToolUseFailure',
    matcher: 'Bash',
    command: `#!/bin/bash
INPUT=$(cat)
ERROR=$(echo "$INPUT" | jq -r '.tool_response.stderr // ""')

# Common error patterns and suggestions
if [[ "$ERROR" == *"command not found"* ]]; then
  echo "[Suggestion] Command not found. Try installing the required package."
elif [[ "$ERROR" == *"permission denied"* ]]; then
  echo "[Suggestion] Permission denied. Check file permissions or run with appropriate access."
elif [[ "$ERROR" == *"ENOENT"* ]] || [[ "$ERROR" == *"No such file"* ]]; then
  echo "[Suggestion] File not found. Verify the path exists."
elif [[ "$ERROR" == *"ECONNREFUSED"* ]]; then
  echo "[Suggestion] Connection refused. Check if the service is running."
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'automation',
    tags: ['suggestions', 'errors', 'help', 'debugging'],
  },
  {
    id: 'notify-on-failure',
    name: 'Desktop Notification on Failure',
    description: 'Shows desktop notification when a tool fails',
    eventType: 'PostToolUseFailure',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e "display notification \\"$TOOL_NAME failed\\" with title \\"Claude Code Error\\""
elif [[ -n "$WINDIR" ]]; then
  powershell -Command "[console]::beep(400,500)" 2>/dev/null
else
  notify-send "Claude Code Error" "$TOOL_NAME failed" 2>/dev/null || echo -e "\\a"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['notification', 'desktop', 'failure', 'alert'],
  },

  // ============================================================================
  // NOTIFICATION - Additional (need 1 more)
  // ============================================================================
  {
    id: 'webhook-on-auth',
    name: 'Webhook on Auth Success',
    description: 'Sends webhook notification when authentication succeeds',
    eventType: 'Notification',
    matcher: 'auth_success',
    command: `#!/bin/bash
WEBHOOK_URL="\${CLAUDE_AUTH_WEBHOOK:-}"
if [ -n "$WEBHOOK_URL" ]; then
  curl -s -X POST "$WEBHOOK_URL" \\
    -H "Content-Type: application/json" \\
    -d '{"event":"auth_success","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' \\
    > /dev/null 2>&1
fi
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'notifications',
    tags: ['webhook', 'auth', 'notification', 'security'],
  },

  // ============================================================================
  // USERPROMPTSUBMIT - Additional (need 4 more)
  // ============================================================================
  {
    id: 'add-timestamp-to-prompt',
    name: 'Add Timestamp to Prompts',
    description: 'Prepends current timestamp to all prompts for logging',
    eventType: 'UserPromptSubmit',
    matcher: null,
    command: `#!/bin/bash
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
echo "[Submitted at $TIMESTAMP]"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'workflow',
    tags: ['timestamp', 'logging', 'prompt', 'audit'],
  },
  {
    id: 'block-sensitive-keywords',
    name: 'Block Sensitive Keywords',
    description: 'Blocks prompts containing sensitive keywords like passwords or API keys',
    eventType: 'UserPromptSubmit',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

SENSITIVE_PATTERNS=(
  "password"
  "api_key"
  "secret_key"
  "private_key"
  "ACCESS_KEY"
  "Bearer "
)

for pattern in "\${SENSITIVE_PATTERNS[@]}"; do
  if [[ "$PROMPT" == *"$pattern"* ]]; then
    echo '{"decision":"block","reason":"Prompt contains sensitive keyword: '"$pattern"'"}'
    exit 2
  fi
done

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'safety',
    tags: ['security', 'keywords', 'block', 'sensitive'],
  },
  {
    id: 'add-git-branch-info',
    name: 'Add Git Branch Info',
    description: 'Injects current git branch name into prompt context',
    eventType: 'UserPromptSubmit',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  if [ -n "$BRANCH" ]; then
    echo "[Git Branch: $BRANCH]"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['git', 'branch', 'context', 'injection'],
  },
  {
    id: 'prepend-custom-instructions',
    name: 'Prepend Custom Instructions',
    description: 'Adds custom instructions from a file to every prompt',
    eventType: 'UserPromptSubmit',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

INSTRUCTIONS_FILE="$CWD/.claude-instructions"
if [ -f "$INSTRUCTIONS_FILE" ]; then
  echo "[Custom Instructions]"
  cat "$INSTRUCTIONS_FILE"
  echo ""
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['instructions', 'custom', 'context', 'injection'],
  },

  // ============================================================================
  // STOP - Additional (need 4 more)
  // ============================================================================
  {
    id: 'verify-build-passes',
    name: 'Verify Build Passes',
    description: 'Ensures the project builds successfully before stopping',
    eventType: 'Stop',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if [ -f "package.json" ] && jq -e '.scripts.build' package.json > /dev/null 2>&1; then
  echo "[Stop Hook] Verifying build..."
  if npm run build > /dev/null 2>&1; then
    echo "[Stop Hook] Build passed!"
  else
    echo '{"decision":"block","reason":"Build is failing. Please fix build errors."}'
    exit 2
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 180000,
    category: 'workflow',
    tags: ['build', 'verification', 'stop', 'quality'],
  },
  {
    id: 'check-for-todos',
    name: 'Check for TODOs',
    description: 'Warns if there are TODO comments left in modified files',
    eventType: 'Stop',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  TODOS=$(git diff --cached --name-only | xargs grep -l "TODO\\|FIXME\\|XXX" 2>/dev/null | head -5)
  if [ -n "$TODOS" ]; then
    echo "[Warning] Files with TODO/FIXME comments:"
    echo "$TODOS"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['todo', 'quality', 'review', 'stop'],
  },
  {
    id: 'ensure-commits-pushed',
    name: 'Ensure Commits Are Pushed',
    description: 'Reminds to push commits before stopping',
    eventType: 'Stop',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  UNPUSHED=$(git log @{u}.. --oneline 2>/dev/null | wc -l)
  if [ "$UNPUSHED" -gt 0 ]; then
    echo "[Reminder] You have $UNPUSHED unpushed commit(s)."
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['git', 'push', 'reminder', 'stop'],
  },
  {
    id: 'generate-session-summary',
    name: 'Generate Session Summary',
    description: 'Creates a summary of changes made during the session',
    eventType: 'Stop',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date "+%Y-%m-%d_%H-%M-%S")

cd "$CWD" 2>/dev/null || exit 0

SUMMARY_DIR="$CWD/.claude-summaries"
mkdir -p "$SUMMARY_DIR"

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  {
    echo "# Session Summary - $TIMESTAMP"
    echo ""
    echo "## Files Modified"
    git status --short
    echo ""
    echo "## Recent Commits"
    git log --oneline -5
  } > "$SUMMARY_DIR/session-$TIMESTAMP.md"

  echo "[Summary] Saved to $SUMMARY_DIR/session-$TIMESTAMP.md"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['summary', 'session', 'documentation', 'stop'],
  },

  // ============================================================================
  // SUBAGENTSTART - All 5 (new event type)
  // ============================================================================
  {
    id: 'log-subagent-spawn',
    name: 'Log Subagent Spawn',
    description: 'Logs when subagents are spawned for tracking',
    eventType: 'SubagentStart',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

LOG_FILE="$CWD/.claude-subagents.log"
echo "[$TIMESTAMP] STARTED: $SUBAGENT" >> "$LOG_FILE"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'workflow',
    tags: ['logging', 'subagent', 'tracking', 'spawn'],
  },
  {
    id: 'setup-subagent-env',
    name: 'Set Up Subagent Environment',
    description: 'Configures environment variables for subagents',
    eventType: 'SubagentStart',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Set common environment variables for subagents
export SUBAGENT_MODE=true
export PROJECT_ROOT="$CWD"

echo "[Subagent] Environment configured"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'workflow',
    tags: ['environment', 'subagent', 'setup', 'config'],
  },
  {
    id: 'inject-subagent-context',
    name: 'Inject Subagent Context',
    description: 'Provides relevant context to subagents on startup',
    eventType: 'SubagentStart',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

echo "[Subagent: $SUBAGENT] Starting in $CWD"

# Output any relevant context files
if [ -f "$CWD/CLAUDE.md" ]; then
  echo "[Context] CLAUDE.md is available for project instructions"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['context', 'subagent', 'injection', 'startup'],
  },
  {
    id: 'limit-concurrent-subagents',
    name: 'Limit Concurrent Subagents',
    description: 'Tracks and limits the number of concurrent subagents',
    eventType: 'SubagentStart',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
MAX_SUBAGENTS=5

COUNT_FILE="$CWD/.claude-subagent-count"
mkdir -p "$(dirname "$COUNT_FILE")"

COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo "0")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"

if [ "$COUNT" -gt "$MAX_SUBAGENTS" ]; then
  echo "[Warning] $COUNT subagents running (max: $MAX_SUBAGENTS)"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'safety',
    tags: ['limit', 'concurrent', 'subagent', 'throttle'],
  },
  {
    id: 'notify-subagent-start',
    name: 'Notify on Subagent Start',
    description: 'Shows notification when a subagent starts',
    eventType: 'SubagentStart',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')

if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e "display notification \\"Subagent $SUBAGENT started\\" with title \\"Claude Code\\""
elif [[ -n "$WINDIR" ]]; then
  powershell -Command "[console]::beep(600,200)" 2>/dev/null
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['notification', 'subagent', 'start', 'alert'],
  },

  // ============================================================================
  // SUBAGENTSTOP - All 5 (new event type)
  // ============================================================================
  {
    id: 'log-subagent-completion',
    name: 'Log Subagent Completion',
    description: 'Logs when subagents finish their work',
    eventType: 'SubagentStop',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

LOG_FILE="$CWD/.claude-subagents.log"
echo "[$TIMESTAMP] STOPPED: $SUBAGENT" >> "$LOG_FILE"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'workflow',
    tags: ['logging', 'subagent', 'completion', 'tracking'],
  },
  {
    id: 'validate-subagent-output',
    name: 'Validate Subagent Output',
    description: 'Checks that subagent produced expected output',
    eventType: 'SubagentStop',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')

echo "[Subagent: $SUBAGENT] Completed"

# Add validation logic here if needed
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['validation', 'subagent', 'output', 'quality'],
  },
  {
    id: 'cleanup-subagent-resources',
    name: 'Clean Up Subagent Resources',
    description: 'Cleans up temporary resources created by subagent',
    eventType: 'SubagentStop',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Decrement subagent counter
COUNT_FILE="$CWD/.claude-subagent-count"
if [ -f "$COUNT_FILE" ]; then
  COUNT=$(cat "$COUNT_FILE")
  COUNT=$((COUNT - 1))
  if [ "$COUNT" -le 0 ]; then
    rm -f "$COUNT_FILE"
  else
    echo "$COUNT" > "$COUNT_FILE"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['cleanup', 'subagent', 'resources', 'stop'],
  },
  {
    id: 'report-subagent-metrics',
    name: 'Report Subagent Metrics',
    description: 'Reports metrics about subagent execution',
    eventType: 'SubagentStop',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%s)

METRICS_FILE="$CWD/.claude-metrics.log"
echo "$TIMESTAMP subagent_stop $SUBAGENT" >> "$METRICS_FILE"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 2000,
    category: 'workflow',
    tags: ['metrics', 'subagent', 'reporting', 'analytics'],
  },
  {
    id: 'notify-subagent-stop',
    name: 'Notify on Subagent Stop',
    description: 'Shows notification when a subagent finishes',
    eventType: 'SubagentStop',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
SUBAGENT=$(echo "$INPUT" | jq -r '.subagent_name // "unknown"')

if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e "display notification \\"Subagent $SUBAGENT finished\\" with title \\"Claude Code\\""
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['notification', 'subagent', 'stop', 'alert'],
  },

  // ============================================================================
  // PRECOMPACT - All 5 (new event type)
  // ============================================================================
  {
    id: 'backup-transcript',
    name: 'Backup Transcript Before Compact',
    description: 'Saves a copy of the transcript before compaction',
    eventType: 'PreCompact',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  BACKUP_DIR="$CWD/.claude-backups"
  mkdir -p "$BACKUP_DIR"
  cp "$TRANSCRIPT" "$BACKUP_DIR/transcript-$TIMESTAMP.json"
  echo "[Backup] Transcript saved to $BACKUP_DIR"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['backup', 'transcript', 'compact', 'archive'],
  },
  {
    id: 'save-important-context',
    name: 'Save Important Context',
    description: 'Extracts and saves important context before compaction',
    eventType: 'PreCompact',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

CONTEXT_DIR="$CWD/.claude-context"
mkdir -p "$CONTEXT_DIR"

# Save current state
{
  echo "# Context Snapshot - $TIMESTAMP"
  echo ""
  echo "## Git Status"
  git status --short 2>/dev/null || echo "Not a git repo"
  echo ""
  echo "## Recent Files"
  ls -lt 2>/dev/null | head -10
} > "$CONTEXT_DIR/snapshot-$TIMESTAMP.md"

echo "[Context] Snapshot saved"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['context', 'save', 'compact', 'snapshot'],
  },
  {
    id: 'export-to-markdown',
    name: 'Export Session to Markdown',
    description: 'Exports session content to markdown before compaction',
    eventType: 'PreCompact',
    matcher: 'manual',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

EXPORT_DIR="$CWD/.claude-exports"
mkdir -p "$EXPORT_DIR"

echo "[Export] Session exported to $EXPORT_DIR/session-$TIMESTAMP.md"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['export', 'markdown', 'compact', 'documentation'],
  },
  {
    id: 'archive-to-git',
    name: 'Archive Session to Git',
    description: 'Commits session artifacts to git before compaction',
    eventType: 'PreCompact',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  if [ -d ".claude-context" ]; then
    git add .claude-context/ 2>/dev/null
    git commit -m "chore: archive claude context before compact" --no-verify 2>/dev/null
    echo "[Archive] Context committed to git"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['git', 'archive', 'compact', 'commit'],
  },
  {
    id: 'notify-compact',
    name: 'Notify Before Compact',
    description: 'Shows notification before context compaction',
    eventType: 'PreCompact',
    matcher: '*',
    command: `#!/bin/bash
INPUT=$(cat)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')

if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e "display notification \\"Context compacting ($TRIGGER)\\" with title \\"Claude Code\\""
fi

echo "[PreCompact] Trigger: $TRIGGER"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'notifications',
    tags: ['notification', 'compact', 'alert', 'context'],
  },

  // ============================================================================
  // SESSIONSTART - Additional (need 4 more)
  // ============================================================================
  {
    id: 'check-dependencies',
    name: 'Check Dependencies on Start',
    description: 'Verifies required dependencies are installed on session start',
    eventType: 'SessionStart',
    matcher: 'startup',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
  echo "[SessionStart] Warning: node_modules not found. Run 'npm install'."
fi

if [ -f "requirements.txt" ] && ! pip list > /dev/null 2>&1; then
  echo "[SessionStart] Warning: Python dependencies may not be installed."
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['dependencies', 'check', 'startup', 'validation'],
  },
  {
    id: 'initialize-logging',
    name: 'Initialize Session Logging',
    description: 'Sets up logging infrastructure for the session',
    eventType: 'SessionStart',
    matcher: 'startup',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

LOG_DIR="$CWD/.claude-logs"
mkdir -p "$LOG_DIR"

echo "[$TIMESTAMP] Session started" >> "$LOG_DIR/session.log"
echo "[SessionStart] Logging initialized in $LOG_DIR"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['logging', 'initialize', 'startup', 'session'],
  },
  {
    id: 'restore-previous-state',
    name: 'Restore Previous State',
    description: 'Attempts to restore state from previous session',
    eventType: 'SessionStart',
    matcher: 'resume',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

STATE_FILE="$CWD/.claude-state.json"
if [ -f "$STATE_FILE" ]; then
  echo "[SessionStart] Previous state file found"
  cat "$STATE_FILE" | jq -r '.lastWorkingDir // empty' 2>/dev/null
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 3000,
    category: 'workflow',
    tags: ['restore', 'state', 'resume', 'session'],
  },
  {
    id: 'show-project-status',
    name: 'Show Project Status on Start',
    description: 'Displays project status information when session starts',
    eventType: 'SessionStart',
    matcher: 'startup',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Project Status]"
if [ -f "package.json" ]; then
  NAME=$(jq -r '.name // "unnamed"' package.json)
  VERSION=$(jq -r '.version // "0.0.0"' package.json)
  echo "  Name: $NAME v$VERSION"
fi

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  echo "  Branch: $BRANCH"
  CHANGES=$(git status --short | wc -l)
  echo "  Uncommitted changes: $CHANGES"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['status', 'project', 'startup', 'info'],
  },

  // ============================================================================
  // SESSIONEND - Additional (need 4 more)
  // ============================================================================
  {
    id: 'save-session-summary',
    name: 'Save Session Summary',
    description: 'Creates a summary of the session when it ends',
    eventType: 'SessionEnd',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

SUMMARY_DIR="$CWD/.claude-summaries"
mkdir -p "$SUMMARY_DIR"

{
  echo "# Session End Summary"
  echo "End Reason: $REASON"
  echo "Time: $(date)"
} > "$SUMMARY_DIR/end-$TIMESTAMP.md"

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['summary', 'session', 'end', 'documentation'],
  },
  {
    id: 'cleanup-temp-files',
    name: 'Clean Up Temp Files',
    description: 'Removes temporary files created during the session',
    eventType: 'SessionEnd',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Clean up common temp files
rm -f "$CWD/.claude-rate-limit" 2>/dev/null
rm -f "$CWD/.claude-failure-count" 2>/dev/null
rm -f "$CWD/.claude-subagent-count" 2>/dev/null

echo "[Cleanup] Temporary files removed"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'workflow',
    tags: ['cleanup', 'temp', 'session', 'end'],
  },
  {
    id: 'push-pending-commits',
    name: 'Push Pending Commits',
    description: 'Attempts to push any pending commits when session ends',
    eventType: 'SessionEnd',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  UNPUSHED=$(git log @{u}.. --oneline 2>/dev/null | wc -l)
  if [ "$UNPUSHED" -gt 0 ]; then
    echo "[SessionEnd] Pushing $UNPUSHED pending commit(s)..."
    git push 2>/dev/null && echo "[SessionEnd] Push successful" || echo "[SessionEnd] Push failed - manual push required"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 30000,
    category: 'workflow',
    tags: ['git', 'push', 'session', 'end'],
  },
  {
    id: 'archive-session-logs',
    name: 'Archive Session Logs',
    description: 'Archives log files when session ends',
    eventType: 'SessionEnd',
    matcher: null,
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

LOG_DIR="$CWD/.claude-logs"
ARCHIVE_DIR="$CWD/.claude-archives"

if [ -d "$LOG_DIR" ]; then
  mkdir -p "$ARCHIVE_DIR"
  tar -czf "$ARCHIVE_DIR/logs-$TIMESTAMP.tar.gz" -C "$CWD" .claude-logs 2>/dev/null
  echo "[Archive] Logs archived to $ARCHIVE_DIR"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'workflow',
    tags: ['archive', 'logs', 'session', 'end'],
  },

  // ============================================================================
  // SETUP HOOKS - Repo initialization and maintenance (5)
  // ============================================================================
  {
    id: 'setup-install-dependencies',
    name: 'Install Dependencies on Init',
    description: 'Automatically installs project dependencies when initializing a repo',
    eventType: 'Setup',
    matcher: 'init',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Setup] Checking for dependencies to install..."

# Node.js projects
if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
  echo "[Setup] Installing npm dependencies..."
  if [ -f "package-lock.json" ]; then
    npm ci 2>&1
  elif [ -f "yarn.lock" ]; then
    yarn install --frozen-lockfile 2>&1
  elif [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile 2>&1
  else
    npm install 2>&1
  fi
  echo "[Setup] npm dependencies installed"
fi

# Python projects
if [ -f "requirements.txt" ] && [ ! -d "venv" ] && [ ! -d ".venv" ]; then
  echo "[Setup] Installing Python dependencies..."
  python3 -m venv venv 2>/dev/null
  source venv/bin/activate 2>/dev/null
  pip install -r requirements.txt 2>&1
  echo "[Setup] Python dependencies installed"
fi

# Go projects
if [ -f "go.mod" ]; then
  echo "[Setup] Downloading Go modules..."
  go mod download 2>&1
  echo "[Setup] Go modules downloaded"
fi

# Rust projects
if [ -f "Cargo.toml" ]; then
  echo "[Setup] Building Rust project..."
  cargo build 2>&1
  echo "[Setup] Rust project built"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 300000,
    category: 'setup',
    tags: ['dependencies', 'install', 'init', 'npm', 'pip', 'go', 'rust'],
  },
  {
    id: 'setup-run-migrations',
    name: 'Run Database Migrations',
    description: 'Runs database migrations on repo initialization',
    eventType: 'Setup',
    matcher: 'init',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Setup] Checking for database migrations..."

# Prisma
if [ -f "prisma/schema.prisma" ]; then
  echo "[Setup] Running Prisma migrations..."
  npx prisma migrate dev --skip-generate 2>&1 || npx prisma db push 2>&1
  npx prisma generate 2>&1
  echo "[Setup] Prisma migrations complete"
fi

# Drizzle
if [ -f "drizzle.config.ts" ] || [ -f "drizzle.config.js" ]; then
  echo "[Setup] Running Drizzle migrations..."
  npx drizzle-kit push 2>&1 || npx drizzle-kit migrate 2>&1
  echo "[Setup] Drizzle migrations complete"
fi

# Django
if [ -f "manage.py" ]; then
  echo "[Setup] Running Django migrations..."
  python manage.py migrate 2>&1
  echo "[Setup] Django migrations complete"
fi

# Rails
if [ -f "Gemfile" ] && [ -d "db/migrate" ]; then
  echo "[Setup] Running Rails migrations..."
  bundle exec rails db:migrate 2>&1
  echo "[Setup] Rails migrations complete"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 120000,
    category: 'setup',
    tags: ['database', 'migrations', 'prisma', 'drizzle', 'django', 'rails'],
  },
  {
    id: 'setup-generate-env',
    name: 'Generate .env from Template',
    description: 'Creates .env file from .env.example if it does not exist',
    eventType: 'Setup',
    matcher: 'init',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Setup] Checking environment configuration..."

# Copy .env.example to .env if .env doesn't exist
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
  cp .env.example .env
  echo "[Setup] Created .env from .env.example"
  echo "[Setup] Please update .env with your actual values"
elif [ -f ".env.template" ] && [ ! -f ".env" ]; then
  cp .env.template .env
  echo "[Setup] Created .env from .env.template"
  echo "[Setup] Please update .env with your actual values"
elif [ -f ".env.sample" ] && [ ! -f ".env" ]; then
  cp .env.sample .env
  echo "[Setup] Created .env from .env.sample"
  echo "[Setup] Please update .env with your actual values"
elif [ -f ".env" ]; then
  echo "[Setup] .env file already exists"
else
  echo "[Setup] No .env template found"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 5000,
    category: 'setup',
    tags: ['env', 'environment', 'config', 'template', 'init'],
  },
  {
    id: 'setup-maintenance-cleanup',
    name: 'Cleanup Stale Files',
    description: 'Removes stale cache files and temporary data during maintenance',
    eventType: 'Setup',
    matcher: 'maintenance',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Maintenance] Running cleanup tasks..."

# Clean npm cache
if [ -d "node_modules/.cache" ]; then
  rm -rf node_modules/.cache
  echo "[Maintenance] Cleared node_modules/.cache"
fi

# Clean Next.js cache
if [ -d ".next" ]; then
  rm -rf .next/cache
  echo "[Maintenance] Cleared .next/cache"
fi

# Clean Vite cache
if [ -d "node_modules/.vite" ]; then
  rm -rf node_modules/.vite
  echo "[Maintenance] Cleared Vite cache"
fi

# Clean Python cache
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null
find . -type f -name "*.pyc" -delete 2>/dev/null
echo "[Maintenance] Cleared Python cache"

# Clean old log files (older than 7 days)
if [ -d ".claude-logs" ]; then
  find .claude-logs -type f -mtime +7 -delete 2>/dev/null
  echo "[Maintenance] Cleaned old log files"
fi

echo "[Maintenance] Cleanup complete"
exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 60000,
    category: 'setup',
    tags: ['maintenance', 'cleanup', 'cache', 'temp'],
  },
  {
    id: 'setup-validate-project',
    name: 'Validate Project Structure',
    description: 'Validates that required project files and directories exist',
    eventType: 'Setup',
    matcher: 'init',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

echo "[Setup] Validating project structure..."

WARNINGS=0

# Check for README
if [ ! -f "README.md" ] && [ ! -f "readme.md" ]; then
  echo "[Warning] No README.md found"
  WARNINGS=$((WARNINGS + 1))
fi

# Check for .gitignore
if [ ! -f ".gitignore" ]; then
  echo "[Warning] No .gitignore found"
  WARNINGS=$((WARNINGS + 1))
fi

# Check for license
if [ ! -f "LICENSE" ] && [ ! -f "LICENSE.md" ] && [ ! -f "license" ]; then
  echo "[Warning] No LICENSE file found"
  WARNINGS=$((WARNINGS + 1))
fi

# Node.js specific checks
if [ -f "package.json" ]; then
  # Check for lock file
  if [ ! -f "package-lock.json" ] && [ ! -f "yarn.lock" ] && [ ! -f "pnpm-lock.yaml" ]; then
    echo "[Warning] No lock file found (package-lock.json, yarn.lock, or pnpm-lock.yaml)"
    WARNINGS=$((WARNINGS + 1))
  fi

  # Check for TypeScript config
  if grep -q "typescript" package.json 2>/dev/null && [ ! -f "tsconfig.json" ]; then
    echo "[Warning] TypeScript detected but no tsconfig.json found"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

if [ $WARNINGS -eq 0 ]; then
  echo "[Setup] Project structure looks good!"
else
  echo "[Setup] Found $WARNINGS warning(s)"
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 10000,
    category: 'setup',
    tags: ['validation', 'structure', 'init', 'check'],
  },
  {
    id: 'setup-git-hooks',
    name: 'Install Git Hooks',
    description: 'Sets up git hooks (husky, pre-commit) on repo initialization',
    eventType: 'Setup',
    matcher: 'init',
    command: `#!/bin/bash
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$CWD" 2>/dev/null || exit 0

# Check if in a git repo
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "[Setup] Not a git repository, skipping git hooks setup"
  exit 0
fi

echo "[Setup] Setting up git hooks..."

# Husky (Node.js)
if [ -f "package.json" ] && grep -q '"husky"' package.json 2>/dev/null; then
  if [ ! -d ".husky" ]; then
    echo "[Setup] Initializing Husky..."
    npx husky install 2>&1 || npx husky init 2>&1
    echo "[Setup] Husky initialized"
  else
    echo "[Setup] Husky already configured"
  fi
fi

# pre-commit (Python)
if [ -f ".pre-commit-config.yaml" ]; then
  if command -v pre-commit &> /dev/null; then
    echo "[Setup] Installing pre-commit hooks..."
    pre-commit install 2>&1
    echo "[Setup] pre-commit hooks installed"
  else
    echo "[Setup] pre-commit not found, skipping (install with: pip install pre-commit)"
  fi
fi

# lefthook
if [ -f "lefthook.yml" ] || [ -f ".lefthook.yml" ]; then
  if command -v lefthook &> /dev/null; then
    echo "[Setup] Installing lefthook..."
    lefthook install 2>&1
    echo "[Setup] lefthook installed"
  fi
fi

exit 0`,
    hookType: 'command',
    prompt: null,
    timeout: 30000,
    category: 'setup',
    tags: ['git', 'hooks', 'husky', 'pre-commit', 'init'],
  },
];
