# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun run build:ax          # swiftc native/*.swift -> bin/ax-helper (required; bin/ is not committed)
bun run index.ts          # start the agent TUI
bun test                  # all tests
bun test -t "paginate"    # one test by name
bunx tsc --noEmit         # typecheck
```

`bun run index.ts` opens an interactive TUI and drives the real mouse, keyboard
and Chrome, so don't start it to "check" a change — import the modules instead
(`bun -e 'const { appSnapshot } = await import("./src/native/native"); ...'`).

External tools the code shells out to: `cliclick` (brew), `agent-browser`
(`AGENT_BROWSER_BIN` or `PATH`), `bin/ax-helper`, and macOS `screencapture`,
`sips`, `osascript`, `system_profiler`. The terminal running the agent needs
Accessibility and Screen Recording permission.

`boxes-app/` is a separate Electron window full of clickable boxes, used as a
target to test the agent against (`cd boxes-app && bun run start`).

## Architecture

The model gets one flat `ToolSet` built from three families (`screen/tools`,
`browser/tools`, `native/tools`), each a folder that holds its logic plus a
single `tools.ts` — the only model-aware file in that folder. Add a tool to the
family's `tools.ts`; put the logic that does the work in a sibling file.

- `screen/` — pixels: screenshots, mouse, keyboard. The fallback family.
- `browser/` — websites, by shelling out to the `agent-browser` CLI in one named session.
- `native/` — Mac apps, through the Accessibility API via `bin/ax-helper`.

`core/` is the shared plumbing every family uses: `sh.ts` (the only place that
spawns a process), `log.ts`, `text.ts`
(`paginate()`). `agent/` holds the system prompt and context compaction.

### Two coordinate spaces

Everything the model sees is **screenshot pixels** (`IMAGE_HEIGHT` 768, width
derived from the display's aspect ratio). Everything the OS takes — `cliclick`,
`screencapture -R`, Accessibility rectangles — is **screen points**.
`src/screen/screen.ts` is the only crossing: `toScreenPoint` (model → OS, and
it throws on off-screen points) and `toImagePoint` (OS → model). Never scale
coordinates anywhere else, and never hand the model a screen point.

### Refs are stateful and go stale

`app_snapshot` / `app_screenshot` rebuild a module-level `Map` of `aN` refs in
`src/native/native.ts`; an `aN` only resolves against the newest snapshot, so
every acting tool tells the model to snapshot again. Browser `@eN` refs are
owned by `agent-browser` and behave the same way. This is deliberate, not a
cache to improve.

### The guard is a primitive, not a tool rule

`src/screen/guard.ts` is called from inside `click`, `typeText` and `pressKey`
in `src/screen/input.ts`, so any new tool that moves the mouse or types is
covered automatically. It refuses input while a terminal, editor, AI app or
security pane is frontmost, refuses shell-looking text, and refuses the
empty-Trash shortcuts. `ALLOWED_APPS` in `input.ts` is the app allowlist.
Changes here are a trust boundary — don't simplify them away.

### Context compaction

Every 10 steps `src/agent/compaction.ts` replaces all but the newest 3 images
and all but the newest `browser_snapshot` / `app_snapshot` with a short note.
That is why image tool results carry their file name: `view_screenshot` is the
escape hatch for an image that was dropped. A new tool that returns an image
should go through `shotToModel` so compaction can find it.

## Bun conventions

Bun, not Node. `bun <file>`, `bun test`, `bun install`, `bunx`. Bun loads
`.env` itself, so no `dotenv`. Prefer `Bun.file`, `Bun.spawn`, `Bun.sleep`,
`Bun.which`, `bun:sqlite`, `Bun.serve` over the Node equivalents and over
`express`/`better-sqlite3`/`ws`. Bun API docs are in
`node_modules/bun-types/docs/**.mdx`.
