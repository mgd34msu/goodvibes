/**
 * The orchestrator's busy questions all come from one phase, so a cancelled turn,
 * an open stream and a hosted turn's indicator each read as exactly what they are.
 */
import { describe, expect, test } from 'bun:test';
import { Orchestrator } from '../platform/src/platform/core/orchestrator.js';
import {
  phaseIsCompacting, phaseIsInFlight, phaseIsOccupied, phaseIsStreaming, phaseIsThinking,
  phaseWithCompacting, phaseWithStreaming, phaseWithoutThinking, type TurnPhase,
} from '../platform/src/platform/core/turn-phase.js';

describe('a cancelled turn', () => {
  test('is no longer thinking but stays in flight, and its open stream stays open until it is closed', () => {
    let phase: TurnPhase = 'thinking';
    phase = phaseWithStreaming(phase, true);
    phase = phaseWithoutThinking(phase);
    expect({ thinking: phaseIsThinking(phase), inFlight: phaseIsInFlight(phase), streaming: phaseIsStreaming(phase), occupied: phaseIsOccupied(phase) })
      .toEqual({ thinking: false, inFlight: true, streaming: true, occupied: true });
    phase = phaseWithStreaming(phase, false);
    expect({ thinking: phaseIsThinking(phase), inFlight: phaseIsInFlight(phase), streaming: phaseIsStreaming(phase) })
      .toEqual({ thinking: false, inFlight: true, streaming: false });
  });

  test('a compaction it had running keeps reading as compacting until that pass ends, and never makes the turn think again', () => {
    let phase: TurnPhase = phaseWithCompacting('thinking', true);
    phase = phaseWithoutThinking(phase);
    expect({ thinking: phaseIsThinking(phase), compacting: phaseIsCompacting(phase) }).toEqual({ thinking: false, compacting: true });
    phase = phaseWithCompacting(phase, false);
    expect({ thinking: phaseIsThinking(phase), compacting: phaseIsCompacting(phase), inFlight: phaseIsInFlight(phase) })
      .toEqual({ thinking: false, compacting: false, inFlight: true });
  });
});

describe('the orchestrator as products read it', () => {
  function bare(): Orchestrator {
    const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator;
    (orchestrator as unknown as { phase: TurnPhase }).phase = 'idle';
    return orchestrator;
  }

  test("a hosted turn's indicator reads as thinking and occupied, but owns no execution", () => {
    const orchestrator = bare();
    orchestrator.isThinking = true;
    expect({ thinking: orchestrator.isThinking, inFlight: orchestrator.isTurnInFlight, active: orchestrator.isTurnActive })
      .toEqual({ thinking: true, inFlight: false, active: true });
    orchestrator.isThinking = false;
    expect({ thinking: orchestrator.isThinking, active: orchestrator.isTurnActive }).toEqual({ thinking: false, active: false });
  });

  test('an executing turn that is cancelled stays active for the product until it settles', () => {
    const orchestrator = bare();
    (orchestrator as unknown as { phase: TurnPhase }).phase = 'thinking';
    expect(orchestrator.isTurnInFlight).toBe(true);
    orchestrator.isThinking = false;
    expect({ thinking: orchestrator.isThinking, inFlight: orchestrator.isTurnInFlight, active: orchestrator.isTurnActive })
      .toEqual({ thinking: false, inFlight: true, active: true });
  });
});
