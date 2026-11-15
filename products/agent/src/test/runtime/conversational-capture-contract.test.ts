/**
 * conversational-capture-contract.test.ts
 *
 * The Agent found the owner's flight itinerary in his mail, answered "plan to
 * be at the airport by 5:55 AM", and recorded nothing, the next session's
 * plans query answered "(none recorded)". In the same session it went into the
 * GoodVibes platform source under his projects directory and announced it was
 * "repairing that control flow" while he had asked it to sign in to an email
 * account.
 *
 * Both halves are pinned here: the capture contract the turn is given, and the
 * boundary stated in the policy text it is held to (the policy sentence is the
 * only statement of that boundary, so those tests are labelled prompt-contract pins). Modelled on the platform's
 * test/personal-information-capture.test.ts, same fake-port shape, same
 * insistence that each reason the capture could not have happened gets its own
 * test so none of them come back quietly.
 */
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import type { OccasionsGatewayInvoke } from '../../agent/occasions-gateway.ts';
import { executeNativeMemoryWork, nativeMemoryWorkAdmission, nativeMemoryWorkRegistry } from '../helpers/native-memory-work-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { CONVERSATIONAL_TURN_TOOLS } from '@goodvibes-jev/engine/platform/platform/personal-capture';
import {
  AGENT_CONVERSATIONAL_CAPTURE_POLICY,
  AGENT_CONVERSATIONAL_CAPTURE_TOOLS,
  missingConversationalCaptureTools,
  resolveAgentTurnCaptureAuthority,
} from '../../runtime/agent-conversational-capture.ts';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from '../../runtime/agent-operator-policy.ts';
import { registerAgentOccasionsTool } from '../../tools/agent-occasions-tool.ts';
import { registerAgentProfileTool } from '../../tools/agent-profile-tool.ts';

/** A stand-in tool that records the args it was called with and always succeeds. */
function stubTool(name: string): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    calls,
    definition: {
      name,
      description: `stub ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
    execute: async (args: unknown) => {
      calls.push(args);
      return { success: true, output: 'ok' };
    },
  };
  return tool as unknown as Tool & { calls: unknown[] };
}


// ── 1. The capture tools a conversational turn actually has ─────────────────

describe('a conversational turn can reach the capture tools', () => {
  test('the capture floor names the profile tool, from the platform contract', async () => {
    expect(CONVERSATIONAL_TURN_TOOLS).toContain('profile');
    expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain('profile');
  });

  test('it composes with the platform list rather than replacing it', async () => {
    // Every tool the platform contract names is still required here. The Agent adds
    // `occasions`, its half of the capture surface, and takes nothing away.
    for (const name of CONVERSATIONAL_TURN_TOOLS) {
      expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain(name);
    }
    expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain('occasions');
  });

  test('a registry with this build\'s capture tools registered is missing nothing', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('read'));
    registry.register(stubTool('find'));
    registry.register(stubTool('fetch'));
    registerAgentProfileTool(registry, {
      invoke: (async () => ({ ok: true, data: {}, route: 'in-process' })) as never,
    });
    registerAgentOccasionsTool(registry, {
      invoke: (async () => ({ ok: true, data: {}, route: 'in-process' })) as never,
    });

    const names = registry.list().map((tool) => tool.definition.name);
    expect(names).toContain('profile');
    expect(names).toContain('occasions');
    expect(missingConversationalCaptureTools(names)).toEqual([]);
  });

  test('a registry without the capture tool reports it rather than pretending', async () => {
    // The original defect in one assertion: the instruction says record, and
    // nothing registered can. That has to be visible, not silent.
    expect(missingConversationalCaptureTools(['read', 'find', 'fetch', 'occasions']))
      .toEqual(['profile']);
    expect(missingConversationalCaptureTools([])).toContain('profile');
  });

  test('the turn writes with the owner\'s own authority, because he is sitting at it', async () => {
    const authority = resolveAgentTurnCaptureAuthority();
    expect(authority.canCapture).toBe(true);
    expect(authority.authority).toBe('owner-direct');
    expect(authority.source).toBe('local-surface');
  });
});

// ── 2. What the turn is told ────────────────────────────────────────────────

describe('the capture contract the operator policy carries', () => {
  test('the policy that rides every turn actually carries all of it', async () => {
    // The block is only worth anything if it is in the text the turn is given.
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain(AGENT_CONVERSATIONAL_CAPTURE_POLICY);
  });
});

// ── 4. The found-itinerary flow, end to end through the tool ────────────────

describe('a found itinerary is recorded as a plan', () => {
  /** The daemon's occasions verbs, faked. Same shape as the platform test's port. */
  function fakeOccasionsGateway() {
    const confirmed: Record<string, unknown>[] = [];
    const invoke: OccasionsGatewayInvoke = async (methodId, body) => {
      if (methodId === 'occasions.plans.confirm') {
        confirmed.push({ ...body });
        return {
          ok: true,
          route: 'in-process',
          data: {
            ok: true,
            occasionId: 'trip-to-picayune',
            disclosure: 'Recorded Trip to Picayune, 2026-08-06 to 2026-08-09, in your profile under Plans.',
          },
        };
      }
      return { ok: false, route: 'unavailable', data: null, error: `unexpected verb ${methodId}` };
    };
    return { confirmed, invoke };
  }

  function occasionsTool(invoke: OccasionsGatewayInvoke) {
    const { registry, manager } = nativeMemoryWorkRegistry(makeProjectTempDir('itinerary-admission'), registry => registerAgentOccasionsTool(registry, { invoke }));
    let sequence = 0;
    return { async execute(args: Record<string, unknown>) {
      const readings = nativeMemoryWorkAdmission(); using log = new SqliteDecisionLog(':memory:');
      const previous = installJudgmentPort(withDecisionLog(readings.port, log));
      try { return await executeNativeMemoryWork(registry, manager, `itinerary-${++sequence}`, 'occasions', args); }
      finally { installJudgmentPort(previous); }
    } };
  }

  test('the trip lands, with every detail from the itinerary carried through', async () => {
    const { confirmed, invoke } = fakeOccasionsGateway();
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      destination: 'Picayune MS',
      authority: 'owner-direct',
      said: 'check your email',
    });

    expect(result.success).toBe(true);
    expect(confirmed).toHaveLength(1);
    const body = confirmed[0]!;
    expect(body.title).toBe('Trip to Picayune');
    expect(body.from).toBe('2026-08-06');
    expect(body.to).toBe('2026-08-09');
    expect(body.away).toBe(true);
    expect(body.destination).toBe('Picayune MS');
    // Model-supplied provenance cannot impersonate the owner; actual admission rides separately.
    expect(body.authority).toBe('autonomous');
    expect(body.said).toBe('');
  });

  test('the tool hands back a concrete line to say, naming the dates', async () => {
    // "Noted" is what he could not tell apart from nothing happening.
    const { invoke } = fakeOccasionsGateway();
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      authority: 'owner-direct',
      said: 'check your email',
    });
    expect(result.output).toContain('Say this in your reply');
    expect(result.output).toContain('2026-08-06');
    expect(result.output).toContain('Plans');
  });

  test('a refused capture comes back as a refusal to say out loud, not a success', async () => {
    const invoke: OccasionsGatewayInvoke = async () => ({
      ok: true,
      route: 'in-process',
      data: { ok: false, occasionId: '', disclosure: '', reason: 'Untrusted source: email.' },
    });
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      authority: 'email',
      said: 'itinerary from Southwest',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('was not recorded');
    expect(result.output).toContain('Untrusted source: email.');
    expect(result.output).toContain('Do not try again with different values');
  });
});
