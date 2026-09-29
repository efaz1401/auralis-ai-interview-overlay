# Auralis — Live Interview Copilot

React 19 + Vite + Express + Electron overlay. Live-interview copilot ONLY
(system-audio loopback → Deepgram STT → question detection → streamed AI answers).

## Verify

- `npm run lint` — tsc --noEmit (must pass)
- `npm run build` — vite build + esbuild server bundle (must pass)
- `npm run electron:dev` — dev server + Electron with HMR
- Smoke: `GET /api/health` → `{ ok, providers:{openai,groq,grok}, stt, auth }`

## Architecture notes

- Providers: OpenAI / Groq / xAI Grok, all via the `openai` SDK (Groq + xAI are
  OpenAI-compatible). Answer keys come from Settings (multi-key rotation on 429);
  Deepgram key is server-side only (`DEEPGRAM_API_KEY` in `.env`).
- Auth: Supabase access keys — `supabase/schema.sql` (access_keys + validate_key
  RPC, RLS denies anon), server route `/api/auth/validate`, admin CLI
  `admin/keys.mjs` (service-role; never bundled — electron-builder only ships
  dist/, electron/, package.json). Without Supabase env the server runs in
  dev-mode key acceptance (well-formed `AUR-XXXX-XXXX-XXXX` passes).
- Opacity is CSS-only: `--glass-alpha` / `--text-alpha` on `:root` (registered
  via `@property` so 120ms transitions work). Window opacity APIs are not used;
  hotkeys (Ctrl+Shift+↑/↓ glass, Ctrl+Alt+↑/↓ text) step alphas via IPC
  `overlay:alphaStep`.
- npm registry TLS fails on this machine's network — install with
  `npm install --strict-ssl=false ...` (do NOT persist to .npmrc).
