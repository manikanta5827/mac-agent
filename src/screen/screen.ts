import { runOk } from '../core/sh';

export const IMAGE_HEIGHT = 768;

function parseSize(value: string | undefined): [number, number] | null {
  const m = value?.match(/(\d+)\s*x\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

async function readMainDisplay(): Promise<{ width: number; height: number }> {
  const json = JSON.parse(await runOk(['system_profiler', 'SPDisplaysDataType', '-json']));
  const displays: any[] = (json.SPDisplaysDataType ?? []).flatMap((gpu: any) => gpu.spdisplays_ndrvs ?? []);
  const main = displays.find((d) => d.spdisplays_main === 'spdisplays_yes') ?? displays[0];
  const points = parseSize(main?._spdisplays_resolution);
  if (!points) throw new Error('Could not read display size from system_profiler');
  return { width: points[0], height: points[1] };
}

export const SCREEN = await readMainDisplay();
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * SCREEN.width) / SCREEN.height);

const scaleX = SCREEN.width / IMAGE_WIDTH;
const scaleY = SCREEN.height / IMAGE_HEIGHT;

export function toImagePoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x / scaleX), y: Math.round(y / scaleY) };
}

export function toScreenPoint(x: number, y: number): { x: number; y: number } {
  const point = { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
  if (point.x < 0 || point.y < 0 || point.x >= SCREEN.width || point.y >= SCREEN.height) {
    throw new Error(`Point (${x}, ${y}) is outside the screenshot (0..${IMAGE_WIDTH - 1}, 0..${IMAGE_HEIGHT - 1})`);
  }
  return point;
}
