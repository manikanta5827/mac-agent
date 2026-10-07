# mac-agent

An agent that drives this Mac: websites through Chrome, native apps through the
Accessibility API, and anything else through the mouse and keyboard.

## Setup

```bash
bun install
bun run build:ax          # builds bin/ax-helper from native/ax-helper.swift
brew install cliclick     # mouse and keyboard
```

In `.env`: `LLM_API_KEY` (OpenRouter), and `AGENT_BROWSER_BIN` if
`agent-browser` is not on your `PATH`.

macOS asks for two permissions for the terminal app you run this from
(System Settings → Privacy & Security): **Accessibility** and
**Screen Recording**.

## Run

```bash
bun run index.ts
```

Logs go to `logs/agent.jsonl` (tool calls, tokens), `logs/conversations/` (one
file per run) and `logs/shots/` (screenshots).

## Folder structure

```
index.ts                     entry point
src/
  tools.ts                   the tool set handed to the model
  core/                      plumbing shared by every part
    sh.ts
    log.ts
    text.ts
  screen/                    the screen, the mouse and the keyboard
    screen.ts
    shot.ts
    input.ts
    guard.ts
    tools.ts
  browser/                   websites, through the agent-browser CLI
    browser.ts
    tools.ts
  native/                    native Mac apps, through the Accessibility API
    helper.ts
    native.ts
    tools.ts
  agent/                     how the agent itself is set up
    prompt.ts
    compaction.ts
  pure.test.ts               checks for the pure logic
native/ax-helper.swift       reads and presses Accessibility elements
```

Each folder holds the logic in its own files plus one `tools.ts`, which is the
only file that knows about the model. The three tool files are combined in
`src/tools.ts`.

| File | Use |
| --- | --- |
| `index.ts` | Builds the agent: model, system prompt, step limit, logging per step, context compaction every 10 steps. Starts the TUI. |
| `src/tools.ts` | Merges the screen, browser and native tool sets into one `ToolSet`. |
| `src/core/sh.ts` | Runs a command. `run` returns stdout, stderr and the exit code; `runOk` throws if the code is not 0. Every other file uses these instead of spawning its own process. |
| `src/core/text.ts` | `paginate()`: cuts long text into parts on line breaks and adds the `[part 2 of 5...]` header. Used for both browser and app snapshots. |
| `src/screen/screen.ts` | Reads the main display size once, derives the screenshot size, and maps points between screen coordinates and screenshot pixels. `toScreenPoint` also rejects points outside the screen. |
| `src/screen/shot.ts` | Takes screenshots (full screen, resized; or a region at full detail), reads and shrinks image sizes, and turns an image file into model content. |
| `src/screen/input.ts` | Mouse and keyboard: clicks, moves, typing, named keys and modifiers (`cliclick` and AppleScript key codes), plus `openApp` and the allowed-app list. |
| `src/screen/guard.ts` | Stops dangerous input: no typing into terminals, editors, AI apps or security settings; no shell commands like `sudo` or `rm -rf`; no cmd+shift+delete. |
| `src/screen/tools.ts` | Tools `screenshot`, `actions` (a batch of mouse/keyboard steps, then one screenshot), `zoom`, `open_app`, `view_screenshot`. |
| `src/browser/browser.ts` | Calls the `agent-browser` CLI in one named session, trims its accessibility snapshot down to what matters, and validates refs and arguments. |
| `src/browser/tools.ts` | Tools `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press`, `browser_scroll`, `browser_back`, `browser_wait`, `browser_screenshot`. |
| `src/native/helper.ts` | Runs `bin/ax-helper` and parses its JSON. Also `frontmostApp()`, which the guard uses. |
| `src/native/native.ts` | The native-app model: reads an app's element tree, formats it as text with `aN` refs and screenshot coordinates, brings an app to the front, draws numbered boxes on a screenshot, and presses or focuses an element by ref. |
| `src/native/tools.ts` | Tools `app_snapshot`, `app_screenshot`, `app_press`, `app_type`. |
| `src/agent/prompt.ts` | The system prompt: which tool family to use for what, and the browser and native rules. |
| `src/agent/compaction.ts` | Keeps the context small: replaces all but the newest few images, and all but the newest browser/app snapshot, with a short note. |
| `src/pure.test.ts` | `bun test`. Covers pagination, snapshot trimming, ref parsing, the guard, compaction and coordinate mapping. |
| `native/ax-helper.swift` | Small Swift tool: reads the Accessibility tree of an app, presses or focuses an element, reports the frontmost app, and draws the numbered boxes. Built to `bin/ax-helper`. |
