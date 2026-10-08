import type { ModelMessage } from 'ai';

const IMAGE_NOTE = '[older image removed to save tokens. Call view_screenshot with its file name to see it again]';
const RESULT_NOTE = '[older result removed to save tokens. Take a new one if you need it]';
const PAGED_TOOLS = new Set(['browser_snapshot', 'app_snapshot']);
const COLLAPSIBLE_TOOLS = new Set([
  'browser_wait', 'click', 'press_key', 'type_text', 'move_mouse', 'open_app', 'close_app', 'scroll',
]);

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
 * Prune older reasoning/thinking blocks from assistant messages older than keepTurns.
 * This preserves prompt cache for recent turns while shedding thousands of reasoning tokens.
 */
function pruneOldReasoning(messages: ModelMessage[], keepTurns: number): void {
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && msg.role === 'assistant') assistantIndices.push(i);
  }

  // Target assistant messages older than the last keepTurns
  const toPrune = assistantIndices.slice(0, Math.max(0, assistantIndices.length - keepTurns));
  for (const idx of toPrune) {
    const msg = messages[idx];
    if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((part: any) => part.type !== 'reasoning') as any;
    }
  }
}

/**
 * Drop older snapshots so only the newest snapshot of each tool is preserved.
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
 * Collapse older trivial results (e.g. "ok", "✓ Done") from actions older than keepRecent.
 */
function collapseOldTrivialResults(messages: ModelMessage[], keepRecent: number): void {
  const toolResults: any[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && COLLAPSIBLE_TOOLS.has(part.toolName)) {
        toolResults.push(part);
      }
    }
  }

  const toCollapse = toolResults.slice(0, Math.max(0, toolResults.length - keepRecent));
  for (const part of toCollapse) {
    part.output = { type: 'text', value: 'ok' };
  }
}

export function compact(messages: ModelMessage[], keepImages = 3) {
  const compacted = structuredClone(messages);

  // 1. Keep only newest `keepImages` images
  const images = findImages(compacted);
  for (const { list, index } of images.slice(0, Math.max(images.length - keepImages, 0))) {
    list[index] = { type: 'text', text: IMAGE_NOTE };
  }

  // 2. Drop older snapshots (only keep the latest 1)
  dropOldSnapshots(compacted);

  // 3. Prune reasoning blocks older than the last 7 turns
  pruneOldReasoning(compacted, 7);

  // 4. Collapse trivial tool outputs older than the last 10 actions
  collapseOldTrivialResults(compacted, 10);

  return {
    messages: compacted,
    imagesBefore: images.length,
    imagesAfter: Math.min(images.length, keepImages),
  };
}
