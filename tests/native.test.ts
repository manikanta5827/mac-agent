import { test, expect } from 'bun:test';
import { formatSnapshot, visibleBoxes } from '../src/native';

const node = (path: string, depth: number, role: string, extra: Record<string, unknown> = {}) =>
  ({ path, depth, role, actions: [], ...extra });

test('formatSnapshot gives refs to actionable elements, keeps text, skips empty containers', () => {
  const { text, refs } = formatSnapshot({
    app: 'TextEdit',
    pid: 1,
    truncated: false,
    nodes: [
      node('0', 0, 'AXWindow', { name: 'Untitled' }),
      node('0.0', 1, 'AXGroup'), // empty layout container: left out
      node('0.0.0', 2, 'AXTextArea', { value: 'hello', focused: true, x: 100, y: 100, w: 200, h: 100 }),
      node('0.1', 1, 'AXButton', { name: 'close button', actions: ['AXPress'], x: 10, y: 10, w: 14, h: 14 }),
      node('0.2', 1, 'AXButton', { name: 'Save', enabled: false }),
      node('0.3', 1, 'AXStaticText', { value: 'Some label' }),
    ],
  });
  expect(text.split('\n')).toEqual([
    'app "TextEdit"',
    '- window "Untitled"',
    '    - textArea value="hello" (focused) [ref=a1] at 171,128',
    '  - button "close button" [ref=a2] at 15,15', // centre (17,17) points ÷ 1.17 = 14.5 → 15 screenshot px
    '  - button "Save" (disabled)',
    '  - staticText value="Some label"',
  ]);
  expect(refs.get('a1')).toMatchObject({ app: 'TextEdit', path: '0.0.0', role: 'AXTextArea', box: { x: 85, y: 85, w: 171, h: 86 } });
  expect(refs.get('a2')?.path).toBe('0.1');
  expect(refs.size).toBe(2); // disabled Save button gets no ref
});

test('formatSnapshot names untitled window buttons from their subrole', () => {
  const { text } = formatSnapshot({
    app: 'Docker Desktop', pid: 1, truncated: false,
    nodes: [
      node('0', 0, 'AXWindow', { name: 'Images' }),
      node('0.1', 1, 'AXButton', { subrole: 'AXCloseButton', actions: ['AXPress'] }),
      node('0.2', 1, 'AXButton', { actions: ['AXPress'] }),
    ],
  });
  expect(text.split('\n').slice(2)).toEqual([
    '  - button "close window" [ref=a1]',
    '  - button (no name) [ref=a2]',
  ]);
});

test('visibleBoxes keeps elements inside their window and on screen, skips scrolled-away ones', () => {
  const snapshot = {
    app: 'Finder', pid: 1, truncated: false,
    nodes: [
      node('0', 0, 'AXWindow', { name: 'Downloads', x: 100, y: 100, w: 600, h: 400 }),
      node('0.1', 1, 'AXButton', { name: 'Back', actions: ['AXPress'], x: 120, y: 110, w: 30, h: 20 }), // visible
      node('0.2', 1, 'AXButton', { name: 'Row 90', actions: ['AXPress'], x: 120, y: 2000, w: 300, h: 20 }), // scrolled away
      node('0.3', 1, 'AXButton', { name: 'No size', actions: ['AXPress'] }), // no frame
    ],
  };
  const { refs } = formatSnapshot(snapshot);
  expect(visibleBoxes(snapshot, refs).map((b) => b.target.name)).toEqual(['Back']);
});
