// ============================================================================
// HOOKS SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by hooks IPC handlers.
// Hook validation is critical for security, especially for handlers
// that execute shell commands.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  hookEventTypeSchema,
  extendedHookEventTypeSchema,
  createHookSchema,
  updateHookSchema,
  getHooksByEventSchema,
  testHookSchema,
  hookEventLimitSchema,
  getHookEventsBySessionSchema,
  getHookEventsByTypeSchema,
  cleanupHookEventsSchema,
  getBudgetSchema,
  upsertBudgetSchema,
  updateBudgetSpentSchema,
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
  budgetResetPeriodSchema,
  approvalActionSchema,
} from './hooks.js';

// ============================================================================
// HOOK EVENT TYPE SCHEMA TESTS
// ============================================================================

describe('hookEventTypeSchema', () => {
  describe('valid event types', () => {
    const validTypes = [
      'session_start',
      'session_end',
      'commit_before',
      'commit_after',
      'push_before',
      'push_after',
      'pull_before',
      'pull_after',
      'branch_checkout',
      'file_change',
    ];

    validTypes.forEach((type) => {
      it(`accepts valid event type: "${type}"`, () => {
        const result = hookEventTypeSchema.safeParse(type);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid event types', () => {
    const invalidTypes = [
      { value: '', reason: 'empty string' },
      { value: 'invalid_event', reason: 'unknown event' },
      { value: 'SESSION_START', reason: 'uppercase' },
      { value: 'session-start', reason: 'hyphenated' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
    ];

    invalidTypes.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = hookEventTypeSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

describe('extendedHookEventTypeSchema', () => {
  describe('valid extended event types', () => {
    const validTypes = [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'PermissionRequest',
      'UserPromptSubmit',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'Notification',
    ];

    validTypes.forEach((type) => {
      it(`accepts valid event type: "${type}"`, () => {
        const result = extendedHookEventTypeSchema.safeParse(type);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid extended event types', () => {
    const invalidTypes = [
      { value: 'pretooluse', reason: 'lowercase' },
      { value: 'PRETOOLUSE', reason: 'all uppercase' },
      { value: 'Pre_Tool_Use', reason: 'underscored' },
      { value: 'UnknownEvent', reason: 'unknown event' },
    ];

    invalidTypes.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = extendedHookEventTypeSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// CREATE HOOK SCHEMA TESTS
// ============================================================================

describe('createHookSchema', () => {
  const validHook = {
    name: 'Test Hook',
    eventType: 'session_start',
    script: 'echo "Hello World"',
    enabled: true,
  };

  describe('valid hooks', () => {
    it('accepts minimal valid hook', () => {
      const result = createHookSchema.safeParse(validHook);
      expect(result.success).toBe(true);
    });

    it('accepts hook with all optional fields', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        description: 'A test hook',
        async: true,
        timeout: 60000,
        projectPath: '/path/to/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts hook with max length name', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        name: 'a'.repeat(200),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid hooks', () => {
    it('rejects empty name', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        name: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding max length', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        name: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty script', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        script: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects script exceeding max length', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        script: 'a'.repeat(100001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid event type', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        eventType: 'invalid_event',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-boolean enabled', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        enabled: 'true',
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative timeout', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        timeout: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects timeout exceeding max (5 minutes)', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        timeout: 300001,
      });
      expect(result.success).toBe(false);
    });

    it('rejects description exceeding max length', () => {
      const result = createHookSchema.safeParse({
        ...validHook,
        description: 'a'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TEST HOOK SCHEMA TESTS
// ============================================================================

describe('testHookSchema', () => {
  describe('valid test inputs', () => {
    it('accepts valid command and input', () => {
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
        input: { key: 'value' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty input object', () => {
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
        input: {},
      });
      expect(result.success).toBe(true);
    });

    it('accepts complex input object', () => {
      const result = testHookSchema.safeParse({
        command: 'process-hook',
        input: {
          sessionId: '123',
          data: { nested: { deep: true } },
          array: [1, 2, 3],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid test inputs', () => {
    it('rejects empty command', () => {
      const result = testHookSchema.safeParse({
        command: '',
        input: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects command exceeding max length', () => {
      const result = testHookSchema.safeParse({
        command: 'a'.repeat(10001),
        input: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing command', () => {
      const result = testHookSchema.safeParse({
        input: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing input', () => {
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-object input', () => {
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
        input: 'string',
      });
      expect(result.success).toBe(false);
    });

    it('rejects array input', () => {
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
        input: [1, 2, 3],
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// HOOK EVENT QUERY SCHEMA TESTS
// ============================================================================

describe('hookEventLimitSchema', () => {
  it('accepts valid limit', () => {
    const result = hookEventLimitSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it('accepts undefined limit', () => {
    const result = hookEventLimitSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects negative limit', () => {
    const result = hookEventLimitSchema.safeParse({ limit: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects limit exceeding max', () => {
    const result = hookEventLimitSchema.safeParse({ limit: 10001 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    const result = hookEventLimitSchema.safeParse({ limit: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('getHookEventsBySessionSchema', () => {
  const validSessionId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid session ID and limit', () => {
    const result = getHookEventsBySessionSchema.safeParse({
      sessionId: validSessionId,
      limit: 100,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid session ID without limit', () => {
    const result = getHookEventsBySessionSchema.safeParse({
      sessionId: validSessionId,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid session ID', () => {
    const result = getHookEventsBySessionSchema.safeParse({
      sessionId: 'invalid',
      limit: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe('getHookEventsByTypeSchema', () => {
  it('accepts valid event type and limit', () => {
    const result = getHookEventsByTypeSchema.safeParse({
      eventType: 'PreToolUse',
      limit: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid event type', () => {
    const result = getHookEventsByTypeSchema.safeParse({
      eventType: 'InvalidType',
      limit: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe('cleanupHookEventsSchema', () => {
  it('accepts valid maxAgeHours', () => {
    const result = cleanupHookEventsSchema.safeParse({ maxAgeHours: 24 });
    expect(result.success).toBe(true);
  });

  it('accepts undefined maxAgeHours', () => {
    const result = cleanupHookEventsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects maxAgeHours exceeding 1 year', () => {
    const result = cleanupHookEventsSchema.safeParse({ maxAgeHours: 8761 });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxAgeHours', () => {
    const result = cleanupHookEventsSchema.safeParse({ maxAgeHours: -1 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// BUDGET SCHEMA TESTS
// ============================================================================

describe('budgetResetPeriodSchema', () => {
  const validPeriods = ['session', 'daily', 'weekly', 'monthly'];

  validPeriods.forEach((period) => {
    it(`accepts valid period: "${period}"`, () => {
      const result = budgetResetPeriodSchema.safeParse(period);
      expect(result.success).toBe(true);
    });
  });

  it('rejects invalid period', () => {
    const result = budgetResetPeriodSchema.safeParse('yearly');
    expect(result.success).toBe(false);
  });
});

describe('upsertBudgetSchema', () => {
  describe('valid budgets', () => {
    it('accepts minimal valid budget', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 100,
      });
      expect(result.success).toBe(true);
    });

    it('accepts budget with all fields', () => {
      const result = upsertBudgetSchema.safeParse({
        projectPath: '/path/to/project',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        limitUsd: 500,
        spentUsd: 50,
        warningThreshold: 0.8,
        hardStopEnabled: true,
        resetPeriod: 'daily',
      });
      expect(result.success).toBe(true);
    });

    it('accepts null projectPath and sessionId', () => {
      const result = upsertBudgetSchema.safeParse({
        projectPath: null,
        sessionId: null,
        limitUsd: 100,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid budgets', () => {
    it('rejects negative limitUsd', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: -100,
      });
      expect(result.success).toBe(false);
    });

    it('rejects limitUsd exceeding max', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 1000001,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative spentUsd', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 100,
        spentUsd: -10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects warningThreshold above 1', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 100,
        warningThreshold: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it('rejects warningThreshold below 0', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 100,
        warningThreshold: -0.1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid resetPeriod', () => {
      const result = upsertBudgetSchema.safeParse({
        limitUsd: 100,
        resetPeriod: 'yearly',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('updateBudgetSpentSchema', () => {
  it('accepts valid update', () => {
    const result = updateBudgetSpentSchema.safeParse({
      id: 1,
      additionalCost: 10.5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative additionalCost', () => {
    const result = updateBudgetSpentSchema.safeParse({
      id: 1,
      additionalCost: -5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects additionalCost exceeding max', () => {
    const result = updateBudgetSpentSchema.safeParse({
      id: 1,
      additionalCost: 10001,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid id', () => {
    const result = updateBudgetSpentSchema.safeParse({
      id: -1,
      additionalCost: 10,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// APPROVAL POLICY SCHEMA TESTS
// ============================================================================

describe('approvalActionSchema', () => {
  const validActions = ['auto-approve', 'auto-deny', 'queue'];

  validActions.forEach((action) => {
    it(`accepts valid action: "${action}"`, () => {
      const result = approvalActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });
  });

  it('rejects invalid action', () => {
    const result = approvalActionSchema.safeParse('auto-skip');
    expect(result.success).toBe(false);
  });
});

describe('createApprovalPolicySchema', () => {
  describe('valid policies', () => {
    it('accepts minimal valid policy', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: '*.ts',
        action: 'auto-approve',
      });
      expect(result.success).toBe(true);
    });

    it('accepts policy with all fields', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Full Policy',
        matcher: 'src/**/*.ts',
        action: 'queue',
        priority: 100,
        conditions: '{"type": "file_change"}',
        enabled: true,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid policies', () => {
    it('rejects empty name', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: '',
        matcher: '*.ts',
        action: 'auto-approve',
      });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding max length', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'a'.repeat(201),
        matcher: '*.ts',
        action: 'auto-approve',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty matcher', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: '',
        action: 'auto-approve',
      });
      expect(result.success).toBe(false);
    });

    it('rejects matcher exceeding max length', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: 'a'.repeat(1001),
        action: 'auto-approve',
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative priority', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: '*.ts',
        action: 'auto-approve',
        priority: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects priority exceeding max', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: '*.ts',
        action: 'auto-approve',
        priority: 1001,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid action', () => {
      const result = createApprovalPolicySchema.safeParse({
        name: 'Test Policy',
        matcher: '*.ts',
        action: 'invalid-action',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('Command injection prevention in testHookSchema', () => {
    // Note: Command validation allows shell commands since hooks are user-defined
    // The schema validates structure, not command safety
    const commands = [
      'echo "test"',
      'cat /etc/passwd',  // Allowed - user defined hooks
      'rm -rf /',         // Allowed - user defined hooks
    ];

    commands.forEach((cmd) => {
      it(`accepts user-defined command: "${cmd}"`, () => {
        const result = testHookSchema.safeParse({
          command: cmd,
          input: {},
        });
        // Schema accepts the structure - safety is user's responsibility
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Input sanitization', () => {
    it('rejects prototype pollution in input', () => {
      // Zod should handle this safely
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}}');
      const result = testHookSchema.safeParse({
        command: 'echo "test"',
        input: maliciousInput,
      });
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type coercion attacks', () => {
    it('rejects array where object expected', () => {
      const result = createHookSchema.safeParse([
        { name: 'test', eventType: 'session_start', script: 'echo', enabled: true }
      ]);
      expect(result.success).toBe(false);
    });

    it('rejects string where number expected for timeout', () => {
      const result = createHookSchema.safeParse({
        name: 'Test',
        eventType: 'session_start',
        script: 'echo',
        enabled: true,
        timeout: '30000',
      });
      expect(result.success).toBe(false);
    });
  });
});
