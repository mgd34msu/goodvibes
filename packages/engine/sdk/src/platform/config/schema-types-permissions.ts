/** Execution modes and explicit owner tool restrictions. */
export type PermissionMode = 'safe-owner' | 'safe-jev' | 'yolo' | 'plan'
  // Read-compatible saved settings; active mutations use the canonical modes.
  | 'prompt' | 'allow-all' | 'custom' | 'accept-edits';
export type PermissionAction = 'allow' | 'prompt' | 'deny';
/** Saved background mode aliases; execution follows the owning session. */
export type BackgroundAgentsMode = 'inherit' | 'allow-all';
export type LineNumberMode = 'all' | 'code' | 'off';

/** Deny blocks a tool in safe modes. Allow and saved prompt follow mode risk assessment. */
export interface PermissionsToolConfig {
  read?: PermissionAction;        // default: 'allow'
  write?: PermissionAction;       // default: 'prompt'
  edit?: PermissionAction;        // default: 'prompt'
  exec?: PermissionAction;        // default: 'prompt'
  find?: PermissionAction;        // default: 'allow'
  fetch?: PermissionAction;       // default: 'prompt'
  analyze?: PermissionAction;     // default: 'allow'
  inspect?: PermissionAction;     // default: 'allow'
  agent?: PermissionAction;       // default: 'prompt'
  state?: PermissionAction;       // default: 'allow'
  workflow?: PermissionAction;    // default: 'prompt'
  registry?: PermissionAction;    // default: 'allow'
  delegate?: PermissionAction;    // default: 'prompt'
  mcp?: PermissionAction;         // default: 'prompt'
}
