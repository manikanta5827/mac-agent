import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent } from 'ai';
import { tools } from './src/tools';
import { log } from './src/computer';
import { countImages, keepNewestImages } from './src/compaction';
import { runAgentTUI } from '@ai-sdk/tui';

export const openrouter = createOpenRouter({
    apiKey: process.env.LLM_API_KEY,
});
// Disable verbose AI SDK compatibility warnings in production logs
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const MAX_ITERATIONS = 70;
const CUT_EVERY_STEPS = 10; // every 10 steps, hide old images in one go
const KEEP_IMAGES = 3;

const agent = new ToolLoopAgent({
    model: openrouter("deepseek/deepseek-v4.1-flash:floor") as LanguageModel,
    instructions: [
        'You control a macOS computer through tools. You cannot see the screen unless you take a screenshot.',
        'Start every task with a screenshot.',
        'Use the actions tool for mouse and keyboard. It returns a screenshot after the actions, so you do not need a separate screenshot after it.',
        'Put several actions in one call when you do not need to look in between (e.g. click a field, type, press return).',
        'Click a text field before typing into it.',
        'Only use zoom for targets smaller than about 30 points; click large targets directly from the screenshot.',
        'Call one tool per response.',
        'Only the newest few screenshots are kept; older ones are replaced by a note. Rely on your latest screenshot. ' +
            'If you really need an older one, call view_screenshot with its file name.',
        'When the task is done, stop calling tools and reply with a short summary of what you did.',
    ].join('\n'),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    tools: tools,
    prepareStep: async ({ messages, stepNumber }) => {

        // check if it is the 10th sequence step or not
        if (stepNumber === 0 || stepNumber % CUT_EVERY_STEPS !== 0) return {};

        // count the images
        const before = countImages(messages);

        // log the action
        await log({ event: 'compaction', step: stepNumber, imagesBefore: before, imagesAfter: Math.min(before, KEEP_IMAGES) });

        // compact the images
        return { messages: keepNewestImages(messages, KEEP_IMAGES) };
    },
    // One line per model call in logs/agent.jsonl, so each run can be measured afterwards.
    onStepEnd: async (step) => {
        await log({
            event: 'step',
            step: step.stepNumber,
            finishReason: step.finishReason,
            toolCalls: step.toolCalls.map((call) => call.toolName),
            inputTokens: step.usage.inputTokens,
            cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens,
            outputTokens: step.usage.outputTokens,
            reasoningTokens: step.usage.outputTokenDetails.reasoningTokens,
            openrouter: step.providerMetadata?.openrouter?.usage,
        });
    },
});

await runAgentTUI({
    title: 'Mac Agent',
    agent,
    tools: 'collapsed',
});
