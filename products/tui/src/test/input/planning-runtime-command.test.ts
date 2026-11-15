import { describe, expect, test } from 'bun:test';
import type { ProjectPlanningService, ProjectPlanningState } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { KillRing } from '../../input/kill-ring.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { handlePromptTextToken, handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';

function makeState(input: Partial<ProjectPlanningState> = {}): ProjectPlanningState {
  const now = Date.now();
  return {
    id: input.id ?? 'current',
    projectId: input.projectId ?? 'proj',
    knowledgeSpaceId: input.knowledgeSpaceId ?? 'project:proj',
    goal: input.goal ?? '',
    scope: input.scope,
    knownContext: input.knownContext ?? [],
    openQuestions: input.openQuestions ?? [],
    answeredQuestions: input.answeredQuestions ?? [],
    decisions: input.decisions ?? [],
    assumptions: input.assumptions ?? [],
    constraints: input.constraints ?? [],
    risks: input.risks ?? [],
    tasks: input.tasks ?? [],
    dependencies: input.dependencies ?? [],
    verificationGates: input.verificationGates ?? [],
    agentAssignments: input.agentAssignments ?? [],
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    metadata: input.metadata ?? {},
  };
}

function makeService(initial: ProjectPlanningState | null = null): {
  readonly service: ProjectPlanningService;
  readonly state: () => ProjectPlanningState | null;
} {
  const state = initial;
  const service = {
    async status() {
      return {
        ok: true,
        projectId: 'proj',
        knowledgeSpaceId: 'project:proj',
        passiveOnly: true,
        counts: { states: state ? 1 : 0, decisions: 0, languageArtifacts: 0 },
        capabilities: ['project-scoped-storage'],
      };
    },
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state,
        ...(state ? { revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } } : {}) };
    },
  };
  return {
    service: service as unknown as ProjectPlanningService,
    state: () => state,
  };
}

function makeContext(
  service: ProjectPlanningService,
  out: string[],
  opened: string[],
  planManagerOverride: Record<string, unknown> = {},
): CommandContext {
  return {
    print: (message: string) => out.push(message),
    // Native entry and the explicit historical view have separate modal routes.
    openModal: (name: string) => { opened.push(name); },
    session: {
      runtime: {
        model: 'gpt-test',
        provider: 'test',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session',
      },
      conversationManager: {},
      sessionLineageTracker: {
        setOriginalTask: () => {},
      },
    },
    workspace: {
      projectPlanningService: service,
      projectPlanningProjectId: 'proj',
    },
    ops: {
      planManager: {
        getActive: () => null,
        getSummary: () => '',
        list: () => [],
        toMarkdown: () => '',
        dismiss: () => ({ outcome: 'no-active-plan' }),
        ...planManagerOverride,
      },
    },
    provider: {},
    platform: {},
    extensions: {},
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
}

// Regression: after coordinator removal, text containing 'plan' must reach orchestrator.handleUserInput.
// This test drives plan-keyword text through the real input routing layer (handlePromptTextToken +
// handlePromptKeyToken) and asserts that submitInput on CommandContext is called with the original text.
describe('submitInput plan-keyword regression (coordinator removed)', () => {
  test('text containing "plan" flows through real input routing and reaches submitInput unchanged', () => {
    const submitCalls: string[] = [];

    const commandContext = {
      submitInput: (text: string) => { submitCalls.push(text); },
    } as unknown as CommandContext;

    // Build initial prompt state (empty, not in command mode)
    const textState = {
      prompt: '',
      cursorPos: 0,
      commandMode: false,
      killRing: new KillRing(),
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      inputHistory: null,
      commandRegistry: new CommandRegistry(),
      commandContext,
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    };

    // Simulate user typing 'plan me a new feature' through the text route
    const afterText = handlePromptTextToken(textState, { type: 'text', value: 'plan me a new feature' });

    // Build key route state using the updated prompt from text routing
    const keyState = {
      prompt: afterText.prompt,
      cursorPos: afterText.cursorPos,
      killRing: new KillRing(),
      inputScrollTop: 0,
      commandMode: afterText.commandMode,
      contentWidth: 80,
      maxInputRows: 10,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      getBlockAnchorLine: () => 0,
      openAgentsView: () => {},
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      breakUndoCoalesce: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({
        wrappedLines: [afterText.prompt],
        segments: [],
        cursorWrappedLine: 0,
        cursorCol: afterText.cursorPos,
        visibleLines: [afterText.prompt],
        visibleCursorLine: 0,
        visibleCursorCol: afterText.cursorPos,
      }),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    };

    // Simulate pressing Enter, drives through real key routing which calls submitInput
    handlePromptKeyToken(keyState, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });

    // Plan-keyword text must reach submitInput unchanged, not swallowed, not intercepted
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toBe('plan me a new feature');
  });
});

