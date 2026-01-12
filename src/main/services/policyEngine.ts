// ============================================================================
// POLICY ENGINE - Approval policy matching and execution
// ============================================================================
//
// This service implements the policy engine for automated approval handling.
// It matches permission requests against configured policies and determines
// whether to auto-approve, auto-deny, or queue for manual review.
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { getMainWindow } from '../window.js';
import {
  addToApprovalQueue,
  getApprovalQueueItem,
  getPendingApprovals,
  updateApprovalStatus,
  getEnabledApprovalPolicies,
  getAllApprovalPolicies,
  createApprovalPolicy,
  updateApprovalPolicy,
  deleteApprovalPolicy,
  getApprovalPolicy,
  type ApprovalQueueItem,
  type ApprovalPolicy,
} from '../database/hookEvents.js';

const logger = new Logger('PolicyEngine');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Permission request from Claude hooks
 */
export interface PermissionRequest {
  sessionId: string;
  permissionType: string;
  toolName?: string;
  filePath?: string;
  command?: string;
  details?: Record<string, unknown>;
}

/**
 * Policy match result
 */
export interface PolicyMatchResult {
  matched: boolean;
  policy: ApprovalPolicy | null;
  action: 'approve' | 'deny' | 'queue';
  reason: string;
}

/**
 * Approval decision
 */
export interface ApprovalDecision {
  approved: boolean;
  queueItem: ApprovalQueueItem | null;
  policyId: number | null;
  reason: string;
}

/**
 * Policy conditions parsed from JSON
 */
interface PolicyConditions {
  maxFileSize?: number;
  allowedPaths?: string[];
  blockedPaths?: string[];
  allowedCommands?: string[];
  blockedCommands?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  timeWindow?: {
    startHour: number;
    endHour: number;
  };
}

// ============================================================================
// POLICY ENGINE SERVICE
// ============================================================================

