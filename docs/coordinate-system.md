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
3. **Screenshot Pixels (`IMAGE_WIDTH x 768`)**: The resized image fed to the vision LLM. Sending full-resolution images on every step would drastically increase API token costs and inference latency.

---

## 2. Deriving Image Dimensions & Scale Factors

In `src/screen/screen.ts`:

```ts
export const IMAGE_HEIGHT = 720;
export const SCREEN = await readMainDisplay(); // e.g. { width: 1440, height: 900 }
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * SCREEN.width) / SCREEN.height);

const scaleX = SCREEN.width / IMAGE_WIDTH;
const scaleY = SCREEN.height / IMAGE_HEIGHT;
```

---

## 3. The Unified Coordinate Model: Full Screenshot vs. Zoom Crop

Instead of forcing the LLM to do arithmetic calculations in its prompt when looking at a zoom crop, the system maintains a `zoomMap`:

```ts
export type ZoomCrop = { glassX: number; glassY: number };
export const zoomMap = new Map<string, ZoomCrop>();
```

### Flow A: Normal Full-Screen Screenshot
- Captured full-screen and downscaled via `sips`.
- Scale factor to physical glass is constant: `(SCREEN.width * 2) / IMAGE_WIDTH`.
- Coordinates scale directly to screen points via `scaleX` and `scaleY`.

### Flow B: Zoom Crop (`zoom` tool)
- The model specifies a box `(x, y, width, height)` in 720p screenshot pixels.
- **Step 1: Scale coordinates to 2880 Physical Glass pixels**:
  `rawGlassX = Math.round(x * scaleToGlassX)`
  `rawGlassY = Math.round(y * scaleToGlassY)`
  `rawGlassW = Math.round(width * scaleToGlassX)`
  `rawGlassH = Math.round(height * scaleToGlassY)`
- **Step 2: Validate within 2880 Physical Glass limits**:
  Ensure `(rawGlassX, rawGlassY)` and `(rawGlassX + rawGlassW, rawGlassY + rawGlassH)` do not cross `GLASS_WIDTH` or `GLASS_HEIGHT`. If they exceed the screen, throw an error informing the LLM of the invalid bounds and how to correct them.
- **Step 3: Convert to macOS Screen Points (divide by RETINA_FACTOR = 2)**:
  `pointX = Math.round(glassX / 2)`
  `pointY = Math.round(glassY / 2)`
  `pointW = Math.round(glassW / 2)`
  `pointH = Math.round(glassH / 2)`
- macOS captures the box at **100% full, sharp native Retina detail**:
  `screencapture -R pointX,pointY,pointW,pointH <file>-zoom.jpg`
- The origin in 2880 physical glass space `(glassX, glassY)` is registered in `zoomMap.set(filename, { glassX, glassY })`.

### Flow C: Clicking (`toScreenPoint(x, y, file?)`)
When the model clicks `(x, y)` on an image:

```ts
export function toScreenPoint(x: number, y: number, file?: string): { x: number; y: number } {
  const zoomCrop = file ? zoomMap.get(file) : undefined;

  if (zoomCrop) {
    // 🔍 Zoom image: (x, y) are in 2880 physical glass space.
    // Add crop origin and divide by 2 to get macOS Screen Points for cliclick:
    const glassX = zoomCrop.glassX + x;
    const glassY = zoomCrop.glassY + y;
    return {
      x: Math.round(glassX / 2),
      y: Math.round(glassY / 2),
    };
  }

  // 🖥️ Normal screenshot: scale up directly from 720p image to screen points
  const point = { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
  if (point.x < 0 || point.y < 0 || point.x >= SCREEN.width || point.y >= SCREEN.height) {
    throw new Error(`Point (${x}, ${y}) is outside the screenshot (0..${IMAGE_WIDTH - 1}, 0..${IMAGE_HEIGHT - 1})`);
  }
  return point;
}
```

---

## 4. Key Advantages
1. **Zero mental math for the LLM:** The LLM clicks $(x, y)$ directly on whatever image it is viewing.
2. **Deterministic and stateless:** Passing `file` allows clicking inside an earlier zoom crop even if multiple zooms have occurred.
3. **Multi-monitor and Retina safe:** Correctly converts physical glass pixels to logical screen points without overflowing screen bounds.
