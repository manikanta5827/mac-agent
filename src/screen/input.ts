import { run, runOk } from '../core/sh';
import { checkIsInputAllowed, assertSafeKey, checkIsTextSafe } from './guard';

// list all the allowed apps
export const ALLOWED_APPS = ['Google Chrome', 'TextEdit', 'Finder', 'Calculator', 'WhatsApp', 'Docker Desktop'] as const;


// helper for opening any app in mac or any os
export async function openApp(app: string): Promise<void> {
  // check is app is in allowed list or not
  if (!(ALLOWED_APPS as readonly string[]).includes(app)) {
    throw new Error(`App "${app}" is not allowed. Allowed: ${ALLOWED_APPS.join(', ')}`);
  }
  // open the application
  await runOk(['open', '-a', app]);
}

// helper for closing/killing an app in mac
export async function killApp(app: string): Promise<void> {
  if (!(ALLOWED_APPS as readonly string[]).includes(app)) {
    throw new Error(`App "${app}" is not allowed. Allowed: ${ALLOWED_APPS.join(', ')}`);
  }
  await runOk(['killall', app]);
}

// helper for running the cliclick for clicking any buttons acrosss the mac or any os
async function cliclick(commands: string[]): Promise<void> {
  // run the cliclick with the commands passed
  const { stdout, stderr, code } = await run(['cliclick', ...commands]);

  // check if there is any permission error
  if (stderr.includes('Accessibility privileges not enabled')) {
    throw new Error('Accessibility permission missing for the app running this agent (System Settings → Privacy & Security → Accessibility)');
  }

  // check the status code is non zero
  if (code !== 0) throw new Error(`cliclick exited with code ${code}: ${stderr || stdout}`);
}

const CLICK_COMMAND = { left: 'c', double: 'dc', right: 'rc', triple: 'tc' } as const;
export type ClickKind = keyof typeof CLICK_COMMAND;

// helper for clicking the buttons on ui using cliclick helper
export async function click(kind: ClickKind, x: number, y: number): Promise<void> {
  // check if we can click on this app or not
  await checkIsInputAllowed('click');

  // click on that particular co-ordinates
  await cliclick([`m:${x},${y}`, 'w:100', `${CLICK_COMMAND[kind]}:${x},${y}`]);
}

// helper for moving mouse
export async function moveMouse(x: number, y: number): Promise<void> {
  await cliclick([`m:${x},${y}`]);
}

// helper for typing text
export async function typeText(text: string): Promise<void> {
  // chec is this text is safe or not
  checkIsTextSafe(text);

  // check is this app allowed to type or not
  await checkIsInputAllowed('typing');

  // type the text , if its new lines, then enter and type each sentense
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await pressKey('return');
    if (lines[i]) await cliclick([`t:${lines[i]}`]);
  }
}

export const NAMED_KEYS = [
  'return', 'enter', 'tab', 'space', 'esc', 'delete', 'fwd-delete',
  'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right',
  'home', 'end', 'page-up', 'page-down',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
] as const;

const SPECIAL_KEYS = new Set<string>(NAMED_KEYS);

export const MODIFIERS = ['cmd', 'shift', 'alt', 'option', 'ctrl'] as const;
export type Modifier = (typeof MODIFIERS)[number];

// helper for pressing a key using cliclick
export async function pressKey(key: string, modifiers: readonly Modifier[] = []): Promise<void> {
  // check is keys are safe to execute or not
  assertSafeKey(key, modifiers as string[]);

  // check is input typing opened app is allowed or not
  await checkIsInputAllowed('key press');

  // check if key is special
  const isSpecial = SPECIAL_KEYS.has(key);
  if (!isSpecial && [...key].length !== 1) {
    throw new Error(`Unknown key "${key}". Use a single character or one of: ${NAMED_KEYS.join(', ')}`);
  }

  // check is the key special
  const action = isSpecial ? `kp:${key}` : `t:${key}`;

  // if no modifiers then execute the command directly
  if (modifiers.length === 0) return cliclick([action]);

  // execute the modified command
  const mods = modifiers.map((m) => (m === 'option' ? 'alt' : m)).join(',');
  await cliclick([`kd:${mods}`, action, `ku:${mods}`]);
}
