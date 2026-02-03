// ============================================================================
// AGENT SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by provider/agent IPC handlers.
// Focuses on MCP servers (which may contain API keys and sensitive data),
// agent templates, and related primitives.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  mcpTransportSchema,
  mcpScopeSchema,
  mcpStatusSchema,
  createMCPServerSchema,
  updateMCPServerSchema,
  setMCPServerStatusSchema,
  createAgentTemplateSchema,
  updateAgentTemplateSchema,
  agentStatusSchema,
  createAgentRegistryEntrySchema,
  updateAgentRegistryEntrySchema,
  createSkillSchema,
  updateSkillSchema,
  createTaskDefinitionSchema,
  updateTaskDefinitionSchema,
  createSessionAnalyticsSchema,
  recordToolUsageSchema,
} from './agents.js';
import { numericIdSchema, sessionIdSchema } from './primitives.js';

// ============================================================================
// MCP TRANSPORT SCHEMA TESTS
// ============================================================================

describe('mcpTransportSchema', () => {
  it('accepts "stdio"', () => {
    expect(mcpTransportSchema.safeParse('stdio').success).toBe(true);
  });

  it('accepts "http"', () => {
    expect(mcpTransportSchema.safeParse('http').success).toBe(true);
  });

  it('rejects invalid transport types', () => {
    const invalidTransports = ['tcp', 'websocket', 'grpc', '', null, undefined, 123];
    invalidTransports.forEach((transport) => {
      expect(mcpTransportSchema.safeParse(transport).success).toBe(false);
    });
  });
});

// ============================================================================
// MCP SCOPE SCHEMA TESTS
// ============================================================================

describe('mcpScopeSchema', () => {
  it('accepts "user"', () => {
    expect(mcpScopeSchema.safeParse('user').success).toBe(true);
  });

  it('accepts "project"', () => {
    expect(mcpScopeSchema.safeParse('project').success).toBe(true);
  });

  it('rejects invalid scopes', () => {
    const invalidScopes = ['global', 'system', 'admin', '', null, undefined];
    invalidScopes.forEach((scope) => {
      expect(mcpScopeSchema.safeParse(scope).success).toBe(false);
    });
  });
});

// ============================================================================
// CREATE MCP SERVER SCHEMA TESTS
// ============================================================================

