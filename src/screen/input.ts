import { run, runOk } from '../core/sh';
import { assertInputAllowed, assertSafeKey, assertSafeText } from './guard';

export const ALLOWED_APPS = ['Google Chrome', 'TextEdit', 'Finder', 'Calculator', 'WhatsApp', 'Docker Desktop'] as const;

export async function openApp(app: string): Promise<void> {
  if (!(ALLOWED_APPS as readonly string[]).includes(app)) {
    throw new Error(`App "${app}" is not allowed. Allowed: ${ALLOWED_APPS.join(', ')}`);
  }
  await runOk(['open', '-a', app]);
}

async function cliclick(commands: string[]): Promise<void> {
  const { stdout, stderr, code } = await run(['cliclick', ...commands]);
  if (stderr.includes('Accessibility privileges not enabled')) {
    throw new Error('Accessibility permission missing for the app running this agent (System Settings → Privacy & Security → Accessibility)');
  }
  if (code !== 0) throw new Error(`cliclick exited with code ${code}: ${stderr || stdout}`);
}

const CLICK_COMMAND = { left: 'c', double: 'dc', right: 'rc', triple: 'tc' } as const;
export type ClickKind = keyof typeof CLICK_COMMAND;

export async function click(kind: ClickKind, x: number, y: number): Promise<void> {
  await assertInputAllowed('click');
  await cliclick([`m:${x},${y}`, 'w:100', `${CLICK_COMMAND[kind]}:${x},${y}`]);
}

export async function moveMouse(x: number, y: number): Promise<void> {
  await cliclick([`m:${x},${y}`]);
}

export async function typeText(text: string): Promise<void> {
  assertSafeText(text);
  await assertInputAllowed('typing');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await pressKey('return');
    if (lines[i]) await cliclick([`t:${lines[i]}`]);
  }
}

const KEY_CODES = {
  'return': 36, 'enter': 76, 'tab': 48, 'space': 49, 'esc': 53, 'escape': 53, 'delete': 51, 'fwd-delete': 117,
  'arrow-up': 126, 'arrow-down': 125, 'arrow-left': 123, 'arrow-right': 124,
  'home': 115, 'end': 119, 'page-up': 116, 'page-down': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
} as const;
export const NAMED_KEYS = Object.keys(KEY_CODES) as (keyof typeof KEY_CODES)[];

const MODIFIER_NAMES = {
  cmd: { cliclick: 'cmd', applescript: 'command down' },
  shift: { cliclick: 'shift', applescript: 'shift down' },
  alt: { cliclick: 'alt', applescript: 'option down' },
  ctrl: { cliclick: 'ctrl', applescript: 'control down' },
} as const;
export const MODIFIERS = Object.keys(MODIFIER_NAMES) as (keyof typeof MODIFIER_NAMES)[];

export async function pressKey(key: string, modifiers: (keyof typeof MODIFIER_NAMES)[] = []): Promise<void> {
  assertSafeKey(key, modifiers);
  await assertInputAllowed('key press');

  if (key in KEY_CODES) {
    const using = modifiers.length ? ` using {${modifiers.map((m) => MODIFIER_NAMES[m].applescript).join(', ')}}` : '';
    const code = KEY_CODES[key as keyof typeof KEY_CODES];
    await runOk(['osascript', '-e', `tell application "System Events" to key code ${code}${using}`]);
    return;
  }
  if ([...key].length !== 1) throw new Error(`Unknown key "${key}". Use a single character or one of: ${NAMED_KEYS.join(', ')}`);
  if (modifiers.length === 0) return cliclick([`t:${key}`]);

  const mods = modifiers.map((m) => MODIFIER_NAMES[m].cliclick).join(',');
  await cliclick([`kd:${mods}`, `t:${key}`, `ku:${mods}`]);
}
