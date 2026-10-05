import type { ModelMessage } from 'ai';

export const REMOVED_NOTE = '[older image removed to save tokens. Call view_screenshot with its file name to see it again]';

function findImages(messages: ModelMessage[]) {
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

export function countImages(messages: ModelMessage[]): number {
  return findImages(messages).length;
}

export function keepNewestImages(messages: ModelMessage[], keep: number): ModelMessage[] {
  const copy = structuredClone(messages);
  const images = findImages(copy);
  const oldImages = images.slice(0, Math.max(images.length - keep, 0));
  for (const { list, index } of oldImages) list[index] = { type: 'text', text: REMOVED_NOTE };
  return copy;
}

export const OLD_RESULT_NOTE = '[older result removed to save tokens. Take a new one if you need it]';

export function keepNewestToolResults(messages: ModelMessage[], toolName: string, keep: number): ModelMessage[] {
  const copy = structuredClone(messages);
  const results = [];
  for (const message of copy) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'text') results.push(part);
    }
  }
  for (const part of results.slice(0, Math.max(results.length - keep, 0))) {
    part.output = { type: 'text', value: OLD_RESULT_NOTE };
  }
  return copy;
}