describe('createMCPServerSchema', () => {
  describe('valid servers', () => {
    it('accepts valid stdio server', () => {
      const server = {
        name: 'My MCP Server',
        transport: 'stdio',
        command: 'node server.js',
        args: ['--port', '3000'],
        env: { NODE_ENV: 'production' },
        scope: 'user',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });

    it('accepts valid http server', () => {
      const server = {
        name: 'HTTP MCP Server',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });

    it('accepts server with description', () => {
      const server = {
        name: 'Test Server',
        description: 'A test MCP server for development',
        transport: 'stdio',
        command: 'python server.py',
        enabled: false,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });

    it('accepts server with project scope and path', () => {
      const server = {
        name: 'Project Server',
        transport: 'stdio',
        command: './run.sh',
        scope: 'project',
        projectPath: '/home/user/my-project',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid servers', () => {
    it('rejects empty name', () => {
      const server = {
        name: '',
        transport: 'stdio',
        command: 'node server.js',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects name that is too long', () => {
      const server = {
        name: 'a'.repeat(201),
        transport: 'stdio',
        command: 'node server.js',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects stdio server without command', () => {
      const server = {
        name: 'Invalid Server',
        transport: 'stdio',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects http server without url', () => {
      const server = {
        name: 'Invalid Server',
        transport: 'http',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects invalid URL for http transport', () => {
      const server = {
        name: 'Invalid Server',
        transport: 'http',
        url: 'not-a-valid-url',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects missing enabled field', () => {
      const server = {
        name: 'Server',
        transport: 'stdio',
        command: 'node server.js',
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });
  });

  describe('environment variables validation', () => {
    it('accepts valid environment variables', () => {
      const server = {
        name: 'Server with env',
        transport: 'stdio',
        command: 'node server.js',
        env: {
          NODE_ENV: 'production',
          API_KEY: 'sk-test-1234567890',
          DEBUG: 'true',
        },
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });

    it('accepts empty environment variables', () => {
      const server = {
        name: 'Server',
        transport: 'stdio',
        command: 'node server.js',
        env: {},
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });

    it('accepts environment variables with long values (for API keys)', () => {
      const server = {
        name: 'Server with API key',
        transport: 'stdio',
        command: 'node server.js',
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(100),
          OPENAI_API_KEY: 'sk-proj-' + 'y'.repeat(100),
        },
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// UPDATE MCP SERVER SCHEMA TESTS
// ============================================================================

describe('updateMCPServerSchema', () => {
  it('accepts valid update with id and partial updates', () => {
    const update = {
      id: 1,
      updates: { name: 'Updated Name' },
    };
    const result = updateMCPServerSchema.safeParse(update);
    expect(result.success).toBe(true);
  });

  it('rejects update with invalid id', () => {
    const update = {
      id: -1,
      updates: { name: 'Updated Name' },
    };
    const result = updateMCPServerSchema.safeParse(update);
    expect(result.success).toBe(false);
  });

  it('rejects update with string id', () => {
    const update = {
      id: 'abc',
      updates: { name: 'Updated Name' },
    };
    const result = updateMCPServerSchema.safeParse(update);
    expect(result.success).toBe(false);
  });

  it('accepts empty updates object', () => {
    const update = {
      id: 1,
      updates: {},
    };
    const result = updateMCPServerSchema.safeParse(update);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SET MCP SERVER STATUS SCHEMA TESTS
// ============================================================================

describe('setMCPServerStatusSchema', () => {
  describe('valid statuses', () => {
    const validStatuses = ['connected', 'disconnected', 'error', 'unknown'];
    validStatuses.forEach((status) => {
      it(`accepts status "${status}"`, () => {
        const data = { id: 1, status };
        const result = setMCPServerStatusSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });
  });

  it('accepts status with error message', () => {
    const data = {
      id: 1,
      status: 'error',
      errorMessage: 'Connection refused',
    };
    const result = setMCPServerStatusSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const data = { id: 1, status: 'pending' };
    const result = setMCPServerStatusSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects error message that is too long', () => {
    const data = {
      id: 1,
      status: 'error',
      errorMessage: 'x'.repeat(5001),
    };
    const result = setMCPServerStatusSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// AGENT TEMPLATE SCHEMA TESTS
// ============================================================================

describe('createAgentTemplateSchema', () => {
  it('accepts valid template', () => {
    const template = {
      id: 'agent-template-001',
      name: 'Backend Engineer',
      description: 'Specializes in API development',
      flags: ['--verbose', '--no-cache'],
      model: 'claude-3-opus',
      permissionMode: 'plan',
      enabled: true,
    };
    const result = createAgentTemplateSchema.safeParse(template);
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const template = {
      id: 'agent-001',
      name: '',
    };
    const result = createAgentTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  it('accepts template with allowed/denied tools', () => {
    const template = {
      id: 'agent-002',
      name: 'Safe Agent',
      allowedTools: ['Read', 'Grep', 'Glob'],
      deniedTools: ['Bash', 'Write'],
    };
    const result = createAgentTemplateSchema.safeParse(template);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// AGENT REGISTRY SCHEMA TESTS
// ============================================================================

describe('createAgentRegistryEntrySchema', () => {
  it('accepts valid agent entry', () => {
    const entry = {
      id: 'agent-123',
      name: 'Task Runner',
      cwd: '/home/user/project',
      status: 'spawning',
    };
    const result = createAgentRegistryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts all valid status values', () => {
    const statuses = ['spawning', 'ready', 'active', 'idle', 'completed', 'error', 'terminated'];
    statuses.forEach((status) => {
      const entry = {
        id: 'agent-test',
        name: 'Test Agent',
        cwd: '/tmp',
        status,
      };
      const result = createAgentRegistryEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });
  });

  it('rejects invalid status', () => {
    const entry = {
      id: 'agent-test',
      name: 'Test Agent',
      cwd: '/tmp',
      status: 'running', // invalid
    };
    const result = createAgentRegistryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

describe('updateAgentRegistryEntrySchema', () => {
  it('accepts valid update', () => {
    const update = {
      id: 'agent-123',
      updates: { status: 'completed' },
    };
    const result = updateAgentRegistryEntrySchema.safeParse(update);
    expect(result.success).toBe(true);
  });

  it('accepts update with error message', () => {
    const update = {
      id: 'agent-123',
      updates: { status: 'error', errorMessage: 'Process crashed' },
    };
    const result = updateAgentRegistryEntrySchema.safeParse(update);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SKILL SCHEMA TESTS
// ============================================================================

describe('createSkillSchema', () => {
  it('accepts valid skill', () => {
    const skill = {
      name: 'TypeScript Expert',
      description: 'Expertise in TypeScript development',
      content: '# TypeScript Skill\n\nDetails...',
      scope: 'user',
    };
    const result = createSkillSchema.safeParse(skill);
    expect(result.success).toBe(true);
  });

  it('rejects skill without content', () => {
    const skill = {
      name: 'Empty Skill',
      content: '',
    };
    const result = createSkillSchema.safeParse(skill);
    expect(result.success).toBe(false);
  });

  it('accepts skill with allowed tools', () => {
    const skill = {
      name: 'Safe Skill',
      content: 'Content here',
      allowedTools: ['Read', 'Grep'],
    };
    const result = createSkillSchema.safeParse(skill);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// TASK DEFINITION SCHEMA TESTS
// ============================================================================

describe('createTaskDefinitionSchema', () => {
  it('accepts valid task definition', () => {
    const task = {
      name: 'Daily Code Review',
      description: 'Automated code review task',
      prompt: 'Review all changed files and provide feedback',
      enabled: true,
    };
    const result = createTaskDefinitionSchema.safeParse(task);
    expect(result.success).toBe(true);
  });

  it('rejects task without prompt', () => {
    const task = {
      name: 'Invalid Task',
      prompt: '',
      enabled: true,
    };
    const result = createTaskDefinitionSchema.safeParse(task);
    expect(result.success).toBe(false);
  });

  it('accepts task with schedule (cron)', () => {
    const task = {
      name: 'Scheduled Task',
      prompt: 'Run this daily',
      schedule: '0 9 * * *',
      enabled: true,
    };
    const result = createTaskDefinitionSchema.safeParse(task);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SESSION ANALYTICS SCHEMA TESTS
// ============================================================================

describe('createSessionAnalyticsSchema', () => {
  it('accepts valid session analytics', () => {
    const analytics = {
      sessionId: '12345678-1234-1234-1234-123456789012',
      successScore: 0.85,
      iterationCount: 5,
      toolEfficiency: 0.92,
    };
    const result = createSessionAnalyticsSchema.safeParse(analytics);
    expect(result.success).toBe(true);
  });

  it('rejects invalid session ID format', () => {
    const analytics = {
      sessionId: 'not-a-valid-uuid',
      successScore: 0.5,
    };
    const result = createSessionAnalyticsSchema.safeParse(analytics);
    expect(result.success).toBe(false);
  });

  it('accepts agent-* format session ID', () => {
    const analytics = {
      sessionId: 'agent-abc123',
      successScore: 0.75,
    };
    const result = createSessionAnalyticsSchema.safeParse(analytics);
    expect(result.success).toBe(true);
  });

  it('rejects success score out of range', () => {
    const analytics = {
      sessionId: '12345678-1234-1234-1234-123456789012',
      successScore: 1.5, // > 1
    };
    const result = createSessionAnalyticsSchema.safeParse(analytics);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TOOL USAGE SCHEMA TESTS
// ============================================================================

describe('recordToolUsageSchema', () => {
  it('accepts valid tool usage', () => {
    const usage = {
      sessionId: '12345678-1234-1234-1234-123456789012',
      toolName: 'Read',
      success: true,
      durationMs: 150,
    };
    const result = recordToolUsageSchema.safeParse(usage);
    expect(result.success).toBe(true);
  });

  it('accepts tool usage with optional fields', () => {
    const usage = {
      sessionId: null,
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolResultPreview: 'total 42...',
      success: false,
      durationMs: 5000,
      tokenCost: 150,
    };
    const result = recordToolUsageSchema.safeParse(usage);
    expect(result.success).toBe(true);
  });

  it('rejects empty tool name', () => {
    const usage = {
      toolName: '',
      success: true,
    };
    const result = recordToolUsageSchema.safeParse(usage);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('MCP server name injection prevention', () => {
    const injectionPayloads = [
      "'; DROP TABLE mcp_servers; --",
      '<script>alert(1)</script>',
      '${process.env.SECRET}',
      '$(whoami)',
      '`cat /etc/passwd`',
    ];

    injectionPayloads.forEach((payload) => {
      it(`allows but sanitizes name: "${payload.substring(0, 30)}..."`, () => {
        // Names should be allowed but will be sanitized/escaped at storage
        const server = {
          name: payload,
          transport: 'stdio',
          command: 'node server.js',
          enabled: true,
        };
        // Schema validates structure, SQL injection prevention is at DB layer
        const result = createMCPServerSchema.safeParse(server);
        // Name is valid string, injection is handled at storage layer
        expect(result.success).toBe(true);
      });
    });
  });

  describe('path traversal prevention in projectPath', () => {
    const pathTraversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/root/../etc/shadow',
    ];

    pathTraversalAttempts.forEach((attempt) => {
      it(`rejects path traversal: "${attempt}"`, () => {
        const server = {
          name: 'Test',
          transport: 'stdio',
          command: 'node server.js',
          projectPath: attempt,
          enabled: true,
        };
        const result = createMCPServerSchema.safeParse(server);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('command injection prevention', () => {
    it('allows command with shell metacharacters (sanitized at execution)', () => {
      // Commands may contain shell chars, injection prevention is at execution
      const server = {
        name: 'Test',
        transport: 'stdio',
        command: 'node server.js && echo pwned',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      // Schema validates structure, command injection prevention is at execution
      expect(result.success).toBe(true);
    });
  });

  describe('extremely long values', () => {
    it('rejects name exceeding limit', () => {
      const server = {
        name: 'x'.repeat(201),
        transport: 'stdio',
        command: 'node',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects description exceeding limit', () => {
      const server = {
        name: 'Test',
        description: 'x'.repeat(1001),
        transport: 'stdio',
        command: 'node',
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });

    it('rejects command exceeding limit', () => {
      const server = {
        name: 'Test',
        transport: 'stdio',
        command: 'x'.repeat(1001),
        enabled: true,
      };
      const result = createMCPServerSchema.safeParse(server);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// NUMERIC ID SCHEMA TESTS
// ============================================================================

describe('numericIdSchema', () => {
  it('accepts positive integers', () => {
    expect(numericIdSchema.safeParse(1).success).toBe(true);
    expect(numericIdSchema.safeParse(100).success).toBe(true);
    expect(numericIdSchema.safeParse(999999).success).toBe(true);
  });

  it('rejects zero', () => {
    expect(numericIdSchema.safeParse(0).success).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(numericIdSchema.safeParse(-1).success).toBe(false);
    expect(numericIdSchema.safeParse(-100).success).toBe(false);
  });

  it('rejects floats', () => {
    expect(numericIdSchema.safeParse(1.5).success).toBe(false);
    expect(numericIdSchema.safeParse(10.001).success).toBe(false);
  });

  it('rejects strings', () => {
    expect(numericIdSchema.safeParse('1').success).toBe(false);
    expect(numericIdSchema.safeParse('abc').success).toBe(false);
  });
});

// ============================================================================
// SESSION ID SCHEMA TESTS
// ============================================================================

describe('sessionIdSchema', () => {
  describe('valid UUIDs', () => {
    const validUUIDs = [
      '12345678-1234-1234-1234-123456789012',
      'abcdef12-abcd-abcd-abcd-abcdef123456',
      'ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456',
      '00000000-0000-0000-0000-000000000000',
    ];

    validUUIDs.forEach((uuid) => {
      it(`accepts UUID: ${uuid}`, () => {
        expect(sessionIdSchema.safeParse(uuid).success).toBe(true);
      });
    });
  });

  describe('valid agent IDs', () => {
    const validAgentIds = [
      'agent-abc123',
      'agent-xyz',
      'agent-1234567890',
    ];

    validAgentIds.forEach((id) => {
      it(`accepts agent ID: ${id}`, () => {
        expect(sessionIdSchema.safeParse(id).success).toBe(true);
      });
    });
  });

  describe('invalid session IDs', () => {
    const invalidIds = [
      '',
      'not-a-uuid',
      '12345678-1234-1234-1234', // incomplete
      '12345678-1234-1234-1234-1234567890123', // too long
      'agent-', // missing suffix
      // Note: 'AGENT-abc' is valid due to case-insensitive regex
    ];

    invalidIds.forEach((id) => {
      it(`rejects invalid ID: "${id}"`, () => {
        expect(sessionIdSchema.safeParse(id).success).toBe(false);
      });
    });
  });
});
