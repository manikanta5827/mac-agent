import { runOk } from '../core/sh';

export const IMAGE_HEIGHT = 768;

async function readMainDisplay(): Promise<{ width: number; height: number }> {
  // read the displays from the system_profiler
  const json = JSON.parse(await runOk(['system_profiler', 'SPDisplaysDataType', '-json']));
  const displays = json.SPDisplaysDataType?.flatMap((gpu: any) => gpu.spdisplays_ndrvs ?? []) ?? [];

  // get the main display
  const main = displays.find((d: any) => d.spdisplays_main === 'spdisplays_yes') ?? displays[0];

  // get the width and height
  const [width, height] = main?._spdisplays_resolution?.match(/\d+/g)?.map(Number) ?? [];

  if (!width || !height) throw new Error('Could not read main display resolution');
  return { width, height };
}

// get the screen height and width
export const SCREEN = await readMainDisplay();
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * SCREEN.width) / SCREEN.height);

// calculate the scaling factor between the actual image and sent image
const scaleX = SCREEN.width / IMAGE_WIDTH;
const scaleY = SCREEN.height / IMAGE_HEIGHT;

// here telling the llm to click on particular pixel, from accessbility api , mapping original co-ordinates address to llm understandable point co-ordinates
export function toImagePoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x / scaleX), y: Math.round(y / scaleY) };
}

// whenever llm sends a point to click, we scale it up to original version [ 789px --> 812px]
export function toScreenPoint(x: number, y: number): { x: number; y: number } {
  const point = { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
  if (point.x < 0 || point.y < 0 || point.x >= SCREEN.width || point.y >= SCREEN.height) {
    throw new Error(`Point (${x}, ${y}) is outside the screenshot (0..${IMAGE_WIDTH - 1}, 0..${IMAGE_HEIGHT - 1})`);
  }
  return point;
}