describe('/project-plan project planning runtime command', () => {
  test('generic goal dispatch cannot seed historical state or fabricate owner input', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['replace', 'the', 'planning', 'modal'], makeContext(fake.service, out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Original owner input is required');
    expect(fake.state()).toBeNull();
  });

  // `dismiss` is a real subcommand: it must never seed a goal named after itself.
  test('/project-plan dismiss with no active plan → honest no-op, never seeded', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, opened));

    expect(fake.state()).toBeNull(); // never seeded, the goal is not overwritten with "dismiss"
    expect(out.join('\n')).toContain('No active plan to dismiss.');
    expect(out.join('\n')).not.toContain('Unknown /project-plan subcommand');
  });

  test('/project-plan dismiss refuses a mid-execution plan and points at /workstream cancel', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Running', metadata: { active: true } }));
    const planManager = { dismiss: () => ({ outcome: 'requires-cancel', blockedBy: { title: 'Running plan' } }) };

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, [], planManager));

    expect(out.join('\n')).toContain('mid-execution');
    expect(out.join('\n')).toContain('/workstream cancel');
    // Saved historical state is left untouched when execution is mid-flight.
    expect(fake.state()?.metadata?.['active']).toBe(true);
  });

  test('a multi-word goal never falls back to historical seeding without owner provenance', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['cancel', 'the', 'legacy', 'billing', 'flow'], makeContext(fake.service, out, opened));

    expect(fake.state()).toBeNull();
    expect(out.join('\n')).toContain('Original owner input is required');
    expect(opened).toEqual([]);
  });
});

for (const name of ['project-plan', 'planning']) {
  for (const args of [[], ['panel'], ['history']]) {
    test(`${name} ${args.join(' ')} separates native recovery from historical inspection without legacy writes`, async () => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      const out: string[] = []; const opened: string[] = [];
      const service = new Proxy({}, { get() { throw new Error('Opening a view must not evaluate or mutate historical planning'); } }) as ProjectPlanningService;
      await registry.execute(name, args, makeContext(service, out, opened));
      expect(opened).toEqual([args[0] === 'history' ? 'planning-modal' : 'native-work-ledger-modal']);
      expect(out.join(' ')).toContain(args[0] === 'history' ? 'historical' : 'native work');
    });
  }
}

for (const name of ['project-plan', 'planning']) {
  for (const args of [['approve'], ['answer', '1', 'Answer']]) {
    test(`${name} ${args[0]} is retired: it touches no saved record, starts nothing and names the live plan`, async () => {
      const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
      const out: string[] = []; const opened: string[] = [];
      const service = new Proxy({}, { get() { throw new Error('A retired subcommand must not reach historical planning'); } }) as ProjectPlanningService;
      const ctx = makeContext(service, out, opened);
      ctx.dispatchNativeIntakeTurn = async () => { throw new Error('No native fallback'); };
      await registry.execute(name, args, ctx);
      expect(out.join(' ')).toContain(`"/project-plan ${args[0]}" is retired`);
      expect(out.join(' ')).toContain('/workstream');
      expect(opened).toEqual([]);
    });
  }
}
