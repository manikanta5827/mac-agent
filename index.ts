import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { stepCountIs, type LanguageModel, ToolLoopAgent } from 'ai';
import { tools } from './src/tools';
import { log, logConversation } from './src/computer';
import { countImages, keepNewestImages, keepNewestToolResults } from './src/compaction';
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
    model: openrouter("openai/gpt-6-luna-pro") as LanguageModel,
    instructions: [
        'You control a macOS computer through tools.',
        'WEBSITES (Chrome): use the browser_* tools, never screenshot/actions/zoom. The browser tab is already open; ' +
            'use browser_open to go to a site, then browser_snapshot to read it.',
        'Browser rules (from the agent-browser guide): ' +
            '(1) Act on elements by ref from the LATEST snapshot (browser_click @e12, browser_fill @e5). Refs go stale when the page changes ' +
            '(navigation, submit, a dialog or menu opening), so snapshot again before the next ref action. "Ref not found" means: snapshot again. ' +
            '(2) After an action that changes the page, use browser_wait (text you expect, or part of the URL) instead of guessing. ' +
            '(3) Long pages come in parts: if what you need is not in part 1, read part 2. For content that loads on scroll, browser_scroll down, then snapshot again. ' +
            '(4) If a click does nothing, something may be covering it (popup, banner, menu): find its close button in the snapshot first. ' +
            '(5) If browser_fill does not put the text in a rich editor, click the editor first, then fill again. ' +
            '(6) Check the result in a new snapshot before saying a step worked. Use browser_screenshot only when you must see something visually.',
        'OTHER MAC APPS: use screenshot, actions and zoom. Start with a screenshot.',
        'Use the actions tool for mouse and keyboard. It returns a screenshot after the actions, so you do not need a separate screenshot after it.',
        'Put several actions in one call when you do not need to look in between (e.g. click a field, type, press return).',
        'Click a text field before typing into it.',
        'All x/y coordinates (clicks, move_mouse, zoom) are pixels in the latest full screenshot. Read them straight from the image; do not scale them.',
        'Only use zoom for targets smaller than about 25 pixels; click large targets directly from the screenshot.',
        'Call one tool per response.',
        'Only the newest few screenshots are kept; older ones are replaced by a note. Rely on your latest screenshot. ' +
            'If you really need an older one, call view_screenshot with its file name.',
        'When the task is done, stop calling tools and reply with a short summary of what you did.',
    ].join('\n'),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    tools: tools,
    prepareStep: async ({ messages, stepNumber }) => {
        // A new user message starts at step 0: save it to the conversation log.
        if (stepNumber === 0) {
            const userMessage = messages.findLast((m) => m.role === 'user');
            await logConversation({ role: 'user', content: userMessage?.content });
        }

        // check if it is the 10th sequence step or not
        if (stepNumber === 0 || stepNumber % CUT_EVERY_STEPS !== 0) return {};

        // count the images
        const before = countImages(messages);

        // log the action
        await log({ event: 'compaction', step: stepNumber, imagesBefore: before, imagesAfter: Math.min(before, KEEP_IMAGES) });

        // compact the images, and keep only the newest page snapshot (older ones describe old pages)
        return { messages: keepNewestToolResults(keepNewestImages(messages, KEEP_IMAGES), 'browser_snapshot', 1) };
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
            provider: step.providerMetadata?.openrouter?.provider, // which OpenRouter provider served this call
        });
        // Full conversation for debugging: what the model thought, said and did, and what the tools returned.
        // Images are not copied here; tool results only hold the file path (see logs/shots).
        await logConversation({
            step: step.stepNumber,
            role: 'assistant',
            reasoning: step.reasoningText,
            text: step.text,
            toolCalls: step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
        });
        for (const result of step.toolResults) {
            await logConversation({ step: step.stepNumber, role: 'tool', tool: result.toolName, output: result.output });
        }
    },
});

await runAgentTUI({
    title: 'Mac Agent',
    agent,
    tools: 'collapsed',
});
