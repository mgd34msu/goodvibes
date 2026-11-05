import type { ModelCard } from '@typesafe-ai/sdk';
import { requestWithoutDeadline, toJudgmentError } from './client.ts';
import { judgmentAdapter } from './backends.ts';
import { validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';

/** The model names an endpoint accepts (GET /v1/models). */
export interface ModelCatalog {
  list(): Promise<readonly ModelCard[]>;
}

/** A catalog of the models the configured endpoint accepts, with descriptions and release dates. */
export function createModelCatalog(input: JudgmentConfig): ModelCatalog {
  const config = { ...input, endpoint: { ...input.endpoint } };
  validateJudgmentConfig(config);
  return {
    async list() {
      try {
        const adapter = judgmentAdapter(config.endpoint);
        // These run endpoints have no System One catalog route. Report the
        // explicitly configured model; an empty date means the server did not
        // report a release date, rather than inventing one for a moving alias.
        if (adapter === 'cloudflare-workers-ai' || adapter === 'laya') {
          return [{ name: config.model, description: `Configured ${adapter} decision model`, release_date: '' }];
        }
        const deadline = AbortSignal.timeout(config.timeoutMs || 30_000);
        const signal = config.signal ? AbortSignal.any([deadline, config.signal]) : deadline;
        const result = await requestWithoutDeadline(config, 'GET', '/v1/models', signal);
        if (result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
          return result.data.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') {
              throw new JudgmentError('invalid-response', 'the decision endpoint returned an invalid model catalog');
            }
            return { name: entry.id, description: 'description' in entry && typeof entry.description === 'string' ? entry.description : '',
              release_date: 'release_date' in entry && typeof entry.release_date === 'string' ? entry.release_date : '' };
          });
        }
        if (!result || typeof result !== 'object' || !('models' in result) || !Array.isArray(result.models)
          || !result.models.every(model => model && typeof model.name === 'string')) {
          throw new JudgmentError('invalid-response', 'System One returned an invalid model catalog');
        }
        return result.models as ModelCard[];
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}

