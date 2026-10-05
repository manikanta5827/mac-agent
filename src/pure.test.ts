import { test, expect } from 'bun:test';
import { paginate } from './core/text';
import { trimSnapshot, toRef, safeArg } from './browser/browser';
import { assertSafeKey, assertSafeText } from './screen/guard';
import { compact } from './agent/compaction';
import { toImagePoint, toScreenPoint, IMAGE_WIDTH, IMAGE_HEIGHT } from './screen/screen';

test('paginate returns one part untouched, splits and labels longer text', () => {
  expect(paginate('a\nb', 100, 1, 'tool')).toBe('a\nb');
  const second = paginate('aaa\nbbb\nccc', 5, 2, 'tool');
  expect(second).toStartWith('[part 2 of 3. For the next part, call tool with part 3.]');
  expect(second).toEndWith('bbb');
  expect(paginate('aaa\nbbb\nccc', 9, 9, 'tool')).toEndWith('ccc');
});

test('trimSnapshot drops decoration and empty wrappers, keeps refs', () => {
  const tree = ['- generic', '- img', '- button "Save" [ref=e3]', '- StaticText "hello"'].join('\n');
  expect(trimSnapshot(tree)).toBe('- button "Save" [ref=e3]\n- "hello"');
});

test('refs and args are validated', () => {
  expect(toRef(' e12 ')).toBe('@e12');
  expect(() => toRef('a12')).toThrow();
  expect(safeArg('hello -rf')).toBe('hello -rf');
  expect(() => safeArg('-rf')).toThrow();
});

test('guard blocks dangerous text and trash shortcuts', () => {
  expect(() => assertSafeText('sudo rm -rf /')).toThrow();
  expect(() => assertSafeText('hello world')).not.toThrow();
  expect(() => assertSafeKey('delete', ['cmd', 'shift'])).toThrow();
  expect(() => assertSafeKey('delete', ['cmd'])).not.toThrow();
});

test('compact keeps the newest images and only the newest paged result', () => {
  const image = (name: string) => ({
    role: 'tool' as const,
    content: [{
      type: 'tool-result' as const, toolCallId: name, toolName: 'screenshot',
      output: { type: 'content' as const, value: [{ type: 'file' as const, mediaType: 'image/jpeg', data: { type: 'data' as const, data: name } }] },
    }],
  });
  const snapshot = (text: string) => ({
    role: 'tool' as const,
    content: [{
      type: 'tool-result' as const, toolCallId: text, toolName: 'app_snapshot',
      output: { type: 'text' as const, value: text },
    }],
  });

  const { messages, imagesBefore, imagesAfter } = compact(
    [image('old'), snapshot('first'), image('new'), snapshot('second')], 1,
  );
  expect([imagesBefore, imagesAfter]).toEqual([2, 1]);
  expect(JSON.stringify(messages)).toContain('older image removed');
  expect(JSON.stringify(messages)).toContain('older result removed');
  expect(JSON.stringify(messages)).toContain('"data":"new"');
  expect(JSON.stringify(messages)).toContain('"value":"second"');
});

test('screen and screenshot coordinates map both ways', () => {
  const corner = toScreenPoint(IMAGE_WIDTH - 1, IMAGE_HEIGHT - 1);
  expect(toImagePoint(corner.x, corner.y)).toEqual({ x: IMAGE_WIDTH - 1, y: IMAGE_HEIGHT - 1 });
  expect(() => toScreenPoint(IMAGE_WIDTH, 0)).toThrow();
  expect(() => toScreenPoint(-1, 0)).toThrow();
});
