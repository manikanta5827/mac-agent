import { getScreenInfo } from './computer';

const screen = await getScreenInfo();

export const IMAGE_HEIGHT = 768;
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * screen.pointsWidth) / screen.pointsHeight);

const scaleX = screen.pointsWidth / IMAGE_WIDTH;
const scaleY = screen.pointsHeight / IMAGE_HEIGHT;

export function mapPointToScreenshot(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x / scaleX), y: Math.round(y / scaleY) };
}

export function mapScreenToPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
}
