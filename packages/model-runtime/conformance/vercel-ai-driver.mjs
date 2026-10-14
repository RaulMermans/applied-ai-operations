// Vercel AI SDK model adapter — adapter verification driver (Sprint 18, ADR-023).
// Test-owned. Drives the production `createVercelAiModelAdapter` with the
// SDK's own deterministic `MockLanguageModelV3` (ai/test): no provider, no
// credentials, no network. Provider-shaped responses stay inside this
// driver; only canonical AAO evidence leaves it.
import { MockLanguageModelV3 } from 'ai/test';
import { createVercelAiModelAdapter } from '@aao/model-runtime/vercel-ai';
import { runModelScenario } from './harness.mjs';

const PROVIDER_SECRET = 'sk-live-SECRET https://api.example.com/v1?key=abc';

function response(parameters, content, finish = 'stop') {
  return {
    content,
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: parameters.usage.inputTokens, noCache: parameters.usage.inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: parameters.usage.outputTokens, text: parameters.usage.outputTokens, reasoning: 0 },
    },
    warnings: [],
  };
}

function providerModel(scenario) {
  const parameters = scenario.parameters;
  switch (scenario.id) {
    case 'model.structured-output':
      return new MockLanguageModelV3({ doGenerate: response(parameters, [{ type: 'text', text: JSON.stringify(parameters.structuredOutput) }]) });
    case 'model.identity-and-usage':
      return new MockLanguageModelV3({ doGenerate: response(parameters, [{ type: 'text', text: parameters.textOutput }]) });
    case 'model.provider-error-normalized':
      return new MockLanguageModelV3({ doGenerate: () => { throw Object.assign(new Error(PROVIDER_SECRET), { statusCode: 503, isRetryable: true }); } });
    case 'model.tool-call-fail-closed':
      return new MockLanguageModelV3({ doGenerate: response(parameters, [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: '{}' }], 'tool-calls') });
    case 'model.attempt-timeout':
      return new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) });
    default:
      throw new Error('unknown scenario');
  }
}

export function createVercelAiDriver({ recorders }) {
  const providerCalls = new Map();
  return Object.freeze({
    id: 'aao.vercel-ai-sdk',
    kind: 'model',
    support: Object.freeze({
      'model.structured-output': 'SUPPORTED',
      'model.identity-and-usage': 'SUPPORTED',
      'model.provider-error-normalized': 'SUPPORTED',
      'model.tool-call-fail-closed': 'SUPPORTED',
      'model.attempt-timeout': 'SUPPORTED',
    }),
    sensitiveMarkers: Object.freeze([PROVIDER_SECRET, 'api.example.com', 'toolName']),
    providerCalls: (scenarioId) => providerCalls.get(scenarioId),
    async executeScenario(scenario) {
      const model = providerModel(scenario);
      const evidence = await runModelScenario({ scenario, adapter: createVercelAiModelAdapter({ model }), runId: `run.conformance.vercel-ai.${scenario.id}`, recorders });
      providerCalls.set(scenario.id, model.doGenerateCalls.length);
      return evidence;
    },
  });
}
