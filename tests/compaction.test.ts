import { test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { countImages, keepNewestImages, REMOVED_NOTE } from '../src/compaction';

/** Builds a conversation with `n` screenshot tool results. */
function conversation(n: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < n; i++) {
    const id = `call-${i}`;
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'screenshot', input: {} }] });
    messages.push({
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: id, toolName: 'screenshot',
        output: { type: 'content', value: [
          { type: 'text', text: `shot ${i}` },
          { type: 'file', data: { type: 'data', data: `img${i}` }, mediaType: 'image/jpeg' },
        ] },
      }],
    });
  }
  return messages;
}

function imageData(messages: ModelMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const p of m.content) {
      if (p.type !== 'tool-result' || p.output.type !== 'content') continue;
      for (const v of p.output.value) {
        if (v.type === 'file' && v.data.type === 'data') out.push(String(v.data.data));
        if (v.type === 'text' && v.text === REMOVED_NOTE) out.push('removed');
      }
    }
  }
  return out;
}

test('keepNewestImages replaces only the oldest images and keeps text', () => {
  const msgs = conversation(4);
  const result = keepNewestImages(msgs, 2);
  expect(imageData(result)).toEqual(['removed', 'removed', 'img2', 'img3']);
  expect(countImages(result)).toBe(2);
  expect(countImages(msgs)).toBe(4); // original is not mutated
});

test('keepNewestImages keeps only the newest images, and earlier notes are not counted again', () => {
  const once = keepNewestImages(conversation(12), 3);
  expect(imageData(once)).toEqual([...Array(9).fill('removed'), 'img9', 'img10', 'img11']);

  // Next cut on the carried-forward messages plus 5 new images: only the newest 3 remain.
  const more = conversation(17).slice(conversation(12).length); // images 12..16
  const twice = keepNewestImages([...once, ...more], 3);
  expect(countImages(twice)).toBe(3);
  expect(imageData(twice).slice(-3)).toEqual(['img14', 'img15', 'img16']);
});
