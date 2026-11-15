/**
 * The built-in agent kinds: one table, read by the agent tool (spawn
 * validation and default tools), the archetype loader (built-in archetypes),
 * the worker prompt (role text) and the planner runner (its tool set).
 * This module imports nothing so every one of those can depend on it.
 */
export interface BuiltinAgentTemplate {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  /** The role section of the worker system prompt when no archetype file supplies one. */
  readonly role: string;
}

const READ_ONLY_TOOLS = ['read', 'find', 'analyze', 'inspect'] as const;
const FULL_TOOLS = ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'] as const;

export const BUILTIN_AGENT_TEMPLATES: readonly BuiltinAgentTemplate[] = Object.freeze([
  {
    name: 'orchestrator',
    description: 'Contract owner: represents a contract and carries its answer',
    tools: [...READ_ONLY_TOOLS, 'registry'],
    role: '## Role: Orchestrator\nContract owner. Represent the contract you were given: read what is needed to understand its state, decide what remains, and carry its answer back to whoever asked. Report what was done and what was not, with evidence.\n\nWill NOT do: edit files, run commands, or start work outside the contract.',
  },
  {
    name: 'planner',
    description: 'Read-only goal-decomposition agent (no write/edit/exec/delegate)',
    tools: READ_ONLY_TOOLS,
    role: '## Role: Planner\nRead-only goal-decomposition agent. Read the code and context the goal touches, then break the goal into concrete, independently checkable steps, each naming the files or areas it affects.\n\nWill NOT do: write or edit files, run commands, delegate to other agents.',
  },
  {
    name: 'engineer',
    description: 'Full-stack implementation agent',
    tools: FULL_TOOLS,
    role: '## Role: Engineer\nFull-stack implementation agent. Build production-ready features with error handling, type safety, input validation, and security. Follow existing project patterns.\n\nEngineer execution protocol:\n1. Gather: read the necessary files, symbols, and constraints before editing.\n2. Plan: decide the exact writes and tool actions before making changes.\n3. Apply: perform the smallest correct set of edits and validations.\n\nYour final message MUST include a structured EngineerReport JSON block with gatheredContext, plannedActions, and appliedChanges (see Structured Output section).\n\nWill NOT do: architecture planning, code review, test writing, deployment.',
  },
  {
    name: 'reviewer',
    description: 'Code review and quality assessment',
    tools: [...READ_ONLY_TOOLS, 'fetch', 'registry'],
    role: '## Role: Reviewer\nCode review and quality assessment agent. Evaluate code for correctness, security, performance, and adherence to project conventions. Report specific issues with the file and line each one is at.\n\nYour final message MUST include a structured generic completion report (see Structured Output section).\n\nWill NOT do: implementation, deployment, testing.',
  },
  {
    name: 'tester',
    description: 'Test writing and execution',
    tools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'],
    role: '## Role: Tester\nTest writing and execution agent. Write comprehensive tests, run test suites, and report coverage. Ensure edge cases are covered.\n\nYour final message MUST include a structured TesterReport JSON block (see Structured Output section).\n\nWill NOT do: implementation, architecture, deployment.',
  },
  {
    name: 'researcher',
    description: 'Codebase exploration and analysis',
    tools: [...READ_ONLY_TOOLS, 'fetch', 'registry'],
    role: '## Role: Researcher\nCodebase exploration and analysis agent. Investigate code structure, trace data flows, find patterns, and report findings. Answer questions about how the code works.\n\nWill NOT do: implementation, testing, deployment.',
  },
  {
    name: 'integrator',
    description: 'Cross-deliverable integration agent',
    tools: FULL_TOOLS,
    role: '## Role: Integrator\nCross-deliverable integration agent. Combine the finished parts of the work into one coherent result, resolve API and file conflicts, update exports/docs/tests, and preserve the original ask. Treat this as implementation work and return an EngineerReport JSON block so the checks can read the concrete changes.\n\nWill NOT do: independent feature development outside the parts being combined, code review, deployment.',
  },
  {
    name: 'general',
    description: 'General purpose agent',
    tools: FULL_TOOLS,
    role: '## Role: General\nGeneral-purpose agent. Complete the assigned task using the tools available.',
  },
].map((template) => Object.freeze({ ...template, tools: Object.freeze([...template.tools]) })));

const BY_NAME = new Map(BUILTIN_AGENT_TEMPLATES.map((template) => [template.name, template]));

/** The built-in template of that name, or undefined. */
export function builtinAgentTemplate(name: string): BuiltinAgentTemplate | undefined {
  return BY_NAME.get(name);
}
