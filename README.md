# Auralis Overlay — AI Interview Helper (React + Electron)

Auralis is an elite AI interview-prep studio (live transcript, real-time STAR
framework tracking, and AI feedback) packaged as a **transparent, always-on-top
desktop overlay**. It floats above your other windows (Zoom, Meet, your IDE, a
doc) so you can practice or reference cues during a call.

The same codebase still runs as a normal web app in the browser; the Electron
overlay chrome only activates inside the desktop app.

## Features

- **Transparent, frameless, always-on-top window** that stays visible over other apps and full-screen spaces.
- **Stealth mode** (`setContentProtection`) — the overlay is hidden from screen recordings and screen sharing. On by default; toggle from the title bar.
- **Click-through mode** — let mouse clicks pass through to the app behind the overlay.
- **Adjustable window opacity** for true see-through overlaying.
- **Draggable title bar** and global hotkeys.
- AI intro, dynamic question generation, and STAR/answer analysis via Gemini (with graceful offline fallbacks when no API key is set).

## Global hotkeys

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + H` | Hide / show the overlay |
| `Ctrl/Cmd + Shift + Space` | Toggle click-through |
| `Ctrl/Cmd + Shift + ↑ / ↓` | Increase / decrease opacity |
| `Ctrl/Cmd + Shift + ← / →` | Nudge window left / right |

## Prerequisites

- Node.js 18+ (Node 20+ recommended)

## Setup

```bash
npm install
```

Create a `.env` file in the project root (optional — the app runs with fallbacks
without it, but AI features need a key):

```bash
cp .env.example .env
# then edit .env and set your key
GEMINI_API_KEY="your-gemini-api-key"
```

## Run the desktop overlay (development)

```bash
npm run electron:dev
```

This starts the Vite + Express dev server on `http://localhost:3000` and then
launches the Electron overlay window pointed at it (with HMR).

## Run as a plain web app

```bash
npm run dev
# open http://localhost:3000
```

## Build a distributable desktop app

```bash
npm run electron:build
```

This runs `vite build` (frontend → `dist/`), bundles the Express server to
`dist/server.cjs`, then uses `electron-builder` to produce an installer in
`release/` for your current platform (dmg / nsis / AppImage).

To run the built server as a normal web server (no Electron):

```bash
npm run build
npm start
```

## Project layout

```
electron/
  main.cjs       # Electron main process: transparent window, hotkeys, stealth, IPC
  preload.cjs    # Secure bridge exposing overlay controls to the renderer
src/
  App.tsx        # Adds the overlay shell + enables `is-electron` mode
  components/
    OverlayControls.tsx   # Draggable title bar + overlay control buttons
    Onboarding.tsx / Dashboard.tsx / Studio.tsx
  electron.d.ts  # Types for window.electronOverlay
  index.css      # App styles + overlay chrome (`.overlay-*`, `html.is-electron`)
server.ts        # Express API (Gemini) + Vite/static serving; exports startServer()
```

## How the overlay works

- `electron/main.cjs` creates a `BrowserWindow` with `transparent: true`,
  `frame: false`, and always-on-top set to the `screen-saver` level, visible on
  all workspaces including full-screen.
- `preload.cjs` exposes `window.electronOverlay` via `contextBridge`.
- On startup the renderer detects `window.electronOverlay` and adds the
  `is-electron` class to `<html>`, which switches the UI into a rounded,
  translucent floating panel with a draggable title bar.
- In production, the main process starts the bundled Express server
  (`startServer`) in-process and loads `http://localhost:3000`.
