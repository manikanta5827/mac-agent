// Screenshot compaction: keeps the conversation from growing by ~1,100 tokens per image forever.
//
// Strategy (from the video): keep the newest few images, and replace older ones with a short
// text note. Cut in BLOCKS, not every step: provider caching reuses the longest unchanged
// prefix of the request, so removing one old image per step would change the prefix every
// step and throw the cache away. Cutting rarely keeps the prefix stable between cuts.
import type { ModelMessage } from 'ai';

export const REMOVED_NOTE = '[older image removed to save tokens. Call view_screenshot with its file name to see it again]';

/** Finds every image inside tool results, oldest first, as (list it sits in, position in that list). */
function findImages(messages: ModelMessage[]) {
  const found: { list: unknown[]; index: number }[] = [];
  // iterate over messages, only tool messages hold screenshots
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      // only tool results that carry content (text + images)
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

/** Returns a copy of `messages` where every image except the newest `keep` is replaced by a text note. */
export function keepNewestImages(messages: ModelMessage[], keep: number): ModelMessage[] {
  const copy = structuredClone(messages); // work on a copy, never change the SDK's own objects
  const images = findImages(copy);
  const oldImages = images.slice(0, Math.max(images.length - keep, 0));
  for (const { list, index } of oldImages) list[index] = { type: 'text', text: REMOVED_NOTE };
  return copy;
}
