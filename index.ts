import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent } from 'ai';
import { tools } from './tools';
import { log } from './computer';
import { runAgentTUI } from '@ai-sdk/tui';

export const openrouter = createOpenRouter({
    apiKey: process.env.LLM_API_KEY,
});
// Disable verbose AI SDK compatibility warnings in production logs
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const MAX_ITERATIONS = 70;

const agent = new ToolLoopAgent({
    model: openrouter("google/gemini-3.8-flash:floor") as LanguageModel,
    instructions: [
        'You control a macOS computer through tools. You cannot see the screen unless you take a screenshot.',
        'Start every task with a screenshot. After each action, take a screenshot to check that it worked before continuing.',
        'Click a text field before typing into it.',
        'When the task is done, stop calling tools and reply with a short summary of what you did.',
        'Only use zoom for targets smaller than about 30 points; click large targets directly from the screenshot.'
    ].join('\n'),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    tools: tools,
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
