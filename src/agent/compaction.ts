import type { ModelMessage } from 'ai';

const IMAGE_NOTE = '[older image removed to save tokens. Call view_screenshot with its file name to see it again]';
const RESULT_NOTE = '[older result removed to save tokens. Take a new one if you need it]';
const PAGED_TOOLS = ['browser_snapshot', 'app_snapshot'];

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

function dropOldResults(messages: ModelMessage[], toolName: string): void {
  const results = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'text') results.push(part);
    }
  }
  for (const part of results.slice(0, -1)) part.output = { type: 'text', value: RESULT_NOTE };
}

export function compact(messages: ModelMessage[], keepImages: number) {
  const compacted = structuredClone(messages);
  const images = findImages(compacted);
  for (const { list, index } of images.slice(0, Math.max(images.length - keepImages, 0))) {
    list[index] = { type: 'text', text: IMAGE_NOTE };
  }
  for (const toolName of PAGED_TOOLS) dropOldResults(compacted, toolName);
  return { messages: compacted, imagesBefore: images.length, imagesAfter: Math.min(images.length, keepImages) };
}