class PolicyEngineClass extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ============================================================================
  // POLICY MATCHING
  // ============================================================================

  /**
   * Process a permission request through the policy engine
   */
  async processPermissionRequest(request: PermissionRequest): Promise<ApprovalDecision> {
    logger.debug('Processing permission request', {
      type: request.permissionType,
      tool: request.toolName
    });

    // Get all enabled policies, sorted by priority
    const policies = getEnabledApprovalPolicies();

    // Try to match against each policy
    for (const policy of policies) {
      const matchResult = this.matchPolicy(policy, request);

      if (matchResult.matched) {
        logger.info(`Policy matched: ${policy.name}`, { action: policy.action });

        if (policy.action === 'auto-approve') {
          this.emit('permission:approved', { request, policy });
          this.notifyRenderer('permission:approved', { request, policyName: policy.name });

          return {
            approved: true,
            queueItem: null,
            policyId: policy.id,
            reason: `Auto-approved by policy: ${policy.name}`,
          };
        } else if (policy.action === 'auto-deny') {
          this.emit('permission:denied', { request, policy });
          this.notifyRenderer('permission:denied', { request, policyName: policy.name });

          return {
            approved: false,
            queueItem: null,
            policyId: policy.id,
            reason: `Auto-denied by policy: ${policy.name}`,
          };
        }
        // Fall through to queue if action is 'queue'
        break;
      }
    }

    // No policy matched or policy action is 'queue' - add to queue
    const queueItem = this.addToQueue(request);

    this.emit('permission:queued', { request, queueItem });
    this.notifyRenderer('permission:queued', queueItem);

    return {
      approved: false, // Not yet decided
      queueItem,
      policyId: null,
      reason: 'Queued for manual approval',
    };
  }

  /**
   * Match a policy against a permission request
   */
  private matchPolicy(policy: ApprovalPolicy, request: PermissionRequest): PolicyMatchResult {
    // Parse the matcher pattern
    const matcherResult = this.matchPattern(policy.matcher, request);

    if (!matcherResult) {
      return { matched: false, policy: null, action: 'queue', reason: 'Pattern did not match' };
    }

    // Check additional conditions if present
    if (policy.conditions) {
      try {
        const conditions = JSON.parse(policy.conditions) as PolicyConditions;
        const conditionsResult = this.checkConditions(conditions, request);

        if (!conditionsResult.passed) {
          return { matched: false, policy: null, action: 'queue', reason: conditionsResult.reason };
        }
      } catch {
        logger.warn('Failed to parse policy conditions', { policyId: policy.id });
      }
    }

    return {
      matched: true,
      policy,
      action: policy.action === 'auto-approve' ? 'approve' : policy.action === 'auto-deny' ? 'deny' : 'queue',
      reason: `Matched policy: ${policy.name}`,
    };
  }

  /**
   * Match a pattern against a permission request
   * Supports patterns like:
   * - "*" - Match all
   * - "Edit" - Match specific tool
   * - "Edit(src/*)" - Match tool with path pattern
   * - "Bash(npm *)" - Match command pattern
   * - "file:*.ts" - Match file extension
   */
  private matchPattern(pattern: string, request: PermissionRequest): boolean {
    // Wildcard matches everything
    if (pattern === '*') {
      return true;
    }

    // Check for tool match with optional path/command pattern
    const toolMatch = pattern.match(/^(\w+)(?:\((.+)\))?$/);
    if (toolMatch) {
      const [, toolName, subPattern] = toolMatch;

      // Tool name must match
      if (request.toolName && request.toolName !== toolName) {
        return false;
      }

      // If there's a sub-pattern, check it
      if (subPattern) {
        return this.matchSubPattern(subPattern, request);
      }

      return request.toolName === toolName;
    }

    // Check for file pattern
    if (pattern.startsWith('file:')) {
      const filePattern = pattern.slice(5);
      return this.matchGlobPattern(filePattern, request.filePath || '');
    }

    // Check for permission type match
    if (pattern.startsWith('permission:')) {
      const permType = pattern.slice(11);
      return request.permissionType === permType;
    }

    // Direct string match on permission type
    return request.permissionType === pattern;
  }

  /**
   * Match a sub-pattern (path or command pattern)
   */
  private matchSubPattern(pattern: string, request: PermissionRequest): boolean {
    // For file operations, match against file path
    if (request.filePath) {
      return this.matchGlobPattern(pattern, request.filePath);
    }

    // For bash commands, match against command
    if (request.command) {
      return this.matchGlobPattern(pattern, request.command);
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   * Supports * for any characters and ** for recursive
   */
  private matchGlobPattern(pattern: string, value: string): boolean {
    // Escape special regex characters except *
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{DOUBLE_STAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{DOUBLE_STAR\}\}/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(value);
  }

  /**
   * Check additional policy conditions
   */
  private checkConditions(
    conditions: PolicyConditions,
    request: PermissionRequest
  ): { passed: boolean; reason: string } {
    // Check allowed paths
    if (conditions.allowedPaths && request.filePath) {
      const filePath = request.filePath;
      const allowed = conditions.allowedPaths.some(p =>
        this.matchGlobPattern(p, filePath)
      );
      if (!allowed) {
        return { passed: false, reason: 'Path not in allowed list' };
      }
    }

    // Check blocked paths
    if (conditions.blockedPaths && request.filePath) {
      const filePath = request.filePath;
      const blocked = conditions.blockedPaths.some(p =>
        this.matchGlobPattern(p, filePath)
      );
      if (blocked) {
        return { passed: false, reason: 'Path is blocked' };
      }
    }

    // Check allowed commands
    if (conditions.allowedCommands && request.command) {
      const command = request.command;
      const allowed = conditions.allowedCommands.some(c =>
        this.matchGlobPattern(c, command)
      );
      if (!allowed) {
        return { passed: false, reason: 'Command not in allowed list' };
      }
    }

    // Check blocked commands
    if (conditions.blockedCommands && request.command) {
      const command = request.command;
      const blocked = conditions.blockedCommands.some(c =>
        this.matchGlobPattern(c, command)
      );
      if (blocked) {
        return { passed: false, reason: 'Command is blocked' };
      }
    }

    // Check allowed tools
    if (conditions.allowedTools && request.toolName) {
      if (!conditions.allowedTools.includes(request.toolName)) {
        return { passed: false, reason: 'Tool not in allowed list' };
      }
    }

    // Check blocked tools
    if (conditions.blockedTools && request.toolName) {
      if (conditions.blockedTools.includes(request.toolName)) {
        return { passed: false, reason: 'Tool is blocked' };
      }
    }

    // Check time window
    if (conditions.timeWindow) {
      const now = new Date();
      const currentHour = now.getHours();
      const { startHour, endHour } = conditions.timeWindow;

      if (startHour <= endHour) {
        // Normal range (e.g., 9-17)
        if (currentHour < startHour || currentHour >= endHour) {
          return { passed: false, reason: 'Outside allowed time window' };
        }
      } else {
        // Overnight range (e.g., 22-6)
        if (currentHour < startHour && currentHour >= endHour) {
          return { passed: false, reason: 'Outside allowed time window' };
        }
      }
    }

    return { passed: true, reason: 'All conditions passed' };
  }

  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================

  /**
   * Add a permission request to the approval queue
   */
  private addToQueue(request: PermissionRequest): ApprovalQueueItem {
    return addToApprovalQueue({
      sessionId: request.sessionId,
      requestType: request.permissionType,
      requestDetails: JSON.stringify({
        toolName: request.toolName,
        filePath: request.filePath,
        command: request.command,
        details: request.details,
      }),
    });
  }

  /**
   * Approve a queued item
   */
  approveItem(itemId: number, byUser: boolean = true): void {
    updateApprovalStatus(itemId, 'approved', byUser ? 'user' : 'policy');

    const item = getApprovalQueueItem(itemId);
    this.emit('queue:approved', { item });
    this.notifyRenderer('queue:item-updated', item);
  }

  /**
   * Deny a queued item
   */
  denyItem(itemId: number, byUser: boolean = true): void {
    updateApprovalStatus(itemId, 'denied', byUser ? 'user' : 'policy');

    const item = getApprovalQueueItem(itemId);
    this.emit('queue:denied', { item });
    this.notifyRenderer('queue:item-updated', item);
  }

  /**
   * Batch approve multiple items
   */
  batchApprove(itemIds: number[]): void {
    for (const id of itemIds) {
      this.approveItem(id, true);
    }
    this.emit('queue:batch-approved', { itemIds });
    this.notifyRenderer('queue:batch-updated', { approved: itemIds });
  }

  /**
   * Batch deny multiple items
   */
  batchDeny(itemIds: number[]): void {
    for (const id of itemIds) {
      this.denyItem(id, true);
    }
    this.emit('queue:batch-denied', { itemIds });
    this.notifyRenderer('queue:batch-updated', { denied: itemIds });
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(sessionId?: string): ApprovalQueueItem[] {
    return getPendingApprovals(sessionId);
  }

  /**
   * Get queue item by ID
   */
  getQueueItem(id: number): ApprovalQueueItem | null {
    return getApprovalQueueItem(id);
  }

  // ============================================================================
  // POLICY MANAGEMENT
  // ============================================================================

  /**
   * Create a new policy
   */
  createPolicy(policy: {
    name: string;
    matcher: string;
    action: 'auto-approve' | 'auto-deny' | 'queue';
    priority?: number;
    conditions?: PolicyConditions;
    enabled?: boolean;
  }): ApprovalPolicy {
    const created = createApprovalPolicy({
      name: policy.name,
      matcher: policy.matcher,
      action: policy.action,
      priority: policy.priority ?? 0,
      conditions: policy.conditions ? JSON.stringify(policy.conditions) : null,
      enabled: policy.enabled ?? true,
    });

    this.emit('policy:created', created);
    this.notifyRenderer('policy:updated', { policies: this.getAllPolicies() });

    return created;
  }

  /**
   * Update a policy
   */
  updatePolicy(id: number, updates: Partial<{
    name: string;
    matcher: string;
    action: 'auto-approve' | 'auto-deny' | 'queue';
    priority: number;
    conditions: PolicyConditions | null;
    enabled: boolean;
  }>): void {
    const { conditions, ...rest } = updates;
    const updateObj: Partial<ApprovalPolicy> = { ...rest };
    if (conditions !== undefined) {
      updateObj.conditions = conditions ? JSON.stringify(conditions) : null;
    }

    updateApprovalPolicy(id, updateObj);

    this.emit('policy:updated', { id, updates });
    this.notifyRenderer('policy:updated', { policies: this.getAllPolicies() });
  }

  /**
   * Delete a policy
   */
  deletePolicy(id: number): void {
    deleteApprovalPolicy(id);

    this.emit('policy:deleted', { id });
    this.notifyRenderer('policy:updated', { policies: this.getAllPolicies() });
  }

  /**
   * Get all policies
   */
  getAllPolicies(): ApprovalPolicy[] {
    return getAllApprovalPolicies();
  }

  /**
   * Get enabled policies
   */
  getEnabledPolicies(): ApprovalPolicy[] {
    return getEnabledApprovalPolicies();
  }

  /**
   * Get a policy by ID
   */
  getPolicy(id: number): ApprovalPolicy | null {
    return getApprovalPolicy(id);
  }

  /**
   * Install default policies
   */
  installDefaultPolicies(): void {
    const defaults: Array<{
      name: string;
      matcher: string;
      action: 'auto-approve' | 'auto-deny' | 'queue';
      priority: number;
      conditions?: PolicyConditions;
    }> = [
      {
        name: 'Allow Read Operations',
        matcher: 'Read',
        action: 'auto-approve',
        priority: 100,
      },
      {
        name: 'Allow Glob Operations',
        matcher: 'Glob',
        action: 'auto-approve',
        priority: 100,
      },
      {
        name: 'Allow Grep Operations',
        matcher: 'Grep',
        action: 'auto-approve',
        priority: 100,
      },
      {
        name: 'Allow Test Files Edit',
        matcher: 'Edit(*.test.*)',
        action: 'auto-approve',
        priority: 90,
        conditions: {
          allowedPaths: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.spec.ts'],
        },
      },
      {
        name: 'Block Env File Changes',
        matcher: 'file:.env*',
        action: 'auto-deny',
        priority: 200,
      },
      {
        name: 'Block Credential Files',
        matcher: 'file:*credential*',
        action: 'auto-deny',
        priority: 200,
        conditions: {
          blockedPaths: ['**/*credential*', '**/*secret*', '**/*password*'],
        },
      },
    ];

    for (const policy of defaults) {
      // Check if policy with same name already exists
      const existing = this.getAllPolicies().find(p => p.name === policy.name);
      if (!existing) {
        this.createPolicy(policy);
      }
    }

    logger.info('Default policies installed');
  }

  /**
   * Notify the renderer process
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let policyEngine: PolicyEngineClass | null = null;

export function getPolicyEngine(): PolicyEngineClass {
  if (!policyEngine) {
    policyEngine = new PolicyEngineClass();
  }
  return policyEngine;
}

export function initializePolicyEngine(): PolicyEngineClass {
  policyEngine = new PolicyEngineClass();
  return policyEngine;
}

export { PolicyEngineClass };
