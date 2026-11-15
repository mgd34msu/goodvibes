/**
 * `engine.state.memory-usage`: which of the memories injected into a turn's
 * prompt the model's response actually used, as opposed to merely having them
 * in its prompt.
 *
 * ONE request per turn: the response is the query and every injected memory
 * is a candidate, read together, so the response text is sent once however
 * many memories were injected. Each candidate's probability is its share of
 * the answer against "none".
 *
 * Band: low stakes. The answer only feeds usage counters that order the idle
 * consolidation's decay, and decay is reversible (a lowered confidence or a
 * stale mark, never a delete).
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

const K8S_MEMORY = {
  id: 'k8s-rollout',
  content: {
    summary: 'Kubernetes rollouts use the blue-green strategy via deploy/rollout.sh',
    detail: 'Never run kubectl apply directly against production.',
  },
};

const PORT_MEMORY = { id: 'daemon-port', content: { summary: 'The daemon listens on port 3421 unless daemon.port is set in settings.json' } };

export const memoryUsage = defineRerank({
  name: 'engine.state.memory-usage',
  version: 2,
  description: 'Which injected memories a model response shows it used, as opposed to the memories merely being present in its prompt; every memory of a turn in one request.',
  accuracyFloor: 0.9,
  instructions: '`query` is a model response. Does it use the specific information in `candidate`, a memory that was in its prompt: stating it, applying it, or acting on it?',
  criteria: {
    true: 'The response contains or relies on something only this memory supplies.',
    false: 'The response does not draw on this memory; at most it touches the same general topic or shares common words with it.',
  },
  band: STAKES_BANDS.low.yesNo,
  together: true,
  fixtures: [
    {
      name: 'rollout done the remembered way',
      query: 'I ran deploy/rollout.sh, which does a blue-green switch, instead of applying the manifests with kubectl.',
      candidates: [PORT_MEMORY, K8S_MEMORY],
      expect: { top: 'k8s-rollout' },
    },
    {
      name: 'port stated from memory',
      query: 'The daemon is listening on 3421, the default, since settings.json has no daemon.port entry.',
      candidates: [K8S_MEMORY, PORT_MEMORY],
      expect: { top: 'daemon-port' },
    },
    {
      name: 'same topic, remembered procedure ignored',
      query: 'I updated the Kubernetes deployment manifest to raise the replica count to 4.',
      candidates: [K8S_MEMORY, PORT_MEMORY],
      expect: { top: 'none' },
    },
    {
      name: 'common words only',
      query: 'The settings page now lists every option unless it is hidden by the admin.',
      candidates: [PORT_MEMORY, K8S_MEMORY],
      expect: { top: 'none' },
    },
    {
      name: 'unrelated answer',
      query: 'Renamed the helper to formatDuration and updated its three call sites.',
      candidates: [K8S_MEMORY, PORT_MEMORY],
      expect: { top: 'none' },
    },
  ],
});
