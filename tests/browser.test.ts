import { test, expect } from 'bun:test';
import { splitIntoParts, trimSnapshot } from '../src/browser';

test('trimSnapshot drops decoration and empty wrappers, keeps refs and text', () => {
  const snapshot = [
    '- article',
    '  - generic',
    '    - paragraph',
    '      - StaticText "Ravi: AI agents are great"',
    '    - image "profile photo"',
    '    - LineBreak',
    '    - button "Comment" [ref=e2]',
    '    - image "icon" [ref=e9]',
  ].join('\n');
  expect(trimSnapshot(snapshot)).toBe([
    '- article',
    '      - "Ravi: AI agents are great"',
    '    - button "Comment" [ref=e2]',
    '    - image "icon" [ref=e9]',
  ].join('\n'));
});

test('trimSnapshot shortens very long texts', () => {
  const long = 'x'.repeat(500);
  expect(trimSnapshot(`- StaticText "${long}"`)).toBe(`- "${'x'.repeat(240)}…"`);
});

test('splitIntoParts cuts only at line ends and keeps every line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(20)}`);
  const parts = splitIntoParts(lines.join('\n'), 200);
  expect(parts.every((p) => p.length <= 200)).toBe(true);
  expect(parts.join('\n')).toBe(lines.join('\n'));
});
