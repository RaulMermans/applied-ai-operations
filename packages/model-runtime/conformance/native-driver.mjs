// Native AAO model substrate — adapter verification driver (Sprint 18, ADR-023).
// Test-owned. A plain host ModelAdapter (no SDK) implementing AAO's own
// adapter port: the semantic reference for model scenarios.
import { runModelScenario } from './harness.mjs';

const PROVIDER_SECRET = 'native-provider-secret sk-native-DO-NOT-LEAK';

export function createNativeModelDriver({ recorders }) {
  let adapterCalls = 0;
  return Object.freeze({
    id: 'aao.native-model',
    kind: 'model',
    support: Object.freeze({
      'model.structured-output': 'SUPPORTED',
      'model.identity-and-usage': 'SUPPORTED',
      'model.provider-error-normalized': 'SUPPORTED',
      // The AAO ModelAdapter port has no tool-call channel: a native adapter cannot express this response at all.
      'model.tool-call-fail-closed': 'NOT_APPLICABLE',
      'model.attempt-timeout': 'SUPPORTED',
    }),
    sensitiveMarkers: Object.freeze([PROVIDER_SECRET]),
    adapterCalls: () => adapterCalls,
    async executeScenario(scenario) {
      const parameters = scenario.parameters;
      const adapter = {
        async invoke() {
          adapterCalls += 1;
          if (scenario.id === 'model.provider-error-normalized') throw new Error(PROVIDER_SECRET);
          if (scenario.id === 'model.attempt-timeout') return new Promise(() => {});
          const output = parameters.outputKind === 'structured' ? parameters.structuredOutput : parameters.textOutput;
          return { status: 'succeeded', output, finishReason: 'stop', usage: parameters.usage };
        },
      };
      return runModelScenario({ scenario, adapter, runId: `run.conformance.native-model.${scenario.id}`, recorders });
    },
  });
}
