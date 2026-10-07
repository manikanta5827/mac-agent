import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent } from 'ai';
import { runAgentTUI } from '@ai-sdk/tui';
import { screenTools } from './src/screen/tools';
import { browserTools } from './src/browser/tools';
import { nativeTools } from './src/native/tools';
import { log } from './src/core/log';
import { SCREEN } from './src/screen/screen';
import { compact } from './src/agent/compaction';
import { INSTRUCTIONS } from './src/agent/prompt';

export const openrouter = createOpenRouter({ apiKey: process.env.LLM_API_KEY });
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const MAX_ITERATIONS = 70;
const CUT_EVERY_STEPS = 10;
const KEEP_IMAGES = 3;

const agent = new ToolLoopAgent({
  model: openrouter('deepseek/deepseek-v4.1-flash') as LanguageModel,
  instructions: INSTRUCTIONS,
  stopWhen: stepCountIs(MAX_ITERATIONS),
  tools: { ...screenTools, ...browserTools, ...nativeTools },
  prepareStep: async ({ messages, stepNumber }) => {
    if (stepNumber === 0) {
      await log({ role: 'user', content: messages.findLast((m) => m.role === 'user')?.content });
      return {};
    }
    if (stepNumber % CUT_EVERY_STEPS !== 0) return {};

    const { messages: compacted, imagesBefore, imagesAfter } = compact(messages, KEEP_IMAGES);
    await log({ event: 'compaction', step: stepNumber, imagesBefore, imagesAfter });
    return { messages: compacted };
  },
  onStepEnd: async (step) => {
    await log({
      event: 'step',
      step: step.stepNumber,
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => call.toolName),
      usage: step.usage,
      openrouter: step.providerMetadata?.openrouter,
    });
    await log({
      step: step.stepNumber,
      role: 'assistant',
      reasoning: step.reasoningText,
      text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
    });
    for (const result of step.toolResults) {
      await log({ step: step.stepNumber, role: 'tool', tool: result.toolName, output: result.output });
    }
  },
});

await log({ event: 'start', screen: SCREEN });
await runAgentTUI({ title: 'Mac Agent', agent, tools: 'collapsed' });
