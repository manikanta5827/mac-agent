import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent, type ModelMessage } from 'ai';
import { screenTools } from './src/screen/tools';
import { browserTools } from './src/browser/tools';
import { nativeTools } from './src/native/tools';
import { log } from './src/core/log';
import { runOk } from './src/core/sh';
import { SCREEN } from './src/screen/screen';
import { compact } from './src/agent/compaction';
import { INSTRUCTIONS } from './src/agent/prompt';

// setup the openrouter
export const openrouter = createOpenRouter({ apiKey: process.env.LLM_API_KEY });
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

// constants
const MAX_ITERATIONS = 70;
const CUT_EVERY_STEPS = 7;
const KEEP_IMAGES = 3;

// create the tool loop agent
const agent = new ToolLoopAgent({
  model: openrouter('deepseek/deepseek-v4.1-flash') as LanguageModel,
  instructions: INSTRUCTIONS,
  stopWhen: stepCountIs(MAX_ITERATIONS),
  tools: { ...screenTools, ...browserTools, ...nativeTools },
  prepareStep: async ({ messages, stepNumber }) => prepareStep({ messages, stepNumber }),
  onStepEnd: async (step) => {

    // log the usage
    await log({
      event: 'step',
      step: step.stepNumber,
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => call.toolName),
      usage: step.usage,
      openrouter: step.providerMetadata?.openrouter,
    });

    // log the steps and tool calls
    await log({
      step: step.stepNumber,
      role: 'assistant',
      reasoning: step.reasoningText,
      text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
    });
    for (const call of step.toolCalls) {
      console.log(`\x1b[36m[Step ${step.stepNumber}]\x1b[0m 🔧 ${call.toolName}`, JSON.stringify(call.input));
    }
    for (const result of step.toolResults) {
      await log({ step: step.stepNumber, role: 'tool', tool: result.toolName, output: result.output });
      const preview = typeof result.output === 'string' ? result.output : (result.output as any)?.note || 'ok';
      console.log(`\x1b[32m[Step ${step.stepNumber}]\x1b[0m ↳ ${result.toolName}:`, preview.length > 120 ? preview.slice(0, 120) + '...' : preview);
    }
  },
});

await log({ event: 'start', screen: SCREEN });

// run the agent loop
const promptFile = Bun.file('prompt.txt');
const prompt = (await promptFile.exists())
  ? (await promptFile.text()).trim()
  : process.argv.slice(2).join(' ').trim() || 'Take a screenshot of the screen';

console.log("starting the agent loop");

try {
  const { output } = await agent.generate({ prompt });
  console.log('\n--- AGENT FINISHED ---');
  console.log(output);
} catch (error) {
  const errorMessage = error instanceof Error ? Error : "something went wrong";
  console.log(`error:: ${errorMessage}`)
}

// bring terminal back to front when done
await runOk(['open', '-a', 'Terminal']);


// compact the messages on every CUT_EVERY_STEPS step
async function prepareStep({ messages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) {
  if (stepNumber === 0) {
    await log({ role: 'user', content: messages.findLast((m) => m.role === 'user')?.content });
    return {};
  }
  if (stepNumber % CUT_EVERY_STEPS !== 0) return {};

  const summaryModel = openrouter('deepseek/deepseek-v4.1-flash') as LanguageModel;
  const { messages: compacted, imagesBefore, imagesAfter, summarized } = await compact(
    messages,
    KEEP_IMAGES,
    summaryModel,
    10, // keep the last 10 turns in full fidelity
  );
  await log({ event: 'compaction', step: stepNumber, imagesBefore, imagesAfter, summarized });
  return { messages: compacted };
}