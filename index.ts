import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent } from 'ai';
import { tools } from './tools';
import { runAgentTUI } from '@ai-sdk/tui';

export const openrouter = createOpenRouter({
    apiKey: process.env.LLM_API_KEY,
});

const MAX_ITERATIONS = 30;

const agent = new ToolLoopAgent({
    model: openrouter("google/gemini-3.8-flash:floor") as LanguageModel,
    instructions: [
        'You control a macOS computer through tools. You cannot see the screen unless you take a screenshot.',
        'Start every task with a screenshot. After each action, take a screenshot to check that it worked before continuing.',
        'Click a text field before typing into it.',
        'When the task is done, stop calling tools and reply with a short summary of what you did.',
    ].join('\n'),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    tools: tools,
});

await runAgentTUI({
    title: 'Mac Agent',
    agent,
    tools: 'collapsed',
});
