import { createHash } from 'node:crypto';
import { homeGraphQualityBatteries } from './quality/batteries.js';
import { readHomeGraphQuality, type HomeGraphQualityInput, type HomeGraphQualityQuestion, type HomeGraphQualityReading } from './quality/reader.js';

type QuestionProvenance = NonNullable<HomeGraphQualityReading['provenance'][HomeGraphQualityQuestion]>;

/** One settled answer, kept with the decision that produced it. */
export interface HomeGraphQualityAnswer {
  readonly answer: boolean;
  readonly provenance: QuestionProvenance;
}

/**
 * Quality answers a sync already read, keyed by the exact content each question
 * was asked about (the device, its entities and facts) and the battery version
 * that asked it. A device whose content did not change is answered from here
 * with no model request; a changed device, or a new battery version, is asked
 * again. Kept on the installation's snapshot source between syncs; only the
 * answers the latest pass used are written back, so it never outgrows the home.
 */
export class HomeGraphQualityAnswerMemo {
  private readonly used = new Map<string, HomeGraphQualityAnswer>();
  private learned = false;

  constructor(private readonly saved: ReadonlyMap<string, HomeGraphQualityAnswer> = new Map()) {}

  static fromMetadata(value: unknown): HomeGraphQualityAnswerMemo {
    const saved = new Map<string, HomeGraphQualityAnswer>();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const answer = (entry as { answer?: unknown } | null)?.answer;
        const provenance = (entry as { provenance?: unknown } | null)?.provenance;
        if (typeof answer === 'boolean' && provenance && typeof provenance === 'object') saved.set(key, { answer, provenance: provenance as QuestionProvenance });
      }
    }
    return new HomeGraphQualityAnswerMemo(saved);
  }

  /** The answers to store, or undefined when the stored ones are still exactly right. */
  toMetadata(): Record<string, HomeGraphQualityAnswer> | undefined {
    if (!this.learned && this.used.size === this.saved.size) return undefined;
    return Object.fromEntries(this.used);
  }

  private remembered(input: HomeGraphQualityInput, question: HomeGraphQualityQuestion): HomeGraphQualityAnswer | undefined {
    const key = answerKey(input, question);
    const known = this.used.get(key) ?? this.saved.get(key);
    if (known) this.used.set(key, known);
    return known;
  }

  private remember(input: HomeGraphQualityInput, reading: HomeGraphQualityReading): void {
    if (reading.unanswered) return;
    for (const question of input.questions) {
      const answer = reading.answers[question], provenance = reading.provenance[question];
      if (answer === undefined || !provenance) continue;
      this.used.set(answerKey(input, question), { answer, provenance });
      this.learned = true;
    }
  }

  /**
   * readHomeGraphQuality for these inputs, asking the model only the questions
   * whose exact content has no remembered answer. Each returned reading carries
   * the remembered and the fresh answers together, in input order.
   */
  async read(inputs: readonly HomeGraphQualityInput[], options: Parameters<typeof readHomeGraphQuality>[1] = {}): Promise<readonly HomeGraphQualityReading[]> {
    const known = inputs.map((input) => {
      const answers: Partial<Record<HomeGraphQualityQuestion, boolean>> = {};
      const provenance: Partial<Record<HomeGraphQualityQuestion, QuestionProvenance>> = {};
      const ask: HomeGraphQualityQuestion[] = [];
      for (const question of input.questions) {
        const remembered = this.remembered(input, question);
        if (remembered) { answers[question] = remembered.answer; provenance[question] = remembered.provenance; }
        else ask.push(question);
      }
      return { answers, provenance, ask };
    });
    const fresh = await readHomeGraphQuality(inputs.map((input, index) => ({ ...input, questions: known[index]!.ask })), options);
    return fresh.map((reading, index) => {
      const input = inputs[index]!, remembered = known[index]!;
      this.remember({ ...input, questions: remembered.ask }, reading);
      // An unsettled device keeps its existing issues; remembered answers do not stand in for it.
      if (reading.unanswered) return reading;
      return { ...reading, assertCurrent: reading.assertCurrent,
        answers: { ...remembered.answers, ...reading.answers }, provenance: { ...remembered.provenance, ...reading.provenance } };
    });
  }
}

function answerKey(input: HomeGraphQualityInput, question: HomeGraphQualityQuestion): string {
  const battery = homeGraphQualityBatteries[question];
  // The reference is the device's position in this pass, not its content.
  return createHash('sha256')
    .update(JSON.stringify([question, battery.name, battery.version, input.subject, input.entities, input.facts]))
    .digest('hex');
}
