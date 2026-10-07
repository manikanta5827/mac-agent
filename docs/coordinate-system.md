# Coordinate System & Screen Scaling

This document explains how `mac-agent` handles coordinates across macOS displays, mouse inputs (`cliclick`), and vision models.

---

## 1. The Three Coordinate Spaces

On macOS (especially with Retina displays), there are three distinct coordinate spaces:

```
[ Physical Retina Pixels ]     2880 x 1800  (Hardware display panel)
           │
           │  macOS divides by 2 for Retina point scaling
           ▼
[ macOS Screen Points ]         1440 x 900   (What cliclick, AX, and macOS use)
           │
           │  Downscaled to reduce token cost & latency
           ▼
[ Screenshot Pixels (LLM) ]     1229 x 768   (What the AI model actually sees)
```

1. **Physical Retina Pixels (e.g. `2880 x 1800`)**: The raw hardware pixel density on Retina screens.
2. **macOS Screen Points (e.g. `1440 x 900`)**: The logical coordinates macOS, `cliclick`, and the Accessibility API use. Coordinate `(0, 0)` is the top-left corner of the main display.
3. **Screenshot Pixels (`IMAGE_WIDTH x 768`)**: The resized image fed to the vision LLM. Sending full-resolution images on every step would drastically increase API token costs and inference latency. The height is locked to `768px`, and the width is derived from the display's aspect ratio.

---

## 2. Deriving Image Dimensions & Scale Factors

In `src/screen/screen.ts`:

```ts
export const IMAGE_HEIGHT = 768;
export const SCREEN = await readMainDisplay(); // e.g. { width: 1440, height: 900 }
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * SCREEN.width) / SCREEN.height); // 1229

const scaleX = SCREEN.width / IMAGE_WIDTH;   // 1440 / 1229 ≈ 1.1718
const scaleY = SCREEN.height / IMAGE_HEIGHT; // 900 / 768 = 1.171875
```

Because aspect ratio is preserved, `scaleX` and `scaleY` are identical (~1.1718× on a 16:10 display).

---

## 3. Coordinate Transformations

### Model $\to$ OS: `toScreenPoint(x, y)`
Used when the LLM looks at a screenshot and decides to click or move the mouse:

```ts
export function toScreenPoint(x: number, y: number): { x: number; y: number } {
  const point = { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
  if (point.x < 0 || point.y < 0 || point.x >= SCREEN.width || point.y >= SCREEN.height) {
    throw new Error(`Point (${x}, ${y}) is outside the screenshot (0..${IMAGE_WIDTH - 1}, 0..${IMAGE_HEIGHT - 1})`);
  }
  return point;
}
```

**Walkthrough:**
- Center of LLM's image: `(614, 384)`
- Multiplied by scale: `614 * 1.1718 ≈ 720`, `384 * 1.171875 = 450`
- `cliclick` clicks at `(720, 450)` on macOS.

---

### OS $\to$ Model: `toImagePoint(x, y)`
Used when macOS tells us where an element is (e.g., via Accessibility API or window bounds) and we need to tell the model where that element sits on the screenshot image:

```ts
export function toImagePoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x / scaleX), y: Math.round(y / scaleY) };
}
```

**Walkthrough:**
- A native button is reported at screen point `(720, 450)`.
- Divided by scale: `720 / 1.1718 ≈ 614`, `450 / 1.171875 ≈ 384`.
- The model is told the button center is at screenshot pixel `(614, 384)`.

---

## 4. Key Rules

1. **Never scale coordinates anywhere else**: `src/screen/screen.ts` is the single source of truth for coordinate conversion.
2. **Never pass a Screen Point to the model**: All tool prompts, bounding box labels, and click inputs exposed to the LLM are in screenshot pixel space (`0..IMAGE_WIDTH-1`, `0..767`).
3. **Out-of-bounds protection**: `toScreenPoint` throws an error if the model attempts to click outside the visible screenshot rectangle.
