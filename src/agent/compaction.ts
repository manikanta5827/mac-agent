import { generateText, type LanguageModel, type ModelMessage } from 'ai';

const IMAGE_NOTE = '[older image removed to save tokens. Call view_screenshot with its file name to see it again]';
const RESULT_NOTE = '[older result removed to save tokens. Take a new one if you need it]';
const PAGED_TOOLS = new Set(['browser_snapshot', 'app_snapshot']);

function findImages(messages: ModelMessage[]): { list: unknown[]; index: number }[] {
  const found: { list: unknown[]; index: number }[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'content') continue;
      const list = part.output.value;
      list.forEach((item, index) => {
        if (item.type === 'file' && item.mediaType.startsWith('image/')) found.push({ list, index });
      });
    }
  }
  return found;
}

/**
 * Remove heavy DOM accessibility snapshots so only the newest 1 is kept.
 */
function dropOldSnapshots(messages: ModelMessage[]): void {
  for (const toolName of PAGED_TOOLS) {
    const results: any[] = [];
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) {
        if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'text') {
          results.push(part);
        }
      }
    }
    // Leave only the latest snapshot intact
    for (const part of results.slice(0, -1)) {
      part.output = { type: 'text', value: RESULT_NOTE };
    }
  }
}

/**
 * Prune reasoning tokens from assistant messages.
 */
function pruneReasoning(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((part: any) => part.type !== 'reasoning') as any;
    }
  }
}

/**
 * Extract clean text log of actions for the summarizer.
 */
function extractActionLog(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        lines.push(`Assistant: ${msg.content.trim()}`);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text.trim()) {
            lines.push(`Assistant: ${part.text.trim()}`);
          } else if (part.type === 'tool-call') {
            lines.push(`Action: ${part.toolName}(${JSON.stringify(part.input)})`);
          }
        }
      }
    } else if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const out = typeof part.output === 'object' && part.output !== null && 'value' in part.output
            ? (part.output as any).value
            : part.output;
          const text = typeof out === 'string' ? out : JSON.stringify(out);
          if (text && !text.startsWith('[older')) {
            lines.push(`Result: ${text.slice(0, 150)}`);
          }
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * Call a fast LLM to summarize older completed actions.
 */
async function generateSummary(actionLog: string, model: LanguageModel): Promise<string> {
  const { text } = await generateText({
    model,
    system:
      'You are a concise state tracker for an autonomous OS/Browser agent. ' +
      'Given a log of previous actions, produce a compact summary of what was completed, ' +
      'what data was entered, and current progress. Keep it to 3-5 factual bullet points.',
    prompt: `Previous actions:\n${actionLog}\n\nSummary of completed progress:`,
  });
  return text.trim();
}

/**
 * Compact conversation messages:
 * 1. Prunes images older than keepImages
 * 2. Prunes old DOM snapshots
 * 3. Strips reasoning tokens from older turns
 * 4. When message history exceeds keepRecentTurns, summarizes older turns with an LLM
 *    and keeps the recent turns in full fidelity.
 */
export async function compact(
  messages: ModelMessage[],
  keepImages = 3,
  model?: LanguageModel,
  keepRecentTurns = 10,
) {
  const compacted = structuredClone(messages);

  // 1. Prune binary images older than keepImages
  const images = findImages(compacted);
  for (const { list, index } of images.slice(0, Math.max(images.length - keepImages, 0))) {
    list[index] = { type: 'text', text: IMAGE_NOTE };
  }

  // 2. Drop older DOM snapshots
  dropOldSnapshots(compacted);

  // 3. Prune reasoning tokens
  pruneReasoning(compacted);

  // 4. Summarize older turns if history is sufficiently long and model is provided
  const threshold = keepRecentTurns * 2 + 1; // +1 for initial user prompt
  const userMsg = compacted[0];
  if (!model || compacted.length <= threshold || !userMsg) {
    return {
      messages: compacted,
      imagesBefore: images.length,
      imagesAfter: Math.min(images.length, keepImages),
      summarized: false,
    };
  }

  const splitIndex = compacted.length - (keepRecentTurns * 2);
  const olderMessages = compacted.slice(1, splitIndex);
  const recentMessages = compacted.slice(splitIndex);

  const actionLog = extractActionLog(olderMessages);
  if (!actionLog.trim()) {
    return {
      messages: compacted,
      imagesBefore: images.length,
      imagesAfter: Math.min(images.length, keepImages),
      summarized: false,
    };
  }

  try {
    const summary = await generateSummary(actionLog, model);
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[Summary of earlier completed actions]:\n${summary}`,
    };
    return {
      messages: [userMsg, summaryMessage, ...recentMessages],
      imagesBefore: images.length,
      imagesAfter: Math.min(images.length, keepImages),
      summarized: true,
    };
  } catch (err) {
    console.error('Failed to generate compaction summary, keeping pruned messages:', err);
    return {
      messages: compacted,
      imagesBefore: images.length,
      imagesAfter: Math.min(images.length, keepImages),
      summarized: false,
    };
  }
}
