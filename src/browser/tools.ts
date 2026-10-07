import path from 'node:path';
import { z } from 'zod';
import { tool } from 'ai';
import { SHOT_DIR } from '../core/log';
import { IMAGE_WIDTH } from '../screen/screen';
import { shotToModel, shrinkToWidth } from '../screen/shot';
import { browser, safeArg, toRef, trimSnapshot } from './browser';
import { paginate } from '../core/text';
import { RAW_SNAPSHOT_CHARS, PART_CHARS } from './browser';

// input schema for the ref
const refInput = z.string().describe('Element ref from the latest browser_snapshot, e.g. "@e12"');

// get the snapshot of the current browser tab
const browser_snapshot = tool({
  description:
    'Read the current Chrome tab as a text tree of elements (with page text). Interactive elements have refs like [ref=e12]. ' +
    'Refs are only valid until the page changes; take a new snapshot after every page change. ' +
    'Long pages come in parts; the first line says "part 1 of N".',
  inputSchema: z.object({
    part: z.number().int().min(1).optional().describe('Which part of a long page, default 1 (the top)'),
  }),
  execute: async ({ part }) => {
    // take the snapshot
    const raw = await browser(['snapshot', '-c'], RAW_SNAPSHOT_CHARS);

    // remove images and unneccessary text
    const trimmed = trimSnapshot(raw.replace(/\n\[truncated:[^\]]*\]\s*$/, ''));

    // paginate the snapshot
    return paginate(trimmed, PART_CHARS, part ?? 1, 'browser_snapshot') || '(empty page)';
  },
});

// wait for the page
const browser_wait = tool({
  description:
    'Wait after an action that changes the page. Give text you expect to appear, or part of the URL you expect; ' +
    'with neither, waits until the page has finished loading. Better than guessing a time.',
  inputSchema: z.object({
    text: z.string().min(1).optional().describe('Text that should appear on the page'),
    url_contains: z.string().min(1).optional().describe('Part of the URL to wait for, e.g. "/feed"'),
  }),
  execute: async ({ text, url_contains }) => {
    const res = await browser(
      text ? ['wait', '--text', safeArg(text)]
        : url_contains ? ['wait', '--url', `**${safeArg(url_contains)}**`]
        : ['wait', '--load', 'networkidle'],
    );
    return res || 'ok';
  },
});

// open a url
const browser_open = tool({
  description: 'Open an https URL in the current Chrome tab.',
  inputSchema: z.object({ url: z.string().describe('https:// URL') }),
  execute: async ({ url }) => {
    const res = await browser(['open', url]);
    return res || 'ok';
  },
});

// click an element in that tab
const browser_click = tool({
  description: 'Click an element in Chrome by its ref.',
  inputSchema: z.object({ ref: refInput }),
  execute: async ({ ref }) => {
    const res = await browser(['click', toRef(ref)]);
    return res || 'ok';
  },
});

// fill a field
const browser_fill = tool({
  description: 'Clear a text field in Chrome and type text into it, by its ref.',
  inputSchema: z.object({ ref: refInput, text: z.string().min(1) }),
  execute: async ({ ref, text }) => {
    const res = await browser(['fill', toRef(ref), safeArg(text)]);
    return res || 'ok';
  },
});

// press a button or anything
const browser_press = tool({
  description: 'Press a key in Chrome, e.g. "Enter", "Tab", "Escape", "Control+a".',
  inputSchema: z.object({ key: z.string().min(1) }),
  execute: async ({ key }) => {
    const res = await browser(['press', safeArg(key)]);
    return res || 'ok';
  },
});

// scroll the current page
const browser_scroll = tool({
  description: 'Scroll the Chrome page up or down.',
  inputSchema: z.object({
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(100).max(3000).optional().describe('How far, default 800'),
  }),
  execute: async ({ direction, pixels }) => {
    const res = await browser(['scroll', direction, String(pixels ?? 800)]);
    return res || 'ok';
  },
});

// go back to prev page
const browser_back = tool({
  description: 'Go back one page in Chrome.',
  inputSchema: z.object({}),
  execute: async () => {
    const res = await browser(['back']);
    return res || 'ok';
  },
});

// select an option in dropdown
const browser_select = tool({
  description: 'Select an option in a <select> dropdown by its ref and the option value or text.',
  inputSchema: z.object({
    ref: refInput,
    value: z.string().min(1).describe('Value or text of the option to select'),
  }),
  execute: async ({ ref, value }) => {
    const res = await browser(['select', toRef(ref), safeArg(value)]);
    return res || 'ok';
  },
});

// get the current url
const browser_url = tool({
  description: 'Get the current Chrome tab URL. Fast and lightweight check for redirects and navigation.',
  inputSchema: z.object({}),
  execute: async () => {
    const res = await browser(['get', 'url']);
    return res || 'about:blank';
  },
});

// run multiple commands sequentially
const browser_batch = tool({
  description:
    'Run multiple browser commands sequentially in one call (e.g. filling out multiple fields of a form). ' +
    'Stops on first error. Only batch actions on elements already visible in the latest snapshot.',
  inputSchema: z.object({
    commands: z
      .array(z.string().min(1))
      .min(1)
      .describe('Commands to execute in sequence, e.g. ["fill @e1 alice", "fill @e2 secret", "click @e3"]'),
  }),
  execute: async ({ commands }) => {
    const res = await browser(['batch', '--bail', ...commands]);
    return res || 'ok';
  },
});

// close the browser
const browser_close = tool({
  description: 'Close the browser session when done with web tasks.',
  inputSchema: z.object({}),
  execute: async () => {
    const res = await browser(['close']);
    return res || 'ok';
  },
});

// take a scrrenshot
const browser_screenshot = tool({
  description:
    'Look at the Chrome tab. Every interactive element gets a red box with a number [N], which is ref @eN. ' +
    'Only use it when you need to see something visually (icons without names, layout, checking a result); prefer browser_snapshot.',
  inputSchema: z.object({}),
  execute: async () => {
    const file = path.join(SHOT_DIR, `${Date.now()}-browser.jpg`);
    const legend = (await browser([
      '--screenshot-format', 'jpeg', '--screenshot-quality', '80', 'screenshot', '--annotate', file,
    ])) || 'ok';
    const size = await shrinkToWidth(file, IMAGE_WIDTH);
    return { path: file, ...size, note: `Annotated Chrome screenshot. Label [N] = ref @eN.\n${legend}` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

// export all the tools
export const browserTools = {
  browser_snapshot, browser_open, browser_click, browser_fill, browser_select,
  browser_press, browser_scroll, browser_back, browser_wait, browser_url,
  browser_batch, browser_close, browser_screenshot,
};
